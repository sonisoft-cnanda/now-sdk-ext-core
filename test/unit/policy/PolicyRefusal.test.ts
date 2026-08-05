/**
 * Refusal identity across duplicate copies of this package.
 *
 * This matters more than it looks. `BackgroundScriptExecutor.executeScriptAuto` catches
 * failures from `executeScript` and falls back to running the same script via
 * `sys_trigger`. It must re-throw policy refusals rather than fall back — and it decides
 * that by asking `isPolicyRefusal`. If that predicate returns false for an error thrown
 * by a *second copy* of this library in the consumer's node_modules, the refusal is
 * swallowed and the refused script executes anyway, on a schedule, silently.
 */

import { describe, it, expect } from "@jest/globals";
import { isPolicyRefusal, policyRefusal, refusalFor } from "../../../src/policy/PolicyRefusal";

describe("policyRefusal", () => {
    it("is a real Error, so stacks and normal handling still work", () => {
        const error = refusalFor("write", "default");
        expect(error).toBeInstanceOf(Error);
        expect(typeof error.stack).toBe("string");
        expect(error.name).toBe("PolicyRefusalError");
    });

    it("carries the decision for callers that want the deciding layer", () => {
        const error = refusalFor("execute", "NEX_POLICY_DENY");
        expect(error.decision.decidingLayer).toBe("NEX_POLICY_DENY");
        expect(error.decision.verbs).toEqual(["execute"]);
        expect(error.decision.allowed).toBe(false);
    });

    it("uses the supplied remediation as the message when given", () => {
        const error = refusalFor("write", "default", "Pass --allow-write to permit this.");
        expect(error.message).toBe("Pass --allow-write to permit this.");
    });

    it("falls back to a message naming the verb when no remediation is supplied", () => {
        expect(refusalFor("write", "default").message).toMatch(/requires write/i);
    });
});

describe("isPolicyRefusal", () => {
    it("recognises a refusal from this copy", () => {
        expect(isPolicyRefusal(refusalFor("write", "default"))).toBe(true);
    });

    it("recognises a refusal thrown by a DIFFERENT copy of the library", () => {
        // Simulates the dual-install case: another copy branded its error using the
        // same registry symbol. `instanceof` against our class would be false here;
        // Symbol.for is process-global, so this still identifies correctly.
        const fromOtherCopy = new Error("refused by the other copy") as Error &
            Record<symbol, unknown>;
        fromOtherCopy[Symbol.for("now-sdk-ext.policy-refusal")] = true;

        expect(isPolicyRefusal(fromOtherCopy)).toBe(true);
    });

    it("would NOT be identified by an instanceof-style check across copies", () => {
        // Pins the reason for the symbol. A separately-declared error class is a
        // different constructor, so a class-based predicate fails exactly here.
        class OtherCopyPolicyRefusalError extends Error {}
        const fromOtherCopy = new OtherCopyPolicyRefusalError("refused") as Error &
            Record<symbol, unknown>;

        expect(fromOtherCopy instanceof Error).toBe(true);
        expect(isPolicyRefusal(fromOtherCopy)).toBe(false); // not branded
        fromOtherCopy[Symbol.for("now-sdk-ext.policy-refusal")] = true;
        expect(isPolicyRefusal(fromOtherCopy)).toBe(true); // branded -> recognised
    });

    it.each([undefined, null, "refused", 42, {}, new Error("ordinary failure")])(
        "returns false for %p",
        (value) => {
            expect(isPolicyRefusal(value)).toBe(false);
        },
    );

    it("is not fooled by a plain object claiming the property by name", () => {
        // The brand is a symbol, not a string key, so JSON round-tripping cannot forge it.
        const parsed = JSON.parse('{"Symbol(now-sdk-ext.policy-refusal)":true}') as unknown;
        expect(isPolicyRefusal(parsed)).toBe(false);
    });
});

describe("policyRefusal decision passthrough", () => {
    it("preserves a multi-verb decision", () => {
        const error = policyRefusal({
            allowed: false,
            verbs: ["execute", "write"],
            decidingLayer: "default",
        });
        expect(error.decision.verbs).toEqual(["execute", "write"]);
    });
});
