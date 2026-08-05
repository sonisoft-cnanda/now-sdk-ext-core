import { Decision, Verb } from "./PolicyTypes";

/**
 * Marks an error as a policy refusal.
 *
 * `Symbol.for`, not a class and not `instanceof`. This package is published, and a
 * consumer can easily end up with two copies in `node_modules` — a transitive
 * dependency on an older major, a pruned install, a bundler that duplicated it. With a
 * class, `instanceof` then returns false for an error thrown by the *other* copy, and
 * the failure is silent: `BackgroundScriptExecutor.executeScriptAuto` would stop
 * recognising a refusal and fall back to `sys_trigger`, executing the very script that
 * was just refused.
 *
 * The registry symbol is global to the process, so it identifies correctly across
 * copies. This repo already carries the dual-copy exposure with `StaleInstanceError`
 * (see `RequestHandler.toThrowable`, which goes out of its way to preserve identity);
 * this is that lesson applied rather than repeated.
 */
const POLICY_REFUSAL = Symbol.for("now-sdk-ext.policy-refusal");

export interface PolicyRefusalError extends Error {
    readonly decision: Decision;
}

/** True when `value` is a refusal thrown by ANY copy of this library. */
export function isPolicyRefusal(value: unknown): value is PolicyRefusalError {
    if (!value || typeof value !== "object") {
        return false;
    }
    return (value as Record<symbol, unknown>)[POLICY_REFUSAL] === true;
}

/**
 * Builds the error thrown when an operation is refused.
 *
 * The message states what was needed and what to do about it. It deliberately does NOT
 * name an MCP tool parameter: on that surface the caller is the model, and a refusal
 * that advertises its own escape hatch just teaches the model to set it and retry.
 * The CLI remediation names its flags, because there a human typed the command.
 */
export function policyRefusal(decision: Decision): PolicyRefusalError {
    const verbs = decision.verbs.join(" and ");
    const detail = decision.remediation
        ? `${decision.remediation}`
        : `This operation requires ${verbs} permission, which has not been granted.`;

    const error = new Error(detail) as PolicyRefusalError & Record<symbol, unknown>;
    error.name = "PolicyRefusalError";
    error[POLICY_REFUSAL] = true;
    Object.defineProperty(error, "decision", {
        value: decision,
        enumerable: true,
        writable: false,
        configurable: true,
    });
    return error;
}

/** Convenience for the common single-verb refusal. */
export function refusalFor(verb: Verb, decidingLayer: string, remediation?: string): PolicyRefusalError {
    return policyRefusal({
        allowed: false,
        verbs: [verb],
        decidingLayer,
        remediation,
    });
}
