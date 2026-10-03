/**
 * Thrown when a script cannot be run in the scope it was asked to run in.
 *
 * Scripts - Background (`/sys.scripts.do`) only runs in Global or in an application
 * developed on the instance (`sys_app`). Installed store/repo applications
 * (`sys_store_app`) are not eligible, and neither is a name that matches no application.
 *
 * `message` is deliberately self-contained — what went wrong AND what to do about it —
 * because the MCP server and the CLI's default error path print only the message. The
 * same advice is also carried separately in `remediation`, for consumers that render
 * suggestions. Same `code` / `remediation` / `cause` shape as {@link StaleInstanceError},
 * for the same reason: a consumer can recognise it by `code` without importing the class.
 */
export class ScriptScopeError extends Error {

    /** Compare against an error you were handed: `err?.code === ScriptScopeError.code`. */
    public static readonly code: string = "NEX_SCRIPT_SCOPE_UNAVAILABLE";

    /** The code as carried BY an instance. Always equal to the static above. */
    public readonly code: string;

    public readonly remediation: string;

    /** The scope exactly as the caller passed it. */
    public readonly scope: string;

    public readonly reason: ScriptScopeFailureReason;

    /**
     * What the scope name DID match, when it exists but cannot be used — e.g. an
     * installed store application. Absent when nothing matched.
     */
    public readonly foundAs?: ScriptScopeMatch;

    public constructor(
        details: {
            scope: string;
            reason: ScriptScopeFailureReason;
            problem: string;
            remediation: string;
            foundAs?: ScriptScopeMatch;
        },
        options: { cause?: unknown } = {}
    ) {
        super(`${details.problem} ${details.remediation}`, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = new.target.name;
        this.code = ScriptScopeError.code;
        this.remediation = details.remediation;
        this.scope = details.scope;
        this.reason = details.reason;
        if (details.foundAs) {
            this.foundAs = details.foundAs;
        }
    }

    public toJSON(): {
        name: string;
        message: string;
        code: string;
        remediation: string;
        scope: string;
        reason: ScriptScopeFailureReason;
        foundAs?: ScriptScopeMatch;
    } {
        return {
            name: this.name,
            message: this.message,
            code: this.code,
            remediation: this.remediation,
            scope: this.scope,
            reason: this.reason,
            ...(this.foundAs ? { foundAs: this.foundAs } : {}),
        };
    }

    public toString(): string {
        return `${this.name}: ${this.message}`;
    }
}

/**
 * - `INVALID_SCOPE_NAME`: not a plausible scope name; refused before any lookup.
 * - `GLOBAL_NOT_FOUND`: the Global scope record itself could not be read.
 * - `NOT_A_DEVELOPED_APP`: the scope exists, but not as a `sys_app` (e.g. a store app).
 * - `SCOPE_NOT_FOUND`: no application on the instance has this scope.
 * - `LOOKUP_FAILED`: the lookup request itself failed (HTTP status, ACL, …).
 */
export type ScriptScopeFailureReason =
    | 'INVALID_SCOPE_NAME'
    | 'GLOBAL_NOT_FOUND'
    | 'NOT_A_DEVELOPED_APP'
    | 'SCOPE_NOT_FOUND'
    | 'LOOKUP_FAILED';

/** The sys_scope record a scope name matched, when it is not one scripts can run in. */
export interface ScriptScopeMatch {
    sysId: string;
    scope: string;
    name: string;
    className: string;
    active: boolean;
}

/**
 * Structural guard for {@link ScriptScopeError}.
 *
 * Matches on `code` rather than `instanceof` so it still works when the error has
 * crossed a module boundary or was thrown by a second copy of this package.
 */
export function isScriptScopeError(error: unknown): error is ScriptScopeError {
    if (error instanceof ScriptScopeError) {
        return true;
    }
    return (error as { code?: string })?.code === ScriptScopeError.code;
}
