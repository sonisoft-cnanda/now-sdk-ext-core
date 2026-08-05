/**
 * Shared setup for policy integration tests against a real instance.
 *
 * The instance is chosen by `SN_INSTANCE_ALIAS`, the convention already used by the
 * other 34 integration tests here — never hardcoded. The current PDI is `dev206299`,
 * but `strongtiedev` and any future instance work by changing one variable, which is
 * the point: these assertions are about the gate, not about a particular instance.
 *
 * These do NOT run in CI. `npm run test:unit` (what CI runs) excludes `/integration/`,
 * and they need credentials CI does not have.
 */

import { getCredentials } from "@servicenow/sdk-cli/dist/auth/index.js";
import { ServiceNowInstance, ServiceNowSettingsInstance } from "../../../src/sn/ServiceNowInstance";
import { initCredentialStore } from "../../../src/credentials/ensureShim";
import { SN_INSTANCE_ALIAS } from "../../test_utils/test_config";

export { SN_INSTANCE_ALIAS };

export interface LiveInstance {
    readonly instance: ServiceNowInstance;
    readonly alias: string;
}

/**
 * Resolves the configured instance, or explains why it could not.
 *
 * Returns a reason rather than throwing so a suite can skip with a message a developer
 * can act on. A hard failure here reads as "the gate is broken" when it actually means
 * "you have not configured an alias", and that misdiagnosis costs more than the test.
 */
export async function resolveLiveInstance(): Promise<LiveInstance | { skip: string }> {
    const alias = SN_INSTANCE_ALIAS;
    if (!alias || alias.startsWith("<")) {
        return {
            skip:
                `SN_INSTANCE_ALIAS is not set (currently ${JSON.stringify(alias)}). ` +
                `Set it in .env or the environment — e.g. SN_INSTANCE_ALIAS=dev206299.`,
        };
    }

    // An integration run is non-interactive, so the OS keyring cannot be unlocked and
    // reports "no credentials" indistinguishably from having none. Opt into the
    // headless store first; it is an optional dependency, so absence is not fatal.
    initCredentialStore();

    let credential: unknown;
    try {
        credential = await getCredentials(alias);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { skip: `Could not resolve credentials for "${alias}": ${detail}` };
    }

    if (!credential) {
        return { skip: `No credentials stored for alias "${alias}". Run: nex auth list` };
    }

    const settings: ServiceNowSettingsInstance = { alias, credential };
    return { instance: new ServiceNowInstance(settings), alias };
}

/** A table every instance has, used for reads that must not depend on sample data. */
export const PROBE_TABLE = "sys_user";

/**
 * A table safe to create throwaway records in.
 *
 * `sys_user_preference` chosen deliberately: rows are per-user scratch state, creating
 * one has no workflow or notification side effects, and it is not sample data anyone
 * would miss. Every record made here is deleted in the same test.
 */
export const SCRATCH_TABLE = "sys_user_preference";

/** Marks records this suite created, so a leaked one is identifiable later. */
export function scratchName(): string {
    return `nex.policy.itest.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
}
