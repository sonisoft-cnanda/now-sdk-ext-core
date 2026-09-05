import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {ServiceNowInstance} from '../../../src/sn/ServiceNowInstance';
import {ServiceNowRequest} from '../../../src/comm/http/ServiceNowRequest';
import {NowSDKAuthenticationHandler} from '../../../src/auth/NowSDKAuthenticationHandler';
import {verifiedUserSession} from '../../../src/auth/BrowserSession';
import type {SessionCredentials} from '../../../src/auth/CredentialProvider';

const instanceUrl = 'https://example.service-now.com';
const credential = (): SessionCredentials => ({
    type: 'oauth', instanceUrl, access_token: 'test-access', refresh_token: 'test-refresh',
    token_type: 'Bearer', expires_at: Math.floor(Date.now() / 1000) + 3600,
});
const read = {path: '/api/now/table/incident', headers: null, query: null, body: null};
let calls: Array<{path: string; headers: Headers}>;
let failReads: number;
let requests: number;
let anonymous: boolean;

beforeEach(() => {
    calls = []; failReads = 0; requests = 0; anonymous = false;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        calls.push({path: url.pathname, headers});
        if (url.pathname === '/angular.do') {
            return new Response(JSON.stringify(anonymous ? {userName: 'guest', userID: 'guest-id'} :
                {userID: 'test-user', userName: 'tester'}), {
                headers: {'Content-Type': 'application/json', 'Set-Cookie': 'JSESSIONID=test-session; Path=/; Secure; HttpOnly'},
            });
        }
        if (url.pathname === read.path || url.pathname.includes('/install') || url.pathname.includes('/impersonate')) {
            requests++;
            if (failReads-- > 0) return new Response('', {status: 401});
        }
        return new Response(JSON.stringify({result: []}), {headers: {'Content-Type': 'application/json'}});
    });
});
afterEach(() => jest.restoreAllMocks());

describe('SDK session renewal', () => {
    it('refreshes before expiry and coalesces concurrent requests', async () => {
        const initial = credential();
        const provider = jest.fn(async () => initial);
        const request = new ServiceNowRequest(new ServiceNowInstance({credential: initial, credentialProvider: provider}));
        await request.get({...read});
        expect(provider).toHaveBeenCalledTimes(1);
        if (initial.type === 'oauth') initial.expires_at = Math.floor(Date.now() / 1000) + 30;
        let finish: (value: SessionCredentials) => void;
        provider.mockImplementation(() => new Promise<SessionCredentials>(resolve => { finish = resolve; }));
        const pending = Array.from({length: 20}, () => request.get({...read}));
        expect(provider).toHaveBeenCalledTimes(2);
        finish(credential());
        await Promise.all(pending);
        expect(provider).toHaveBeenCalledTimes(2);
    });

    it('renews and retries a read once after a 401', async () => {
        const provider = jest.fn(async () => credential());
        const request = new ServiceNowRequest(new ServiceNowInstance({credential: credential(), credentialProvider: provider}));
        failReads = 1;
        await request.get({...read});
        expect(provider).toHaveBeenCalledTimes(2);
        expect(requests).toBe(2);
    });

    it('stops after the second 401 without exposing the response', async () => {
        const request = new ServiceNowRequest(new ServiceNowInstance({credential: credential(), credentialProvider: async () => credential()}));
        failReads = 10;
        await expect(request.get({...read})).rejects.toMatchObject({code: 'NEX_SESSION_EXPIRED'});
        expect(requests).toBe(2);
    });

    it.each(['POST', 'GET'])('does not replay a mutating %s', async method => {
        const request = new ServiceNowRequest(new ServiceNowInstance({credential: credential(), credentialProvider: async () => credential()}));
        failReads = 1;
        const operation = method === 'POST' ? request.post({...read}) :
            request.get({...read, path: '/api/sn_appclient/appmanager/app/install'});
        await expect(operation).rejects.toMatchObject({code: 'NEX_SESSION_EXPIRED'});
        expect(requests).toBe(1);
    });

    it('refuses to renew a pinned impersonation session', async () => {
        const initial = credential();
        const request = new ServiceNowRequest(new ServiceNowInstance({credential: initial, credentialProvider: async () => credential()}));
        await request.post({...read, path: '/api/now/ui/impersonate/test-user'});
        await expect((request.auth as NowSDKAuthenticationHandler).ensureSession(true))
            .rejects.toMatchObject({code: 'NEX_SESSION_EXPIRED'});
    });

    it('rejects an alias changing origins before sending requests there', async () => {
        const request = new ServiceNowRequest(new ServiceNowInstance({
            credential: credential(), credentialProvider: async () => ({...credential(), instanceUrl: 'https://other.service-now.com'}),
        }));
        await expect(request.get({...read})).rejects.toMatchObject({code: 'NEX_AUTH_ORIGIN_CHANGED'});
        expect(calls).toHaveLength(0);
    });

    it('verifies cookies without bearer auth, rejects anonymous cookies', async () => {
        const session = await verifiedUserSession(credential());
        expect(session.cookie.getCookiesSync(instanceUrl)).toHaveLength(1);
        expect(calls.at(-1)?.headers.has('Authorization')).toBe(false);
        anonymous = true;
        await expect(verifiedUserSession(credential())).rejects.toMatchObject({code: 'NEX_AUTH_INVALID'});
    });
});
