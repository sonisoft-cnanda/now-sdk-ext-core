/**
 * Unit tests for SessionManager singleton
 * Caches ServiceNowRequest instances keyed by instance alias
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { SessionManager } from '../../../../src/comm/http/SessionManager';
import { ServiceNowInstance } from '../../../../src/sn/ServiceNowInstance';
import { ServiceNowRequest } from '../../../../src/comm/http/ServiceNowRequest';
import { MockAuthenticationHandler } from '../../__mocks__/servicenow-sdk-mocks';

// Mock factories to prevent real auth/HTTP
import { AuthenticationHandlerFactory } from '../../../../src/auth/AuthenticationHandlerFactory';
import { RequestHandlerFactory } from '../../../../src/comm/http/RequestHandlerFactory';

jest.mock('../../../../src/auth/AuthenticationHandlerFactory');
jest.mock('../../../../src/comm/http/RequestHandlerFactory');

class MockRequestHandler {
    get = jest.fn<() => Promise<unknown>>();
    post = jest.fn<() => Promise<unknown>>();
    put = jest.fn<() => Promise<unknown>>();
    delete = jest.fn<() => Promise<unknown>>();
}

function createMockInstance(alias: string, host?: string): ServiceNowInstance {
    return new ServiceNowInstance({
        alias,
        host: host ?? `${alias}.service-now.com`,
    });
}

describe('SessionManager', () => {
    let mockAuthHandler: MockAuthenticationHandler;
    let mockRequestHandler: MockRequestHandler;

    beforeEach(() => {
        // Reset singleton between tests
        SessionManager.resetInstance();
        jest.clearAllMocks();

        mockAuthHandler = new MockAuthenticationHandler();
        mockRequestHandler = new MockRequestHandler();

        jest.spyOn(AuthenticationHandlerFactory, 'createAuthHandler')
            .mockReturnValue(mockAuthHandler as unknown as ReturnType<typeof AuthenticationHandlerFactory.createAuthHandler>);
        jest.spyOn(RequestHandlerFactory, 'createRequestHandler')
            .mockReturnValue(mockRequestHandler as unknown as ReturnType<typeof RequestHandlerFactory.createRequestHandler>);
    });

    describe('singleton', () => {
        it('returns the same instance on multiple calls', () => {
            const a = SessionManager.getInstance();
            const b = SessionManager.getInstance();
            expect(a).toBe(b);
        });

        it('returns new instance after resetInstance', () => {
            const a = SessionManager.getInstance();
            SessionManager.resetInstance();
            const b = SessionManager.getInstance();
            expect(a).not.toBe(b);
        });
    });

    describe('getRequest', () => {
        it('returns a ServiceNowRequest for a given instance', () => {
            const instance = createMockInstance('dev01');
            const mgr = SessionManager.getInstance();

            const req = mgr.getRequest(instance);

            expect(req).toBeInstanceOf(ServiceNowRequest);
        });

        it('returns the SAME request for the same instance', () => {
            const instance = createMockInstance('dev01');
            const mgr = SessionManager.getInstance();

            const req1 = mgr.getRequest(instance);
            const req2 = mgr.getRequest(instance);

            expect(req1).toBe(req2);
        });

        // This previously asserted the opposite — that a second instance object under
        // the same alias reused the first one's cached request. That was the NEX-52
        // defect: the cache key is alias-or-host, which says nothing about which
        // instance asked, so a consumer refreshing its connection (now-sdk-ext-mcp
        // evicts on a 30-minute TTL) was handed a request still holding the previous
        // session, and every subsequent call went out with the previous credentials.
        it('discards the cached request when the instance is replaced under the same alias', () => {
            const instance1 = createMockInstance('dev01');
            const instance2 = createMockInstance('dev01');
            const mgr = SessionManager.getInstance();

            const req1 = mgr.getRequest(instance1);
            const req2 = mgr.getRequest(instance2);

            expect(req1).not.toBe(req2);
            expect(req2.getInstance()).toBe(instance2);
        });

        it('returns DIFFERENT requests for different aliases', () => {
            const instance1 = createMockInstance('dev01');
            const instance2 = createMockInstance('prod01');
            const mgr = SessionManager.getInstance();

            const req1 = mgr.getRequest(instance1);
            const req2 = mgr.getRequest(instance2);

            expect(req1).not.toBe(req2);
        });

        it('falls back to host when no alias', () => {
            const instance = new ServiceNowInstance({
                host: 'myhost.service-now.com',
            });
            const mgr = SessionManager.getInstance();

            const req = mgr.getRequest(instance);
            expect(req).toBeInstanceOf(ServiceNowRequest);

            // Host still keys the cache: the same instance resolves to the same request.
            const req2 = mgr.getRequest(instance);
            expect(req).toBe(req2);

            // But a replacement instance on that host gets a fresh request, for the
            // same reason as the alias case above — identity, not just the key.
            const replacement = new ServiceNowInstance({
                host: 'myhost.service-now.com',
            });
            expect(mgr.getRequest(replacement)).not.toBe(req);
        });

        it('throws when alias and host are both missing', () => {
            const instance = new ServiceNowInstance({});
            const mgr = SessionManager.getInstance();

            expect(() => mgr.getRequest(instance)).toThrow(/alias or host/i);
        });
    });

    describe('getAuthenticatedRequest', () => {
        it('returns a ServiceNowRequest that has been logged in', async () => {
            const instance = createMockInstance('dev01');
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(false);
            const mgr = SessionManager.getInstance();

            const req = await mgr.getAuthenticatedRequest(instance);

            expect(req).toBeInstanceOf(ServiceNowRequest);
            expect(mockAuthHandler.doLogin).toHaveBeenCalled();
        });

        it('does not login again if already logged in', async () => {
            const instance = createMockInstance('dev01');
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            const mgr = SessionManager.getInstance();

            const req = await mgr.getAuthenticatedRequest(instance);

            expect(req).toBeInstanceOf(ServiceNowRequest);
            expect(mockAuthHandler.doLogin).not.toHaveBeenCalled();
        });

        it('reuses the same request across sync and async gets', async () => {
            const instance = createMockInstance('dev01');
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            const mgr = SessionManager.getInstance();

            const reqSync = mgr.getRequest(instance);
            const reqAsync = await mgr.getAuthenticatedRequest(instance);

            expect(reqSync).toBe(reqAsync);
        });

        // The in-flight guard in getAuthenticatedRequest had no coverage at all.
        // Resolution is driven manually rather than by timing, so the two calls are
        // genuinely concurrent without depending on the scheduler.
        it('authenticates once when two callers race for the same alias', async () => {
            const instance = createMockInstance('dev01');
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(false);

            let releaseLogin: () => void;
            const loginGate = new Promise<void>((resolve) => {
                releaseLogin = resolve;
            });
            mockAuthHandler.doLogin = jest.fn(() => loginGate) as any;

            const mgr = SessionManager.getInstance();
            const bothInFlight = Promise.all([
                mgr.getAuthenticatedRequest(instance),
                mgr.getAuthenticatedRequest(instance),
            ]);

            releaseLogin!();
            const [first, second] = await bothInFlight;

            expect(first).toBe(second);
            expect(mockAuthHandler.doLogin).toHaveBeenCalledTimes(1);
        });
    });

    describe('clearSession', () => {
        it('removes the cached request for a given alias', () => {
            const instance = createMockInstance('dev01');
            const mgr = SessionManager.getInstance();

            mgr.getRequest(instance);
            expect(mgr.hasSession('dev01')).toBe(true);

            mgr.clearSession('dev01');
            expect(mgr.hasSession('dev01')).toBe(false);
        });

        it('does not affect other aliases', () => {
            const mgr = SessionManager.getInstance();
            mgr.getRequest(createMockInstance('dev01'));
            mgr.getRequest(createMockInstance('prod01'));

            mgr.clearSession('dev01');

            expect(mgr.hasSession('dev01')).toBe(false);
            expect(mgr.hasSession('prod01')).toBe(true);
        });

        it('creates a new request after clear', () => {
            const instance = createMockInstance('dev01');
            const mgr = SessionManager.getInstance();

            const req1 = mgr.getRequest(instance);
            mgr.clearSession('dev01');
            const req2 = mgr.getRequest(instance);

            expect(req1).not.toBe(req2);
        });

        // clearSession used to drop the session but leave the in-flight auth promise
        // behind, so an auth started before the clear resolved after it and handed the
        // caller back the request that had just been evicted.
        it('drops an in-flight auth promise so it cannot resurrect the evicted request', async () => {
            const instance = createMockInstance('dev01');
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(false);

            let releaseLogin: () => void;
            const loginGate = new Promise<void>((resolve) => {
                releaseLogin = resolve;
            });
            mockAuthHandler.doLogin = jest.fn(() => loginGate) as any;

            const mgr = SessionManager.getInstance();
            const inFlight = mgr.getAuthenticatedRequest(instance);

            mgr.clearSession('dev01');
            releaseLogin!();
            await inFlight;

            expect((mgr as any)._authPromises.has('dev01')).toBe(false);
            // A caller arriving after the clear gets a fresh request, not the evicted one.
            expect(mgr.getRequest(instance)).not.toBe(await inFlight);
        });
    });

    describe('clearAll', () => {
        it('removes all cached sessions', () => {
            const mgr = SessionManager.getInstance();
            mgr.getRequest(createMockInstance('dev01'));
            mgr.getRequest(createMockInstance('prod01'));
            mgr.getRequest(createMockInstance('staging'));

            mgr.clearAll();

            expect(mgr.hasSession('dev01')).toBe(false);
            expect(mgr.hasSession('prod01')).toBe(false);
            expect(mgr.hasSession('staging')).toBe(false);
        });
    });

    describe('hasSession', () => {
        it('returns true for cached alias', () => {
            const mgr = SessionManager.getInstance();
            mgr.getRequest(createMockInstance('dev01'));
            expect(mgr.hasSession('dev01')).toBe(true);
        });

        it('returns false for unknown alias', () => {
            const mgr = SessionManager.getInstance();
            expect(mgr.hasSession('unknown')).toBe(false);
        });
    });
});
