/**
 * Unit tests for UserRequest
 * Tests getUser() with various response scenarios
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { UserRequest } from '../../../../src/sn/user/UserRequest';
import { IHttpResponse } from '../../../../src/comm/http/IHttpResponse';
import { MockAuthenticationHandler } from '../../__mocks__/servicenow-sdk-mocks';
import { AuthenticationHandlerFactory } from '../../../../src/auth/AuthenticationHandlerFactory';
import { RequestHandlerFactory } from '../../../../src/comm/http/RequestHandlerFactory';
import { SessionManager } from '../../../../src/comm/http/SessionManager';
import { ServiceNowInstance } from '../../../../src/sn/ServiceNowInstance';

// Mock factories
jest.mock('../../../../src/auth/AuthenticationHandlerFactory');
jest.mock('../../../../src/comm/http/RequestHandlerFactory');

// Mock request handler
class MockRequestHandler {
    get = jest.fn<() => Promise<IHttpResponse<unknown>>>();
    post = jest.fn<() => Promise<IHttpResponse<unknown>>>();
    put = jest.fn<() => Promise<IHttpResponse<unknown>>>();
    delete = jest.fn<() => Promise<IHttpResponse<unknown>>>();
}

describe('UserRequest', () => {
    let userRequest: UserRequest;
    let mockInstance: ServiceNowInstance;
    let mockAuthHandler: MockAuthenticationHandler;
    let mockRequestHandler: MockRequestHandler;

    const mockUserRecord = {
        sys_id: 'user123',
        user_name: 'admin',
        first_name: 'System',
        last_name: 'Administrator',
        email: 'admin@example.com',
        active: 'true',
        title: 'System Administrator'
    };

    beforeEach(() => {
        jest.clearAllMocks();
        SessionManager.resetInstance();

        mockAuthHandler = new MockAuthenticationHandler();
        mockRequestHandler = new MockRequestHandler();

        jest.spyOn(AuthenticationHandlerFactory, 'createAuthHandler')
            .mockReturnValue(mockAuthHandler as unknown as ReturnType<typeof AuthenticationHandlerFactory.createAuthHandler>);
        jest.spyOn(RequestHandlerFactory, 'createRequestHandler')
            .mockReturnValue(mockRequestHandler as unknown as ReturnType<typeof RequestHandlerFactory.createRequestHandler>);

        mockInstance = {
            getAlias: jest.fn().mockReturnValue('test-instance'),
            getHost: jest.fn().mockReturnValue('<servicenow_instance_url>')
        } as unknown as ServiceNowInstance;

        userRequest = new UserRequest(mockInstance);
    });

    describe('Constructor', () => {
        it('should create instance extending SNRequestBase', () => {
            expect(userRequest).toBeInstanceOf(UserRequest);
            expect(userRequest.snInstance).toBe(mockInstance);
        });
    });

    describe('getUser', () => {
        it('should return user when found', async () => {
            // UserRequest.getUser creates a new TableAPIRequest internally,
            // which creates a new ServiceNowRequest, so we need the mocks
            // to work for that inner request too.
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue({
                data: { result: [mockUserRecord] },
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {},
                bodyObject: { result: [mockUserRecord] }
            } as IHttpResponse<any>);

            const user = await userRequest.getUser('user123');

            expect(user).toBeDefined();
            expect(user.user_name).toBe('admin');
            expect(user.sys_id).toBe('user123');
        });

        it('should return null when user not found (empty result array)', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue({
                data: { result: [] },
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {},
                bodyObject: { result: [] }
            } as IHttpResponse<any>);

            const user = await userRequest.getUser('nonexistent');
            expect(user).toBeNull();
        });

        it('should return null when response status is not 200', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue({
                data: null,
                status: 404,
                statusText: 'Not Found',
                headers: {},
                config: {},
                bodyObject: null
            } as IHttpResponse<any>);

            const user = await userRequest.getUser('user123');
            expect(user).toBeNull();
        });

        it('should query sys_user table with sys_id filter', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue({
                data: { result: [mockUserRecord] },
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {},
                bodyObject: { result: [mockUserRecord] }
            } as IHttpResponse<any>);

            await userRequest.getUser('test-sys-id-abc');

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.path).toBe('/api/now/table/sys_user');
            expect(callArgs.query).toEqual({ sysparm_query: 'sys_id=test-sys-id-abc' });
        });

        it('should return first user when multiple results returned', async () => {
            const user1 = { ...mockUserRecord, sys_id: 'first' };
            const user2 = { ...mockUserRecord, sys_id: 'second' };

            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue({
                data: { result: [user1, user2] },
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {},
                bodyObject: { result: [user1, user2] }
            } as IHttpResponse<any>);

            const user = await userRequest.getUser('first');
            expect(user.sys_id).toBe('first');
        });
    });
});
