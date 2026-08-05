import { denyLayer, grantLayer } from "./Policy";
import { PolicyLayer, Verb } from "./PolicyTypes";

/**
 * Environment-variable policy layers.
 *
 * `NEX_POLICY_DENY` sits at the top of the ladder and cannot be granted past.
 * `NEX_POLICY_ALLOW` sits near the bottom and exists for backward compatibility, so an
 * existing CI job can restore its previous behaviour with one variable rather than
 * editing every command line.
 *
 * Named `NEX_POLICY_*` rather than `NEX_ALLOW_WRITE` because `write` and `execute`
 * collide with ServiceNow ACL vocabulary, and a reader should not have to work out
 * whether this is about ACLs.
 */

export const DENY_ENV = "NEX_POLICY_DENY";
export const ALLOW_ENV = "NEX_POLICY_ALLOW";

const ALL = "all";
const VALID: readonly Verb[] = ["write", "execute"];

export interface ParsedVerbs {
    readonly verbs: readonly Verb[];
    /** Tokens that were not recognised. Non-empty means the value was malformed. */
    readonly unknown: readonly string[];
}

/**
 * Parses a comma-separated verb list.
 *
 * `all` expands to every verb. Unrecognised tokens are REPORTED rather than dropped, so
 * the caller can fail closed — see `denyFromEnvironment`.
 */
export function parseVerbList(raw: string | undefined): ParsedVerbs {
    if (raw === undefined) {
        return { verbs: [], unknown: [] };
    }

    const tokens = raw
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0);

    if (tokens.includes(ALL)) {
        return { verbs: [...VALID], unknown: [] };
    }

    const verbs: Verb[] = [];
    const unknown: string[] = [];
    for (const token of tokens) {
        if ((VALID as readonly string[]).includes(token)) {
            verbs.push(token as Verb);
        } else {
            unknown.push(token);
        }
    }
    return { verbs, unknown };
}

/**
 * The deny layer, built from `NEX_POLICY_DENY`.
 *
 * FAILS CLOSED on a malformed value. `NEX_POLICY_DENY=wrtie` denies everything and
 * warns, rather than silently denying nothing — a typo in the variable that is supposed
 * to protect production must not quietly disable the protection. That is the whole
 * reason this function reports `unknown` instead of filtering it away.
 *
 * Returns `undefined` when the variable is unset, so the layer is simply absent.
 */
export function denyFromEnvironment(
    env: NodeJS.ProcessEnv = process.env,
    warn: (message: string) => void = () => undefined,
): PolicyLayer | undefined {
    const raw = env[DENY_ENV];
    if (raw === undefined || raw.trim().length === 0) {
        return undefined;
    }

    const { verbs, unknown } = parseVerbList(raw);
    if (unknown.length > 0) {
        warn(
            `${DENY_ENV} contains unrecognised value(s): ${unknown.join(", ")}. ` +
                `Denying all changes. Valid values are: ${VALID.join(", ")}, all.`,
        );
        return denyLayer(`${DENY_ENV} (malformed, failing closed)`, VALID);
    }

    return denyLayer(DENY_ENV, verbs);
}

/**
 * The backward-compatibility grant layer, built from `NEX_POLICY_ALLOW`.
 *
 * Unrecognised tokens here are dropped with a warning rather than failing closed: this
 * variable only ever *grants*, so a typo already fails safe — the operation is refused
 * and the operator sees why.
 */
export function allowFromEnvironment(
    env: NodeJS.ProcessEnv = process.env,
    warn: (message: string) => void = () => undefined,
): PolicyLayer | undefined {
    const raw = env[ALLOW_ENV];
    if (raw === undefined || raw.trim().length === 0) {
        return undefined;
    }

    const { verbs, unknown } = parseVerbList(raw);
    if (unknown.length > 0) {
        warn(
            `${ALLOW_ENV} contains unrecognised value(s): ${unknown.join(", ")}, ignored. ` +
                `Valid values are: ${VALID.join(", ")}, all.`,
        );
    }
    if (verbs.length === 0) {
        return undefined;
    }

    return grantLayer(ALLOW_ENV, verbs);
}
