/**
 * The sys_trigger evasion.
 *
 * `executeScriptAuto` catches ANY failure from `executeScript` and re-runs the same
 * script via a scheduled `sys_trigger` job. So a gate that simply throws inside
 * `executeScript` does not block anything — it converts an immediate execution into a
 * deferred one, silently, which is strictly worse than not gating at all.
 *
 * Four independent layers stop it. These tests exist so that removing ANY ONE of them
 * fails here rather than in production:
 *
 *   1. the check runs before the try/catch in executeScriptAuto
 *   2. the catch re-throws policy refusals instead of falling back
 *   3. executeScriptViaTrigger is gated on its own, and additionally needs `write`
 *   4. the HTTP gate refuses the sys_trigger POST regardless
 */

import { describe, it, expect, afterEach, jest } from "@jest/globals";
import { BackgroundScriptExecutor } from "../../../src/sn/BackgroundScriptExecutor";
import { ServiceNowInstance } from "../../../src/sn/ServiceNowInstance";
import { grantLayer, installPolicy, resetPolicyForTests } from "../../../src/policy/Policy";
import { isPolicyRefusal } from "../../../src/policy/PolicyRefusal";

const WRITING_SCRIPT = "var gr = new GlideRecord('incident'); gr.initialize(); gr.insert();";
const READING_SCRIPT = "gs.print(gs.getUser().getName());";

function executor(): BackgroundScriptExecutor {
    const instance = new ServiceNowInstance({ alias: "dev", host: "dev.service-now.com" });
    return new BackgroundScriptExecutor(instance, "global");
}

afterEach(() => {
    resetPolicyForTests();
    jest.restoreAllMocks();
});

describe("executeScript", () => {
    it("refuses a writing script when only execute is granted", async () => {
        installPolicy([grantLayer("test", ["execute"])]);
        const error = await executor().executeScript(WRITING_SCRIPT).catch((e: unknown) => e);

        expect(isPolicyRefusal(error)).toBe(true);
        expect(isPolicyRefusal(error) && error.decision.verbs).toEqual(["execute", "write"]);
    });

    it("explains what it found, so the refusal is actionable", async () => {
        installPolicy([grantLayer("test", ["execute"])]);
        const error = await executor().executeScript(WRITING_SCRIPT).catch((e: unknown) => e);
        expect(String((error as Error).message)).toMatch(/insert/);
    });

    it("refuses everything when nothing is granted", async () => {
        installPolicy([]);
        const error = await executor().executeScript(READING_SCRIPT).catch((e: unknown) => e);
        expect(isPolicyRefusal(error)).toBe(true);
    });
});

describe("executeScriptViaTrigger — gated on its own", () => {
    it("is refused directly, not only through executeScript", async () => {
        // It is public, so it is reachable without going through executeScript at all.
        installPolicy([grantLayer("test", ["execute"])]);
        const error = await executor()
            .executeScriptViaTrigger(WRITING_SCRIPT)
            .catch((e: unknown) => e);
        expect(isPolicyRefusal(error)).toBe(true);
    });

    it("needs write even for a read-only script, because scheduling IS a write", async () => {
        // The scheduled job outlives the request that created it. That is a larger
        // privilege than running the same script inline, so it is gated harder.
        installPolicy([grantLayer("test", ["execute"])]);
        const error = await executor()
            .executeScriptViaTrigger(READING_SCRIPT)
            .catch((e: unknown) => e);

        expect(isPolicyRefusal(error)).toBe(true);
        expect(String((error as Error).message)).toMatch(/sys_trigger/i);
    });
});

describe("executeScriptAuto — the evasion itself", () => {
    it("does NOT fall back to sys_trigger when the script is refused", async () => {
        installPolicy([grantLayer("test", ["execute"])]);

        const exec = executor();
        // If the fallback fires, this spy is called and the refused script runs anyway.
        const fallback = jest
            .spyOn(exec, "executeScriptViaTrigger")
            .mockResolvedValue({ success: true } as never);

        const error = await exec.executeScriptAuto(WRITING_SCRIPT).catch((e: unknown) => e);

        expect(isPolicyRefusal(error)).toBe(true);
        expect(fallback).not.toHaveBeenCalled();
    });

    it("refuses before attempting the inline path at all", async () => {
        // Layer 1: the check sits outside the try, so nothing is even tried.
        installPolicy([grantLayer("test", ["execute"])]);
        const exec = executor();
        const inline = jest.spyOn(exec, "executeScript");

        await exec.executeScriptAuto(WRITING_SCRIPT).catch(() => undefined);

        expect(inline).not.toHaveBeenCalled();
    });

    it("re-throws a refusal raised by the inline path rather than falling back", async () => {
        // Layer 2, isolated: simulate the check above being removed, and prove the
        // catch still refuses to route around a refusal.
        installPolicy([grantLayer("test", ["execute", "write"])]);
        const exec = executor();

        const refusal = Object.assign(new Error("refused"), {
            [Symbol.for("now-sdk-ext.policy-refusal")]: true,
        });
        jest.spyOn(exec, "executeScript").mockRejectedValue(refusal as never);
        const fallback = jest
            .spyOn(exec, "executeScriptViaTrigger")
            .mockResolvedValue({ success: true } as never);

        await expect(exec.executeScriptAuto(WRITING_SCRIPT)).rejects.toThrow("refused");
        expect(fallback).not.toHaveBeenCalled();
    });

    it("still falls back on an ordinary failure — the evasion fix must not break retry", async () => {
        // The fallback exists for a reason; refusing is the only thing that suppresses it.
        installPolicy([grantLayer("test", ["execute", "write"])]);
        const exec = executor();

        jest.spyOn(exec, "executeScript").mockRejectedValue(new Error("page unavailable") as never);
        const fallback = jest
            .spyOn(exec, "executeScriptViaTrigger")
            .mockResolvedValue({ success: true } as never);

        await exec.executeScriptAuto(READING_SCRIPT);
        expect(fallback).toHaveBeenCalled();
    });
});

describe("a read-only script does not require write", () => {
    it("runs under execute alone", async () => {
        // Regression: the floor rule for /sys.scripts.do (execute) was unioned with the
        // tier-3 POST default (write), so EVERY background script needed write —
        // including a pure `gs.print`. The script's computed requirement now travels
        // onto the HTTPRequest so both gates reach the same conclusion.
        installPolicy([grantLayer("test", ["execute"])]);
        const error = await executor()
            .executeScript(READING_SCRIPT)
            .catch((e: unknown) => e);

        // It will fail on the network (no live instance here), but it must NOT be
        // refused by policy — that is the distinction being pinned.
        expect(isPolicyRefusal(error)).toBe(false);
    });
});
