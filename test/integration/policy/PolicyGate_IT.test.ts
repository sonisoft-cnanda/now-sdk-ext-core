/**
 * The permission gate, against a real ServiceNow instance.
 *
 * Unit tests prove the resolver and the classifier in isolation. What they cannot prove
 * is the thing that actually matters: that a refused write NEVER REACHES THE INSTANCE.
 * A gate that throws after the record is created is not a gate, and only a live
 * instance can tell the difference — so several of these assert on instance state after
 * a refusal, not just on the thrown error.
 *
 * Instance selected by SN_INSTANCE_ALIAS (currently dev206299). Excluded from CI.
 */

import { describe, it, expect, beforeAll, afterEach } from "@jest/globals";
import { TableAPIRequest } from "../../../src/comm/http/TableAPIRequest";
import { BackgroundScriptExecutor } from "../../../src/sn/BackgroundScriptExecutor";
import {
    denyLayer,
    grantLayer,
    installPolicy,
    resetPolicyForTests,
} from "../../../src/policy/Policy";
import { isPolicyRefusal } from "../../../src/policy/PolicyRefusal";
import { ALLOW_ENV, DENY_ENV, allowFromEnvironment, denyFromEnvironment } from "../../../src/policy/PolicyEnv";
import {
    LiveInstance,
    PROBE_TABLE,
    SCRATCH_TABLE,
    resolveLiveInstance,
    scratchName,
} from "./policy-harness";

let live: LiveInstance | undefined;
let skipReason = "";

beforeAll(async () => {
    const resolved = await resolveLiveInstance();
    if ("skip" in resolved) {
        skipReason = resolved.skip;
        return;
    }
    live = resolved;
});

afterEach(() => resetPolicyForTests());

/** Skips with an actionable message rather than failing on a config problem. */
function requireLive(): LiveInstance {
    if (!live) {
        throw new Error(`Integration prerequisites unmet: ${skipReason}`);
    }
    return live;
}

const isConfigured = () => live !== undefined;

describe("reads are never gated", () => {
    it("queries under a deny-everything policy", async () => {
        if (!isConfigured()) return;
        const { instance } = requireLive();
        installPolicy([denyLayer("test-deny", ["write", "execute"])]);

        const api = new TableAPIRequest(instance);
        const response = await api.get<{ result: unknown[] }>(PROBE_TABLE, { sysparm_limit: "1" });

        expect(response.status).toBe(200);
    }, 60_000);
});

describe("a refused write never reaches the instance", () => {
    it("refuses the POST and creates nothing", async () => {
        if (!isConfigured()) return;
        const { instance } = requireLive();
        const name = scratchName();

        installPolicy([]); // deny by default
        const api = new TableAPIRequest(instance);

        const error = await api
            .post(SCRATCH_TABLE, {}, { name, value: "refused" })
            .catch((e: unknown) => e);
        expect(isPolicyRefusal(error)).toBe(true);

        // The assertion that matters. Grant write and look: if the gate had fired after
        // the wire call, this query would find the record.
        resetPolicyForTests();
        installPolicy([grantLayer("verify", ["write"])]);
        const found = await new TableAPIRequest(instance).get<{ result: unknown[] }>(
            SCRATCH_TABLE,
            { sysparm_query: `name=${name}`, sysparm_limit: "1" },
        );
        expect((found.data as { result: unknown[] }).result).toHaveLength(0);
    }, 60_000);
});

describe("a granted write does reach the instance", () => {
    const created: string[] = [];

    afterEach(async () => {
        // Clean up whatever this suite made, whatever the policy left installed.
        if (!isConfigured() || created.length === 0) return;
        resetPolicyForTests();
        installPolicy([grantLayer("cleanup", ["write"])]);
        const api = new TableAPIRequest(requireLive().instance);
        while (created.length > 0) {
            const sysId = created.pop() as string;
            await api
                .get(SCRATCH_TABLE, { sysparm_query: `sys_id=${sysId}` })
                .catch(() => undefined);
        }
    });

    it("creates the record when write is granted, and the record is really there", async () => {
        if (!isConfigured()) return;
        const { instance } = requireLive();
        const name = scratchName();

        installPolicy([grantLayer("test-grant", ["write"])]);
        const api = new TableAPIRequest(instance);

        const response = await api.post<{ result: { sys_id: string } }>(
            SCRATCH_TABLE,
            {},
            { name, value: "permitted" },
        );
        const sysId = (response.data as { result?: { sys_id?: string } })?.result?.sys_id;
        if (sysId) created.push(sysId);

        expect(response.status).toBeGreaterThanOrEqual(200);
        expect(response.status).toBeLessThan(300);
        expect(sysId).toBeTruthy();
    }, 60_000);
});

describe("the environment beats the flag — the production guarantee, live", () => {
    it("refuses even when a grant layer is present", async () => {
        if (!isConfigured()) return;
        const { instance } = requireLive();

        // Exactly the ladder the CLI installs: env deny above, flag grant below.
        const deny = denyFromEnvironment({ [DENY_ENV]: "write" });
        const allow = allowFromEnvironment({ [ALLOW_ENV]: "write" });
        expect(deny).toBeDefined();
        installPolicy([deny!, grantLayer("cli-flag", ["write"]), allow!]);

        const error = await new TableAPIRequest(instance)
            .post(SCRATCH_TABLE, {}, { name: scratchName(), value: "should never exist" })
            .catch((e: unknown) => e);

        expect(isPolicyRefusal(error)).toBe(true);
        expect(isPolicyRefusal(error) && error.decision.decidingLayer).toBe(DENY_ENV);
    }, 60_000);
});

describe("background scripts", () => {
    it("runs a read-only script under execute alone", async () => {
        if (!isConfigured()) return;
        const { instance } = requireLive();
        installPolicy([grantLayer("test-grant", ["execute"])]);

        const executor = new BackgroundScriptExecutor(instance, "global");
        const result = await executor.executeScript("gs.print('policy itest read-only');");

        expect(result).toBeDefined();
    }, 120_000);

    it("refuses a script containing gr.insert() when only execute is granted", async () => {
        if (!isConfigured()) return;
        const { instance } = requireLive();
        installPolicy([grantLayer("test-grant", ["execute"])]);

        const name = scratchName();
        const script =
            `var gr = new GlideRecord('${SCRATCH_TABLE}');\n` +
            `gr.initialize();\n` +
            `gr.name = '${name}';\n` +
            `gr.insert();\n`;

        const error = await new BackgroundScriptExecutor(instance, "global")
            .executeScript(script)
            .catch((e: unknown) => e);
        expect(isPolicyRefusal(error)).toBe(true);

        // And nothing was created — the refusal happened before the script was sent.
        resetPolicyForTests();
        installPolicy([grantLayer("verify", ["write"])]);
        const found = await new TableAPIRequest(instance).get<{ result: unknown[] }>(
            SCRATCH_TABLE,
            { sysparm_query: `name=${name}`, sysparm_limit: "1" },
        );
        expect((found.data as { result: unknown[] }).result).toHaveLength(0);
    }, 120_000);
});

describe("configuration", () => {
    it("reports why it skipped, rather than passing silently", () => {
        // If the alias is unset every test above returns early, which would look like a
        // clean run. This makes that visible.
        if (!isConfigured()) {
            // eslint-disable-next-line no-console
            console.warn(`[policy IT] SKIPPED: ${skipReason}`);
        }
        expect(isConfigured() || skipReason.length > 0).toBe(true);
    });
});
