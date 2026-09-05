import { getUserSession } from '@servicenow/sdk-cli/dist/auth/index.js';
import type { UserSession } from '@servicenow/sdk-cli/dist/auth/index.js';
import { resolveSessionCredentials, SessionCredentials } from './CredentialProvider';
import { SessionAuthError } from './SessionAuthError';
import { Cookie } from 'tough-cookie';

/** Standard Playwright cookie representation, with no Playwright runtime dependency. */
export interface BrowserCookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
}

/** Secret browser state: pass in memory or save to an owner-only file, never log it. */
export interface BrowserSession {
    alias: string;
    instanceUrl: string;
    createdAt: number;
    oauthExpiresAt?: number;
    storageState: { cookies: BrowserCookie[]; origins: [] };
}

/** Establish SDK cookies and prove they authenticate without the OAuth bearer token. */
export async function verifiedUserSession(credentials: SessionCredentials): Promise<UserSession> {
    const origin = new URL(credentials.instanceUrl);
    if (origin.protocol !== 'https:' || origin.username || origin.password) {
        throw new SessionAuthError('NEX_AUTH_INVALID', 'Browser sessions require an HTTPS instance URL without embedded credentials.');
    }
    try {
        const session = await getUserSession(credentials);
        if (!session?.cookie) throw new SessionAuthError('NEX_AUTH_INVALID', 'The SDK did not create a cookie session.');
        for (let attempt = 0; attempt < 2; attempt++) {
            const response = await fetch(new URL('/angular.do?sysparm_type=get_user', origin), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Cookie: session.cookie.getCookieStringSync(origin.href),
                    ...(session.userToken ? { 'X-UserToken': session.userToken } : {}),
                },
                redirect: 'manual',
                signal: AbortSignal.timeout(30_000),
            });
            for (const cookie of response.headers.getSetCookie()) session.cookie.setCookieSync(cookie, origin.href);
            const csrf = response.headers.get('x-usertoken-response');
            if (response.status === 401 && csrf && attempt === 0) {
                session.userToken = csrf;
                continue;
            }
            if (response.ok) {
                const body: unknown = await response.json();
                const user = body && typeof body === 'object' ? (body as { result?: unknown }).result ?? body : undefined;
                const record = user && typeof user === 'object' ? user as Record<string, unknown> : undefined;
                const id = record?.userID ?? record?.user_id;
                const name = record?.userName ?? record?.user_name;
                if (typeof id === 'string' && id && id !== 'guest' &&
                    typeof name === 'string' && name && name !== 'guest') return session;
            }
            throw new SessionAuthError('NEX_AUTH_INVALID', 'Cookie-only UI authentication failed. Check UI access, instance policy, and the selected alias.');
        }
    } catch (error: unknown) {
        if (error instanceof SessionAuthError) throw error;
        throw new SessionAuthError('NEX_AUTH_TEMPORARY', 'Session bootstrap failed. Check instance connectivity and retry.');
    }
    throw new SessionAuthError('NEX_AUTH_INVALID', 'Cookie-only UI authentication failed.');
}

/** Create a fresh, verified Playwright session using an existing SDK alias. */
export async function createBrowserSession(options: { alias: string }): Promise<BrowserSession> {
    const credentials = await resolveSessionCredentials(options.alias);
    const session = await verifiedUserSession(credentials);
    const origin = new URL(credentials.instanceUrl);
    const serialized: unknown[] = session.cookie.serializeSync().cookies;
    const cookies = serialized
        .map(value => value && typeof value === 'object' ? Cookie.fromJSON(value) : null)
        .filter((cookie): cookie is Cookie => cookie !== null && Boolean(cookie.domain) &&
            (origin.hostname === cookie.domain || origin.hostname.endsWith('.' + cookie.domain)))
        .map((cookie): BrowserCookie => ({
            name: cookie.key,
            value: cookie.value,
            domain: cookie.hostOnly ? cookie.domain : '.' + cookie.domain,
            path: cookie.path ?? '/',
            expires: Number.isFinite(cookie.expiryTime()) ? cookie.expiryTime() / 1000 : -1,
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            sameSite: cookie.sameSite === 'strict' ? 'Strict' : cookie.sameSite === 'none' ? 'None' : 'Lax',
        }));
    return {
        alias: options.alias, instanceUrl: origin.origin, createdAt: Date.now(),
        ...(credentials.type === 'oauth' ? { oauthExpiresAt: credentials.expires_at } : {}),
        storageState: { cookies, origins: [] },
    };
}
