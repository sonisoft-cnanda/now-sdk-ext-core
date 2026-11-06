import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { elevateSession, normalizeRoles, parseElevation, readElevation, RoleElevationError, ELEVATE_ROLE_PATH } from '../../../src/auth/SessionElevation';
import { ServiceNowInstance } from '../../../src/sn/ServiceNowInstance';
import { ServiceNowRequest } from '../../../src/comm/http/ServiceNowRequest';
import { NowSDKAuthenticationHandler } from '../../../src/auth/NowSDKAuthenticationHandler';
import type { SessionCredentials } from '../../../src/auth/CredentialProvider';

const instanceUrl = 'https://example.service-now.com';
const session = { type: 'oauth', instanceUrl, access_token: 'test-access', token_type: 'Bearer' } as any;
const SECURITY_ADMIN = { name: 'security_admin', description: 'Grant modification access to High Security Settings' };

let available: Array<{ name: string; description: string }>;
let active: Set<string>;
let posts: string[];
let calls: string[];
let getStatus: number;
let postStatus: number;
let postBody: string;
let ignorePost: boolean;

beforeEach(() => {
    available = [SECURITY_ADMIN, { name: 'x_app.auditor', description: '' }];
    active = new Set(['itil', 'admin']);
    posts = []; calls = [];
    getStatus = 200; postStatus = 201; postBody = ''; ignorePost = false;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
        if (url.pathname === '/angular.do') {
            return new Response(JSON.stringify({ userID: 'test-user', userName: 'tester' }), {
                headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'JSESSIONID=test-session; Path=/; Secure; HttpOnly' } });
        }
        if (url.pathname === ELEVATE_ROLE_PATH) {
            const state = () => new Response(JSON.stringify({ result: { roles: available, activeRoles: [...active] } }),
                { status: 200, headers: { 'Content-Type': 'application/json' } });
            if (init?.method === 'POST') {
                posts.push(String(init.body));
                if (postStatus !== 201) return new Response(postBody, { status: postStatus });
                if (!ignorePost) {
                    const roles = JSON.parse(String(init.body)).roles.split(',').filter(Boolean);
                    for (const role of available.map(r => r.name)) active.delete(role);
                    for (const role of roles) active.add(role);
                }
                return new Response(JSON.stringify({ result: { roles: available, activeRoles: [...active] } }), { status: 201 });
            }
            if (getStatus !== 200) return new Response(postBody, { status: getStatus });
            return state();
        }
        return new Response(JSON.stringify({ result: [] }), { headers: { 'Content-Type': 'application/json' } });
    });
});
afterEach(() => jest.restoreAllMocks());

describe('normalizeRoles', () => {
    it('trims and de-duplicates', () => {
        expect(normalizeRoles([' security_admin', 'security_admin', '', 'x_app.auditor'])).toEqual(['security_admin', 'x_app.auditor']);
        expect(normalizeRoles(undefined)).toEqual([]);
    });
    it('refuses anything that is not a role name', () => {
        expect(() => normalizeRoles(['security_admin,admin'])).toThrow(RoleElevationError);
        expect(() => normalizeRoles(['1role'])).toThrow(expect.objectContaining({ code: 'invalid_role' }));
    });
});

describe('parseElevation', () => {
    it('reports only the available roles that are active', () => {
        expect(parseElevation({ result: { roles: [SECURITY_ADMIN], activeRoles: ['admin', 'security_admin'] } }))
            .toEqual({ available: [SECURITY_ADMIN], elevated: ['security_admin'] });
    });
    it('rejects another shape', () => {
        expect(parseElevation({ result: { roles: 'x' } })).toBeUndefined();
        expect(parseElevation(null)).toBeUndefined();
    });
});

describe('elevateSession', () => {
    it('elevates, sends the complete set as JSON, and proves the role is active afterwards', async () => {
        active.add('x_app.auditor');
        const status = await elevateSession(session, ['security_admin']);
        expect(posts).toEqual([JSON.stringify({ roles: 'x_app.auditor,security_admin' })]);
        expect(status.elevated.sort()).toEqual(['security_admin', 'x_app.auditor']);
        expect(calls).toEqual([`GET ${ELEVATE_ROLE_PATH}`, `POST ${ELEVATE_ROLE_PATH}`, `GET ${ELEVATE_ROLE_PATH}`]);
    });

    it('does not post when the roles are already elevated', async () => {
        active.add('security_admin');
        await elevateSession(session, ['security_admin']);
        expect(posts).toEqual([]);
    });

    it('refuses a role the user cannot elevate to, naming what is available, without posting', async () => {
        const error = await elevateSession(session, ['admin']).catch(e => e);
        expect(error).toMatchObject({ code: 'not_elevatable', roles: ['admin'], available: ['security_admin', 'x_app.auditor'] });
        expect(posts).toEqual([]);
    });

    it('fails when the instance accepts the request but the role is not active afterwards', async () => {
        ignorePost = true;
        await expect(elevateSession(session, ['security_admin'])).rejects.toMatchObject({ code: 'not_applied', roles: ['security_admin'] });
    });

    it('reports a disabled API as unavailable and other failures without the response body', async () => {
        getStatus = 400; postBody = '{"error":{"message":"Requested URI does not represent any resource"}}';
        await expect(readElevation(session)).rejects.toMatchObject({ code: 'api_unavailable', status: 400 });
        getStatus = 500; postBody = 'private-body-sentinel';
        const error = await readElevation(session).catch(e => e);
        expect(error).toMatchObject({ code: 'request_failed', status: 500 });
        expect(String(error.message)).not.toContain('sentinel');
    });
});

describe('elevation at login', () => {
    const credential = (): SessionCredentials => ({
        type: 'oauth', instanceUrl, access_token: 'test-access', refresh_token: 'test-refresh',
        token_type: 'Bearer', expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    const read = { path: '/api/now/table/incident', headers: null, query: null, body: null };

    it('elevates every session the instance logs in, before its first request', async () => {
        const request = new ServiceNowRequest(new ServiceNowInstance({ credentialProvider: async () => credential(), elevatedRoles: ['security_admin'] }));
        await request.get({ ...read });
        expect(posts).toHaveLength(1);
        expect(calls.indexOf(`POST ${ELEVATE_ROLE_PATH}`)).toBeLessThan(calls.indexOf('GET /api/now/table/incident'));
        // A renewed session is a new server session: it elevates again.
        for (const role of ['security_admin']) active.delete(role);
        await (request.auth as NowSDKAuthenticationHandler).ensureSession(true);
        expect(posts).toHaveLength(2);
    });

    it('does nothing extra without elevatedRoles', async () => {
        const request = new ServiceNowRequest(new ServiceNowInstance({ credentialProvider: async () => credential() }));
        await request.get({ ...read });
        expect(calls.filter(call => call.includes('impersonate'))).toEqual([]);
    });

    it('fails the login, unauthenticated, when elevation fails', async () => {
        const request = new ServiceNowRequest(new ServiceNowInstance({ credentialProvider: async () => credential(), elevatedRoles: ['admin'] }));
        await expect(request.get({ ...read })).rejects.toBeInstanceOf(RoleElevationError);
        expect(request.isLoggedIn()).toBe(false);
        expect(calls).not.toContain('GET /api/now/table/incident');
    });

    it('refuses an invalid role name when the instance is constructed', () => {
        expect(() => new ServiceNowInstance({ elevatedRoles: ['security_admin;admin'] })).toThrow(RoleElevationError);
        expect(new ServiceNowInstance({ elevatedRoles: ['security_admin', ' security_admin '] }).elevatedRoles).toEqual(['security_admin']);
    });
});
