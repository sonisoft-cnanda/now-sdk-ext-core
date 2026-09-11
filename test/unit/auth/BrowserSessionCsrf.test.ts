import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {CookieJar} from 'tough-cookie';

const instanceUrl = 'https://example.service-now.com';
const session = {
    type: 'basic' as const,
    instanceUrl,
    cookie: new CookieJar(),
    userToken: 'initial-token',
};

jest.unstable_mockModule('@servicenow/sdk-cli-core/dist/auth/index.js', () => ({
    getUserSession: jest.fn(async () => session),
}));
const {verifiedUserSession} = await import('../../../src/auth/BrowserSession');

const credentials = {
    type: 'oauth' as const,
    instanceUrl,
    access_token: 'synthetic-access',
    refresh_token: 'synthetic-refresh',
    token_type: 'Bearer',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
};

beforeEach(() => {
    session.userToken = 'initial-token';
    session.cookie.removeAllCookiesSync();
});
afterEach(() => jest.restoreAllMocks());

describe('browser-session CSRF compatibility', () => {
    it('accepts one server-issued CSRF rotation and proves the cookie session', async () => {
        const fetch = jest.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(new Response('', {
                status: 401,
                headers: {'x-usertoken-response': 'rotated-token'},
            }))
            .mockResolvedValueOnce(new Response(JSON.stringify({userID: 'fixture-user', userName: 'fixture'}), {
                headers: {'Content-Type': 'application/json'},
            }));

        await expect(verifiedUserSession(credentials)).resolves.toBe(session);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(session.userToken).toBe('rotated-token');
        expect(new Headers(fetch.mock.calls[1][1]?.headers).get('X-UserToken')).toBe('rotated-token');
        for (const [, init] of fetch.mock.calls) {
            expect(new Headers(init?.headers).has('Authorization')).toBe(false);
        }
    });

    it('fails closed when a 401 has no replacement CSRF token', async () => {
        const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', {status: 401}));

        await expect(verifiedUserSession(credentials)).rejects.toMatchObject({code: 'NEX_AUTH_INVALID'});
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('bounds retry when the replacement CSRF token is rejected', async () => {
        const fetch = jest.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(new Response('', {
                status: 401,
                headers: {'x-usertoken-response': 'invalid-token'},
            }))
            .mockResolvedValueOnce(new Response('', {status: 403}));

        await expect(verifiedUserSession(credentials)).rejects.toMatchObject({code: 'NEX_AUTH_INVALID'});
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['guest identity', new Response(JSON.stringify({userID: 'guest', userName: 'guest'}), {
            headers: {'Content-Type': 'application/json'},
        })],
        ['redirect', new Response('', {status: 302, headers: {Location: '/login.do'}})],
        ['malformed success', new Response('{not-json', {headers: {'Content-Type': 'application/json'}})],
    ])('rejects %s without retrying', async (_label, response) => {
        const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(response);

        await expect(verifiedUserSession(credentials)).rejects.toMatchObject({
            code: expect.stringMatching(/^NEX_AUTH_(INVALID|TEMPORARY)$/),
        });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('preserves rotated cookies for the bounded retry', async () => {
        const fetch = jest.spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(new Response('', {
                status: 401,
                headers: {
                    'x-usertoken-response': 'rotated-token',
                    'Set-Cookie': 'JSESSIONID=rotated-session; Path=/; Secure; HttpOnly',
                },
            }))
            .mockResolvedValueOnce(new Response(JSON.stringify({userID: 'fixture-user', userName: 'fixture'}), {
                headers: {'Content-Type': 'application/json'},
            }));

        await verifiedUserSession(credentials);
        expect(new Headers(fetch.mock.calls[1][1]?.headers).get('Cookie')).toContain('JSESSIONID=rotated-session');
    });

    it('sanitizes network failures', async () => {
        const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('synthetic-access'));

        try { await verifiedUserSession(credentials); }
        catch (error: unknown) {
            expect(error).toMatchObject({code: 'NEX_AUTH_TEMPORARY'});
            expect(String(error)).not.toContain('synthetic-access');
        }
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});
