/**
 * Vocabulary for gating instance mutations.
 *
 * This is a GUARDRAIL, not a security boundary. Anything holding the credential can
 * reach the instance directly — by importing this library and calling the SDK, or with
 * curl. What it buys is that *inadvertent* mutation stops being the default when an AI
 * agent is driving, and that an operator can hard-deny from an environment the agent
 * cannot write to. Do not describe it as anything stronger.
 */

/**
 * What an operation does. Two verbs, deliberately.
 *
 * CRUD was considered and rejected: `nex exec`, ATF runs and flow execution all mutate
 * without being create, edit or delete, so a CRUD vocabulary leaves them homeless.
 */
export type Verb = "write" | "execute";

/**
 * WHERE the effect lands. Not every write is a write to the instance.
 *
 * `pull_script` overwrites a local file, `scope set` changes session state, and the
 * `auth` commands write the credential store. Gating those as instance writes would
 * produce false refusals on operations that never touch ServiceNow data, so the target
 * is carried alongside the verb rather than inventing more verbs.
 *
 * Only `instance` is gated today; the rest exist so the distinction is recorded at the
 * call site rather than rediscovered later.
 */
export type Target = "instance" | "local" | "session";

/** What an operation needs before it may proceed. */
export interface Requirement {
    readonly verbs: readonly Verb[];
    readonly target: Target;
}

/** A requirement that needs no permission at all. */
export const READ_ONLY: Requirement = Object.freeze({
    verbs: Object.freeze([]) as readonly Verb[],
    target: "instance",
});

/**
 * A layer's answer.
 *
 * `abstain` is distinct from `deny` on purpose — it means "I have no opinion", so a
 * lower-priority layer still gets to speak. Collapsing the two would make an unset
 * environment variable behave like an explicit denial.
 */
export type LayerAnswer = "grant" | "deny" | "abstain";

/** One rung of the precedence ladder. */
export interface PolicyLayer {
    /** Appears in refusals and the audit log, so make it recognisable to an operator. */
    readonly name: string;
    answer(verb: Verb): LayerAnswer;
}

/**
 * The result of a check.
 *
 * An object rather than a boolean so the deciding layer can be reported — "why was this
 * refused" is otherwise unanswerable — and so a future `ApprovalToken` (NEX-76) can be
 * added as a grant layer without changing this signature.
 */
export interface Decision {
    readonly allowed: boolean;
    /** The verbs actually required. Empty means the operation needed no permission. */
    readonly verbs: readonly Verb[];
    /** Name of the layer that decided. `"default"` when nothing granted. */
    readonly decidingLayer: string;
    /** Present only when refused. Written for a human, never naming an MCP parameter. */
    readonly remediation?: string;
}
