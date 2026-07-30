/**
 * Thrown when a request is about to be dispatched with a session that was minted
 * for a different ServiceNow instance.
 *
 * This is worth failing loudly over, because the consequence is not a rejected
 * request. `makeRequest` derives the destination host from `auth.instanceUrl`, so a
 * mismatched session sends the request *to the wrong instance*, authenticated as
 * that instance's user. A write intended for dev can land on prod and succeed.
 *
 * The shape here — `code`, `remediation`, `cause` — deliberately mirrors the error
 * taxonomy in `@sonisoft/sn-credstore` so that consumers which already read
 * `remediation` off an unknown error (`now-sdk-ext-cli`'s authenticated-command,
 * `now-sdk-ext-mcp`'s credstore-boot) surface it with no change. It does not import
 * that taxonomy: sn-credstore is an *optional* dependency of this package, so a
 * static value import would crash any install that skipped it, and `instanceof`
 * across its dual ESM/CJS build is unreliable regardless.
 */
export class StaleInstanceError extends Error {

    /** Stable machine-readable code. Prefer this over `instanceof` across module boundaries. */
    public static readonly code: string = "INSTANCE_STALE_DURING_REQUEST";

    public readonly code: string;

    public readonly remediation: string;

    public constructor(message: string, remediation: string, options: { cause?: unknown } = {}) {
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = new.target.name;
        this.code = StaleInstanceError.code;
        this.remediation = remediation;
    }

    public toJSON(): { name: string; message: string; code: string; remediation: string } {
        return {
            name: this.name,
            message: this.message,
            code: this.code,
            remediation: this.remediation,
        };
    }

    public toString(): string {
        return `${this.name}: ${this.message}\n\nRemediation: ${this.remediation}`;
    }
}

/**
 * Structural guard for {@link StaleInstanceError}.
 *
 * Matches on `code` rather than `instanceof` so it still works when the error has
 * crossed a module boundary, been serialized, or been rebuilt by a consumer that
 * loaded a second copy of this package.
 */
export function isStaleInstanceError(error: unknown): boolean {
    if (error instanceof StaleInstanceError) {
        return true;
    }
    return (error as { code?: string })?.code === StaleInstanceError.code;
}
