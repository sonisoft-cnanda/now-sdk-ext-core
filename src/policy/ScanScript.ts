import { parse } from "acorn";
import { Verb } from "./PolicyTypes";

/**
 * Looks at a server-side script and reports what it appears to do.
 *
 * ## What this is for
 *
 * A background script needs `execute` no matter what. This scan exists to decide
 * whether it ALSO needs `write` — so a genuinely read-only diagnostic script can run
 * under `execute` alone, while one containing `gr.insert()` needs both.
 *
 * ## What it cannot do — read this before trusting it
 *
 * It is unsound, and deliberately so. A server-side script can mutate through routes no
 * static analysis can follow:
 *
 *   - a Script Include: `new global.MyUtil().doThing()` — the write is in another file
 *   - `gs.eval(someString)`
 *   - `sn_ws.RESTMessageV2` calling out to anything
 *   - `workflow.startFlow()`, `gs.getUser().setPreference()`
 *   - `GlideRecord` reached through a variable this scan never resolves
 *
 * So a `write`-free result means "nothing obviously writes", NOT "this cannot write".
 * That is exactly why `execute` is still required: permitting a script at all is the
 * real decision, and this scan only narrows what else is needed.
 *
 * ## Deny-leaning by construction
 *
 * Every case it cannot resolve escalates to `write` rather than passing. A scanner that
 * defaults permissive on unfamiliar syntax manufactures confidence and is worse than no
 * scanner — it would let `gr['inse' + 'rt']()` through while looking like it checked.
 */

/** Methods that mutate records. Matched on name, on any receiver. */
const MUTATING_METHODS: ReadonlySet<string> = new Set([
    "insert",
    "update",
    "updateMultiple",
    "deleteRecord",
    "deleteMultiple",
    "insertWithReferences",
    "updateWithReferences",
    "setValue", // stages a change; harmless alone, but never appears without a write
    "setWorkflow", // disabling business rules is only ever done around a write
]);

/** Constructs whose behaviour cannot be known statically. */
const OPAQUE_CALLS: ReadonlySet<string> = new Set(["eval", "Function", "GlideEvaluator"]);

export interface ScriptScanResult {
    /** Verbs the script needs BEYOND `execute`. Today this is `["write"]` or `[]`. */
    readonly verbs: readonly Verb[];
    /** Why, in the order found. Surfaced to the user so a refusal is explainable. */
    readonly reasons: readonly string[];
    /** True when the scan could not resolve something and escalated as a result. */
    readonly escalated: boolean;
}

const NONE: ScriptScanResult = { verbs: [], reasons: [], escalated: false };

function writeResult(reasons: string[], escalated: boolean): ScriptScanResult {
    return { verbs: ["write"], reasons, escalated };
}

/**
 * Parses with the loosest grammar that works.
 *
 * Rhino — what ServiceNow runs server-side — is ES5-era, so most scripts parse at 5.
 * Newer syntax appears in scripts written against the newer engine, hence the fallback.
 * If BOTH fail the script is unreadable to us, which escalates rather than passes.
 */
function parseScript(script: string): { ast: unknown } | { parseError: string } {
    for (const ecmaVersion of [5, "latest"] as const) {
        try {
            return { ast: parse(script, { ecmaVersion, silent: true } as never) };
        } catch {
            // try the next grammar
        }
    }
    return { parseError: "could not be parsed" };
}

/** Reads a string-valued AST field, or "" when it is anything else. */
function textOf(value: unknown): string {
    return typeof value === "string" ? value : "";
}

/** Walks every node without depending on acorn-walk's visitor table. */
function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
    if (!node || typeof node !== "object") {
        return;
    }
    if (Array.isArray(node)) {
        for (const child of node) {
            walk(child, visit);
        }
        return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.type === "string") {
        visit(record);
    }
    for (const key of Object.keys(record)) {
        if (key === "type" || key === "start" || key === "end" || key === "loc") {
            continue;
        }
        walk(record[key], visit);
    }
}

/**
 * Reports the extra permission a script needs.
 *
 * Call this with the script that will ACTUALLY be sent — after any `{param}`
 * substitution. Scanning the pre-substitution text is a hole you could drive a
 * parameter value of `gr.insert()` through.
 */
export function scanScript(script: string): ScriptScanResult {
    if (typeof script !== "string" || script.trim().length === 0) {
        return NONE;
    }

    const parsed = parseScript(script);
    if ("parseError" in parsed) {
        // Unreadable, so unknowable. Escalate.
        return writeResult(["the script could not be parsed, so its effects are unknown"], true);
    }

    const reasons: string[] = [];
    let escalated = false;

    walk(parsed.ast, (node) => {
        if (node.type !== "CallExpression") {
            return;
        }
        const callee = node.callee as Record<string, unknown> | undefined;
        if (!callee) {
            return;
        }

        // eval(...) / new Function(...) — contents are opaque.
        const calleeName = textOf(callee.name);
        if (callee.type === "Identifier" && OPAQUE_CALLS.has(calleeName)) {
            reasons.push(`calls ${calleeName}(), whose contents cannot be inspected`);
            escalated = true;
            return;
        }

        if (callee.type !== "MemberExpression") {
            return;
        }

        // gr['inse' + 'rt']() — the property is computed, so the method name is not
        // knowable. This is the single most likely way to walk past a naive scan.
        if (callee.computed === true) {
            const property = callee.property as Record<string, unknown> | undefined;
            const isLiteralName = property?.type === "Literal" && typeof property.value === "string";
            if (!isLiteralName) {
                reasons.push("calls a method chosen at runtime, which cannot be resolved");
                escalated = true;
                return;
            }
            const literalName = textOf(property?.value);
            if (MUTATING_METHODS.has(literalName)) {
                reasons.push(`calls .${literalName}()`);
            }
            return;
        }

        const property = callee.property as Record<string, unknown> | undefined;
        if (property?.type === "Identifier") {
            const name = textOf(property.name);
            if (MUTATING_METHODS.has(name)) {
                reasons.push(`calls .${name}()`);
            }
            if (OPAQUE_CALLS.has(name)) {
                // gs.eval(...)
                reasons.push(`calls .${name}(), whose contents cannot be inspected`);
                escalated = true;
            }
        }
    });

    if (reasons.length === 0) {
        return NONE;
    }
    return writeResult([...new Set(reasons)], escalated);
}

/** Convenience: what a background script needs in total. */
export function requirementForScript(script: string): { verbs: Verb[]; reasons: readonly string[] } {
    const scan = scanScript(script);
    // `execute` always. Running caller-supplied code on the instance is the decision
    // being made; the scan only decides whether `write` rides along.
    return { verbs: ["execute", ...scan.verbs], reasons: scan.reasons };
}
