/**
 * Live proof that a stored SDK alias can mint a cookie session and that those
 * cookies survive a real DevTools inject.
 *
 * Instance comes from SN_INSTANCE_ALIAS (default in test/test_utils/test_config.ts).
 * Excluded from CI with the rest of /integration/.
 */
import {afterEach, beforeAll, describe, expect, it, jest} from '@jest/globals';
import type {BrowserSession} from '../../../src/auth/BrowserSession';
import {listenCdp} from '../../test_utils/cdp-fixture';
import {loadLiveAliasCredentials} from '../../test_utils/live_credentials';
import {SN_INSTANCE_ALIAS} from '../../test_utils/test_config';

const SECONDS = 1000;
const logs: string[] = [];

function attachLogSpies(): void {
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
        const original = console[method];
        jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
            logs.push(args.map(String).join(' '));
            original.apply(console, args);
        });
    }
}

function secretValues(session: BrowserSession): string[] {
    return session.storageState.cookies.map(cookie => cookie.value).filter(value => value.length > 8);
}

let createBrowserSession: typeof import('../../../src/auth/BrowserSession').createBrowserSession;
let injectBrowserSessionCdp: typeof import('../../../src/auth/DesktopBrowserSession').injectBrowserSessionCdp;
let session: BrowserSession;

beforeAll(async () => {
    ({createBrowserSession} = await import('../../../src/auth/BrowserSession'));
    ({injectBrowserSessionCdp} = await import('../../../src/auth/DesktopBrowserSession'));
    try {
        try {
            session = await createBrowserSession({alias: SN_INSTANCE_ALIAS});
        } catch {
            // Jest can hide the SDK keychain from getCredentials; use the stored alias.
            session = await createBrowserSession({
                alias: SN_INSTANCE_ALIAS,
                credentials: await loadLiveAliasCredentials(SN_INSTANCE_ALIAS),
            });
        }
    } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Could not mint a browser session for alias ${JSON.stringify(SN_INSTANCE_ALIAS)}. ` +
            `Set SN_INSTANCE_ALIAS or add the alias with now-sdk-x auth --add. ${detail}`,
        );
    }
}, 90 * SECONDS);

afterEach(() => {
    logs.length = 0;
    jest.restoreAllMocks();
});

describe('createBrowserSession + injectBrowserSessionCdp (live alias)', () => {
    it('mints a verified cookie session for the configured alias', () => {
        expect(session.alias).toBe(SN_INSTANCE_ALIAS);
        expect(session.instanceUrl).toMatch(/^https:\/\//);
        expect(() => new URL(session.instanceUrl)).not.toThrow();
        expect(session.createdAt).toBeGreaterThan(0);
        expect(session.storageState.cookies.length).toBeGreaterThan(0);
        expect(session.storageState.cookies.every(cookie => cookie.name && cookie.value && cookie.domain))
            .toBe(true);
        expect(session.storageState.origins).toEqual([]);
        expect(JSON.stringify({
            alias: session.alias,
            createdAt: session.createdAt,
            instanceUrl: session.instanceUrl,
        })).not.toEqual(expect.stringContaining(session.storageState.cookies[0].value));
    });

    it('replays storageState against the instance without an Authorization header', async () => {
        const cookieHeader = session.storageState.cookies
            .map(cookie => `${cookie.name}=${cookie.value}`)
            .join('; ');
        const origin = new URL('/angular.do?sysparm_type=get_user', session.instanceUrl);
        let userToken: string | undefined;
        let response: Response | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
            response = await fetch(origin, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Cookie: cookieHeader,
                    ...(userToken ? {'X-UserToken': userToken} : {}),
                },
                redirect: 'manual',
                signal: AbortSignal.timeout(30_000),
            });
            const csrf = response.headers.get('x-usertoken-response');
            if (response.status === 401 && csrf && attempt === 0) {
                userToken = csrf;
                continue;
            }
            break;
        }
        expect(response?.ok).toBe(true);
        const body: unknown = await response?.json();
        const record = body && typeof body === 'object'
            ? (body as {result?: Record<string, unknown>}).result ?? body as Record<string, unknown>
            : undefined;
        const id = record?.userID ?? record?.user_id;
        const name = record?.userName ?? record?.user_name;
        expect(typeof id).toBe('string');
        expect(id).not.toBe('guest');
        expect(typeof name).toBe('string');
        expect(name).not.toBe('guest');
    }, 45 * SECONDS);

    it('injects the live cookies through a real DevTools endpoint', async () => {
        attachLogSpies();
        const cdp = await listenCdp();
        try {
            await injectBrowserSessionCdp({cdpUrl: cdp.url, session});
            const methods = cdp.messages.map(message => message.method);
            expect(methods).toEqual(expect.arrayContaining(['Storage.setCookies', 'Page.navigate']));
            const injected = cdp.messages.find(message => message.method === 'Storage.setCookies')
                ?.params as {cookies: Array<{name: string; url: string; value: string}>};
            expect(injected.cookies.map(cookie => cookie.name).sort())
                .toEqual([...session.storageState.cookies.map(cookie => cookie.name)].sort());
            expect(injected.cookies.map(cookie => cookie.value).sort())
                .toEqual([...session.storageState.cookies.map(cookie => cookie.value)].sort());
            expect(injected.cookies.every(cookie => cookie.url === session.instanceUrl)).toBe(true);
            expect(cdp.messages.find(message => message.method === 'Page.navigate')?.params)
                .toEqual({url: session.instanceUrl});
            const leaked = secretValues(session).some(secret => logs.join('\n').includes(secret));
            expect(leaked).toBe(false);
        } finally {
            await cdp.close();
        }
    }, 30 * SECONDS);
});
