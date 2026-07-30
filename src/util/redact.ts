/**
 * Removes credential material from values before they are logged or thrown.
 *
 * The failure this exists for is not hypothetical. `RequestHandler.getRequestConfig`
 * builds `{auth: this._session, ...}` and the next line logs that whole object at
 * debug level, so every request wrote a live session — cookies, user token, or an
 * OAuth access token — into `logs/app-debug.log`. That is what forced the `^logs/`
 * allowlist in `.gitleaks.toml`.
 *
 * Redaction is by KEY, not by value. A value-based approach needs a registry of the
 * secrets currently in play, which does not exist at the point a Winston format runs.
 * Key-based matching costs nothing and catches the shape of the problem: secrets in
 * this codebase always arrive under a recognisable name (`auth`, `cookie`,
 * `access_token`, …) because they come from the SDK's own session objects.
 */

export const REDACTED = "[redacted]";

/**
 * Keys whose values must never be logged. Matched case-insensitively against the
 * whole key, plus a substring pass for compound names like `sessionToken`.
 */
const SECRET_KEYS: readonly string[] = [
    "auth",
    "authorization",
    "session",
    "credential",
    "credentials",
    "password",
    "passwd",
    "secret",
    "client_secret",
    "clientsecret",
    "token",
    "access_token",
    "refresh_token",
    "id_token",
    "usertoken",
    "cookie",
    "cookies",
    "set-cookie",
    "csrftoken",
    "sysparm_ck",
    "apikey",
    "api_key",
];

/** Substrings that make a key secret regardless of what surrounds them. */
const SECRET_FRAGMENTS: readonly string[] = [
    "password",
    "secret",
    "token",
    "cookie",
    "credential",
];

/** Depth cap. Session and response graphs are deep; nothing useful lives past this. */
const MAX_DEPTH = 8;

export function isSecretKey(key: string): boolean {
    if (!key) {
        return false;
    }
    const lowered = key.toLowerCase();
    if (SECRET_KEYS.includes(lowered)) {
        return true;
    }
    return SECRET_FRAGMENTS.some((fragment) => lowered.includes(fragment));
}

/**
 * Returns a copy of `value` with every secret-shaped key replaced by `[redacted]`.
 *
 * Never mutates the input — callers are logging live objects that the rest of the
 * request still depends on. Cycles, depth overruns, and unserializable values all
 * degrade to a placeholder string rather than throwing: a logger that throws is worse
 * than one that omits a field.
 */
export function redactValue(value: unknown, depth = 0, seen?: WeakSet<object>): unknown {
    if (value === null || value === undefined) {
        return value;
    }

    const primitive = typeof value !== "object" && typeof value !== "function";
    if (primitive) {
        return value;
    }

    if (depth >= MAX_DEPTH) {
        return "[truncated]";
    }

    const tracker = seen ?? new WeakSet<object>();
    if (tracker.has(value)) {
        return "[circular]";
    }
    tracker.add(value);

    if (typeof value === "function") {
        return "[function]";
    }

    if (value instanceof Error) {
        return redactError(value, depth, tracker);
    }

    if (value instanceof Date) {
        return value;
    }

    // tough-cookie CookieJar and similar: walking them yields the cookie values we are
    // trying to suppress, and their internals are not useful in a log line anyway.
    const constructorName = value?.constructor?.name ?? "";
    if (/cookiejar|cookie/i.test(constructorName)) {
        return REDACTED;
    }

    if (Array.isArray(value)) {
        return value.map((entry) => redactValue(entry, depth + 1, tracker));
    }

    if (value instanceof Map) {
        const out: Record<string, unknown> = {};
        for (const [key, entry] of value.entries()) {
            const name = String(key);
            out[name] = isSecretKey(name) ? REDACTED : redactValue(entry, depth + 1, tracker);
        }
        return out;
    }

    if (value instanceof Set) {
        return [...value].map((entry) => redactValue(entry, depth + 1, tracker));
    }

    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
        if (isSecretKey(key)) {
            out[key] = REDACTED;
            continue;
        }
        try {
            out[key] = redactValue(record[key], depth + 1, tracker);
        } catch {
            // A throwing getter must not take the log line down with it.
            out[key] = "[unreadable]";
        }
    }
    return out;
}

/**
 * Strips credential material from an error **in place** and returns it.
 *
 * Used before rethrowing, so the error that reaches a consumer carries nothing
 * sensitive. Deliberately mutates rather than returning a replacement: consumers do
 * `instanceof` checks against it (StaleInstanceError, and the CLI's remediation
 * duck-typing), and rebuilding the error would break both and discard the stack.
 *
 * This matters more since sessions stopped being flattened at the throw sites: an
 * error now reaches callers with `config` and `response` intact, and their loggers do
 * not have core's redaction format.
 */
export function stripSecretsFromError<T>(error: T): T {
    if (!error || typeof error !== "object") {
        return error;
    }

    const err = error as unknown as Record<string, unknown>;
    for (const key of Object.keys(err)) {
        if (isSecretKey(key)) {
            err[key] = REDACTED;
            continue;
        }
        const child = err[key];
        if (child && typeof child === "object") {
            try {
                err[key] = redactValue(child);
            } catch {
                err[key] = "[unreadable]";
            }
        }
    }
    return error;
}

/**
 * Returns a plain object describing `error` with credential material removed.
 *
 * Kept structural rather than returning a rebuilt Error: this is for logging and for
 * handing to a consumer, and a plain object cannot be mistaken for something throwable
 * that has lost its prototype.
 */
export function redactError(
    error: unknown,
    depth = 0,
    seen?: WeakSet<object>,
): Record<string, unknown> {
    const tracker = seen ?? new WeakSet<object>();
    const err = error as Record<string, unknown> & Error;

    const out: Record<string, unknown> = {
        name: err?.name,
        message: typeof err?.message === "string" ? err.message : String(err?.message ?? ""),
    };

    if (typeof err?.stack === "string") {
        out.stack = err.stack;
    }

    // Everything else an error may be carrying — axios-style `config`, a fetch
    // `request`, a `response`, a `cause` — is where credentials actually hide.
    for (const key of Object.keys(err ?? {})) {
        if (key === "name" || key === "message" || key === "stack") {
            continue;
        }
        if (isSecretKey(key)) {
            out[key] = REDACTED;
            continue;
        }
        try {
            out[key] = redactValue(err[key], depth + 1, tracker);
        } catch {
            out[key] = "[unreadable]";
        }
    }

    if (err?.cause !== undefined && out.cause === undefined) {
        out.cause = redactValue(err.cause, depth + 1, tracker);
    }

    return out;
}
