import {afterEach, describe, expect, it, jest} from '@jest/globals';
import {CookieJar} from 'tough-cookie';

const instanceUrl = 'https://example.service-now.com';
const getUserSession = jest.fn();
const getCredentials = jest.fn();

jest.unstable_mockModule('@servicenow/sdk-cli-core/dist/auth/index.js', () => ({getUserSession}));
jest.unstable_mockModule('@servicenow/sdk-cli/dist/auth/index.js', () => ({getCredentials}));

const {createBrowserSession, verifiedUserSession} = await import('../../../src/auth/BrowserSession');

const oauth = {
    type: 'oauth' as const,
    instanceUrl,
    access_token: 'synthetic-access',
    refresh_token: 'synthetic-refresh',
    token_type: 'Bearer',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
};

function jarWith(cookies: Array<{cookie: string; url?: string}>): CookieJar {
    const jar = new CookieJar();
    for (const item of cookies) jar.setCookieSync(item.cookie, item.url ?? instanceUrl);
    return jar;
}

afterEach(() => {
    getUserSession.mockReset();
    getCredentials.mockReset();
    jest.restoreAllMocks();
    delete process.env.SN_SDK_SESSION_BEARER_TOKEN;
    delete process.env.SN_SDK_SESSION_TOKEN;
    delete process.env.SN_SDK_NODE_ENV;
});

function proveIdentity(): void {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
        JSON.stringify({result: {user_id: 'fixture-user', user_name: 'tester'}}),
        {headers: {'Content-Type': 'application/json'}},
    ));
}

describe('createBrowserSession', () => {
    it('maps host-only and domain cookies, including SameSite, without oauth leakage in errors', async () => {
        proveIdentity();
        getCredentials.mockResolvedValue(oauth);
        getUserSession.mockResolvedValue({
            type: 'basic',
            instanceUrl,
            cookie: jarWith([
                {cookie: 'JSESSIONID=keep-host; Path=/; Secure; HttpOnly'},
                {cookie: 'glide_user_route=route; Domain=example.service-now.com; Path=/api; Secure; HttpOnly; SameSite=Strict'},
                {cookie: 'cross=none; Domain=example.service-now.com; Path=/; Secure; HttpOnly; SameSite=None'},
                {cookie: 'foreign=nope; Domain=evil.example; Path=/; Secure; HttpOnly', url: 'https://evil.example/'},
            ]),
            userToken: 'csrf',
        });

        const session = await createBrowserSession({alias: 'fixture'});
        expect(session).toMatchObject({
            alias: 'fixture',
            instanceUrl,
            oauthExpiresAt: oauth.expires_at,
        });
        expect(session.createdAt).toBeGreaterThan(0);
        expect(session.storageState.origins).toEqual([]);
        const byName = Object.fromEntries(session.storageState.cookies.map(cookie => [cookie.name, cookie]));
        expect(byName.JSESSIONID).toMatchObject({
            value: 'keep-host',
            domain: 'example.service-now.com',
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
        });
        expect(byName.glide_user_route).toMatchObject({
            domain: '.example.service-now.com',
            path: '/api',
            sameSite: 'Strict',
        });
        expect(byName.cross.sameSite).toBe('None');
        expect(byName).not.toHaveProperty('foreign');
        expect(JSON.stringify({alias: session.alias, instanceUrl: session.instanceUrl}))
            .not.toMatch(/synthetic-(access|refresh)|keep-host/);
    });

    it('omits oauthExpiresAt for basic credentials', async () => {
        proveIdentity();
        getCredentials.mockResolvedValue({
            type: 'basic',
            instanceUrl,
            username: 'tester',
            password: 'synthetic-password',
        });
        getUserSession.mockResolvedValue({
            cookie: jarWith([{cookie: 'JSESSIONID=basic-session; Path=/; Secure; HttpOnly'}]),
            userToken: 'csrf',
        });

        const session = await createBrowserSession({alias: 'fixture'});
        expect(session).not.toHaveProperty('oauthExpiresAt');
        expect(session.storageState.cookies).toHaveLength(1);
    });

    it('rejects an empty alias before touching the SDK session', async () => {
        await expect(createBrowserSession({alias: '   '})).rejects.toMatchObject({code: 'NEX_AUTH_INVALID'});
        expect(getCredentials).not.toHaveBeenCalled();
        expect(getUserSession).not.toHaveBeenCalled();
    });

    it('uses caller-supplied credentials without looking up the alias', async () => {
        proveIdentity();
        getUserSession.mockResolvedValue({
            cookie: jarWith([{cookie: 'JSESSIONID=supplied; Path=/; Secure; HttpOnly'}]),
            userToken: 'csrf',
        });

        const session = await createBrowserSession({alias: 'fixture', credentials: oauth});
        expect(getCredentials).not.toHaveBeenCalled();
        expect(session.oauthExpiresAt).toBe(oauth.expires_at);
        expect(session.storageState.cookies[0]?.value).toBe('supplied');
    });
});

describe('verifiedUserSession origin checks', () => {
    it.each([
        ['http://example.service-now.com', 'http'],
        ['https://user:pass@example.service-now.com', 'embedded credentials'],
    ])('rejects %s', async (url, _label) => {
        await expect(verifiedUserSession({...oauth, instanceUrl: url}))
            .rejects.toMatchObject({code: 'NEX_AUTH_INVALID'});
        expect(getUserSession).not.toHaveBeenCalled();
    });
});
