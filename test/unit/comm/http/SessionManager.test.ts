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

        it('returns the SAME request for the same alias', () => {
            const instance1 = createMockInstance('dev01');
            const instance2 = createMockInstance('dev01');
            const mgr = SessionManager.getInstance();

            const req1 = mgr.getRequest(instance1);
            const req2 = mgr.getRequest(instance2);

            expect(req1).toBe(req2);
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

            // Same host, same request
            const instance2 = new ServiceNowInstance({
                host: 'myhost.service-now.com',
            });
            const req2 = mgr.getRequest(instance2);
            expect(req).toBe(req2);
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
