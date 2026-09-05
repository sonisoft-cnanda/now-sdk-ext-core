import { getCredentials } from '@servicenow/sdk-cli/dist/auth/index.js';
import type { Creds } from '@servicenow/sdk-cli-core/dist/auth/index.js';
import { SessionAuthError } from './SessionAuthError';

/** SDK-compatible credentials; refresh tokens remain private to the caller. */
export type SessionCredentials = Creds;
/** Obtain current credentials, persisting SDK rotation through the configured store. */
export type CredentialProvider = () => Promise<SessionCredentials>;

const lookups = new Map<string, Promise<SessionCredentials>>();

function invalidGrant(error: unknown, depth = 0): boolean {
    if (!error || typeof error !== 'object' || depth > 4) return false;
    const value = error as { error?: unknown; code?: unknown; cause?: unknown };
    return value.error === 'invalid_grant' || value.code === 'invalid_grant' ||
        invalidGrant(value.cause, depth + 1);
}

/** Validate untyped credentials without including credential material in errors. */
export function sessionCredentials(value: unknown): SessionCredentials {
    if (value && typeof value === 'object') {
        const c = value as Partial<SessionCredentials> & Record<string, unknown>;
        if (typeof c.instanceUrl === 'string' &&
            ((c.type === 'oauth' && typeof c.access_token === 'string' &&
                typeof c.refresh_token === 'string' && typeof c.token_type === 'string' &&
                typeof c.expires_at === 'number' && Number.isFinite(c.expires_at)) ||
             (c.type === 'basic' && typeof c.username === 'string' && typeof c.password === 'string'))) {
            return c as SessionCredentials;
        }
    }
    throw new SessionAuthError('NEX_AUTH_INVALID', 'Expected stored SDK credentials. Check the selected alias and credential backend.');
}

/** Resolve an explicit alias through the SDK's existing refresh and persistence path. */
export async function resolveSessionCredentials(alias: string): Promise<SessionCredentials> {
    if (!alias.trim()) throw new SessionAuthError('NEX_AUTH_INVALID', 'An explicit credential alias is required.');
    // SDK environment credentials override aliases; an alias-bound operation must not use them.
    if (process.env.SN_SDK_SESSION_TOKEN || process.env.SN_SDK_SESSION_BEARER_TOKEN ||
        process.env.SN_SDK_NODE_ENV === 'SN_SDK_CI_INSTALL') {
        throw new SessionAuthError('NEX_AUTH_INVALID', 'Unset SDK session/CI credential overrides before resolving a stored alias.');
    }
    const existing = lookups.get(alias);
    if (existing !== undefined) return existing;
    const lookup = (async (): Promise<SessionCredentials> => {
        try {
            const credentials = sessionCredentials(await getCredentials(alias));
            if (credentials.type === 'oauth' && credentials.expires_at <= Date.now() / 1000) {
                throw new SessionAuthError('NEX_AUTH_TEMPORARY', 'The SDK returned an expired access token. Retry after checking instance connectivity.');
            }
            return credentials;
        } catch (error: unknown) {
            if (error instanceof SessionAuthError) {
                throw new SessionAuthError(error.code, `Alias ${JSON.stringify(alias)}: ${error.remediation}`);
            }
            if (invalidGrant(error)) {
                throw new SessionAuthError('NEX_AUTH_REAUTH_REQUIRED', 'OAuth renewal was rejected. Reauthenticate this alias using now-sdk-x auth --add <instance>.');
            }
            throw new SessionAuthError('NEX_AUTH_TEMPORARY', `Credential lookup or renewal failed for alias ${JSON.stringify(alias)}. Check the backend and instance connectivity, then retry.`);
        }
    })();
    lookups.set(alias, lookup);
    try { return await lookup; }
    finally { if (lookups.get(alias) === lookup) lookups.delete(alias); }
}
