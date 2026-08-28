/** Live, credential-store-backed verification for cluster transaction operations. */
import { afterEach, beforeAll, describe, expect, it } from "@jest/globals";
import { grantLayer, installPolicy, resetPolicyForTests } from "../../../../src/policy/Policy";
import { ClusterTransactionManager } from "../../../../src/sn/transaction/ClusterTransactionManager";
import { LiveInstance, resolveLiveInstance } from "../../policy/policy-harness";

const SYS_ID = /^[0-9a-f]{32}$/i;
const KILL_SYS_ID = process.env.NEX_LIVE_KILL_TRANSACTION_SYS_ID?.trim();
const KILL_CONFIRMATION = process.env.NEX_LIVE_KILL_CONFIRM?.trim();
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

function requireLive(): LiveInstance {
    if (!live) throw new Error(`Integration prerequisites unmet: ${skipReason}`);
    return live;
}

const isConfigured = (): boolean => live !== undefined;

describe("ClusterTransactionManager live", () => {
    it("retrieves transactions through sn-credstore under a deny-by-default policy", async () => {
        if (!isConfigured()) return;
        installPolicy([]);
        const records = await new ClusterTransactionManager(requireLive().instance).getTransactions({
            pollIntervalMs: 500,
            timeoutMs: 120_000,
            limit: 1000,
        });
        expect(Array.isArray(records)).toBe(true);
        for (const record of records) {
            expect(record.sys_id).toMatch(SYS_ID);
            expect(typeof record.node_id).toBe("string");
            expect(typeof record.url).toBe("string");
            expect(typeof record.state).toBe("string");
        }
    }, 150_000);

    it("kills only the explicitly confirmed safe transaction and observes later removal", async () => {
        if (!isConfigured() || !KILL_SYS_ID) return;
        const { alias, instance } = requireLive();
        if (!SYS_ID.test(KILL_SYS_ID) || KILL_CONFIRMATION !== `${alias}:${KILL_SYS_ID}`) {
            throw new Error(
                "Refusing live termination: set NEX_LIVE_KILL_CONFIRM to <alias>:<sys_id> " +
                "for the deliberately created safe transaction",
            );
        }

        installPolicy([grantLayer("cluster-transaction-live-test", ["write"])]);
        const manager = new ClusterTransactionManager(instance);
        const before = await manager.getTransactions({ pollIntervalMs: 500, timeoutMs: 120_000 });
        expect(before.some((record) => record.sys_id === KILL_SYS_ID)).toBe(true);

        expect(await manager.killTransaction(KILL_SYS_ID)).toEqual({
            accepted: true,
            sysId: KILL_SYS_ID,
        });

        const deadline = Date.now() + 60_000;
        let stillPresent = true;
        while (stillPresent && Date.now() < deadline) {
            const after = await manager.getTransactions({ pollIntervalMs: 500, timeoutMs: 120_000 });
            stillPresent = after.some((record) => record.sys_id === KILL_SYS_ID);
        }
        expect(stillPresent).toBe(false);
    }, 240_000);

    it("reports missing live prerequisites instead of silently appearing configured", () => {
        if (!isConfigured()) {
            // eslint-disable-next-line no-console
            console.warn(`[cluster transaction IT] SKIPPED: ${skipReason}`);
        }
        expect(isConfigured() || skipReason.length > 0).toBe(true);
    });
});
