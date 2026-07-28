/**
 * Unit tests for ScopeManager
 * Uses mocks instead of real credentials
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ServiceNowInstance, ServiceNowSettingsInstance } from '../../../../src/sn/ServiceNowInstance';
import { createGetCredentialsMock, MockAuthenticationHandler } from '../../__mocks__/servicenow-sdk-mocks';
import { ScopeManager } from '../../../../src/sn/scope/ScopeManager';
import { IHttpResponse } from '../../../../src/comm/http/IHttpResponse';
import { AuthenticationHandlerFactory } from '../../../../src/auth/AuthenticationHandlerFactory';
import { RequestHandlerFactory } from '../../../../src/comm/http/RequestHandlerFactory';
import { SessionManager } from '../../../../src/comm/http/SessionManager';

// Mock getCredentials
const mockGetCredentials = createGetCredentialsMock();
jest.mock('@servicenow/sdk-cli/dist/auth/index.js', () => ({
    getCredentials: mockGetCredentials
}));

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

/**
 * Creates a mock response with data and status.
 */
function createMockResponse(data: unknown, status: number = 200) {
    return {
        data: { result: data },
        status,
        statusText: status === 200 ? 'OK' : status === 201 ? 'Created' : 'Error',
        headers: {},
        config: {},
        bodyObject: { result: data }
    } as IHttpResponse<any>;
}

/**
 * Creates a mock response wrapping an array result.
 */
function createMockArrayResponse(data: unknown[], status: number = 200) {
    return {
        data: { result: data },
        status,
        statusText: 'OK',
        headers: {},
        config: {},
        bodyObject: { result: data }
    } as IHttpResponse<any>;
}

/**
 * Creates a non-200 error response.
 */
function createErrorResponse(status: number = 500) {
    return {
        data: null,
        status,
        statusText: 'Error',
        headers: {},
        config: {},
        bodyObject: null
    } as IHttpResponse<any>;
}

describe('ScopeManager - Unit Tests', () => {
    let instance: ServiceNowInstance;
    let manager: ScopeManager;
    let mockAuthHandler: MockAuthenticationHandler;
    let mockRequestHandler: MockRequestHandler;

    beforeEach(async () => {
        jest.clearAllMocks();
        SessionManager.resetInstance();

        mockAuthHandler = new MockAuthenticationHandler();
        mockRequestHandler = new MockRequestHandler();

        jest.spyOn(AuthenticationHandlerFactory, 'createAuthHandler').mockReturnValue(mockAuthHandler as any);
        jest.spyOn(RequestHandlerFactory, 'createRequestHandler').mockReturnValue(mockRequestHandler as any);

        const alias = 'test-instance';
        const credential = await mockGetCredentials(alias);
        if (credential) {
            const snSettings: ServiceNowSettingsInstance = { alias, credential };
            instance = new ServiceNowInstance(snSettings);
            manager = new ScopeManager(instance);
        }
    });

    // ================================================================
    // Constructor
    // ================================================================
    describe('constructor', () => {
        it('should create a ScopeManager instance', () => {
            expect(manager).toBeDefined();
            expect(manager).toBeInstanceOf(ScopeManager);
        });
    });

    // ================================================================
    // setCurrentApplication
    // ================================================================
    describe('setCurrentApplication', () => {
        const validSysId = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

        it('should set the current application successfully', async () => {
            const targetApp = { sys_id: validSysId, name: 'My App', scope: 'x_myapp' };

            // GET target app details (Table API -> RequestHandler.get)
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([targetApp]));
            // GET current app (concoursepicker/current -> RequestHandler.get)
            mockRequestHandler.get.mockResolvedValueOnce(createMockResponse({
                currentApplication: { name: 'Old App', scopeName: 'global', sysId: 'old_id_00000000000000000000000' }
            }));
            // PUT to concoursepicker
            mockRequestHandler.put.mockResolvedValueOnce(createMockResponse({}, 200));
            // GET verify (concoursepicker/current -> RequestHandler.get)
            mockRequestHandler.get.mockResolvedValueOnce(createMockResponse({
                currentApplication: { name: 'My App', scopeName: 'x_myapp', sysId: validSysId }
            }));

            const result = await manager.setCurrentApplication(validSysId);

            expect(result.success).toBe(true);
            expect(result.application).toBe('My App');
            expect(result.scope).toBe('x_myapp');
            expect(result.sysId).toBe(validSysId);
            expect(result.previousScope).toEqual({ sys_id: 'old_id_00000000000000000000000', name: 'Old App' });
            expect(result.verified).toBe(true);
            expect(result.warnings).toHaveLength(0);
        });

        it('should throw when appSysId is empty', async () => {
            await expect(manager.setCurrentApplication(''))
                .rejects.toThrow('Application sys_id is required');
        });

        it('should throw when appSysId is not a 32-char hex string', async () => {
            await expect(manager.setCurrentApplication('not-a-valid-sysid'))
                .rejects.toThrow('Application sys_id must be a 32-character hexadecimal string or "global"');
        });

        it('should throw when appSysId has wrong length', async () => {
            await expect(manager.setCurrentApplication('abc123'))
                .rejects.toThrow('Application sys_id must be a 32-character hexadecimal string or "global"');
        });

        it('should accept "global" as a valid sys_id for Global scope', async () => {
            const globalApp = { sys_id: 'global', name: 'Global', scope: 'global' };

            // GET target app details
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([globalApp]));
            // GET current app (before change)
            mockRequestHandler.get.mockResolvedValueOnce(createMockResponse({
                currentApplication: { name: 'My App', scopeName: 'x_myapp', sysId: validSysId }
            }));
            // PUT to concoursepicker
            mockRequestHandler.put.mockResolvedValueOnce(createMockResponse({}, 200));
            // GET verify (after change)
            mockRequestHandler.get.mockResolvedValueOnce(createMockResponse({
                currentApplication: { name: 'Global', scopeName: 'global', sysId: 'global' }
            }));

            const result = await manager.setCurrentApplication('global');

            expect(result.success).toBe(true);
            expect(result.application).toBe('Global');
            expect(result.scope).toBe('global');
            expect(result.sysId).toBe('global');
            expect(result.verified).toBe(true);
        });

        it('should accept "global" with whitespace padding', async () => {
            const globalApp = { sys_id: 'global', name: 'Global', scope: 'global' };

            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([globalApp]));
            mockRequestHandler.get.mockResolvedValueOnce(createMockResponse({
                currentApplication: { name: 'My App', scopeName: 'x_myapp', sysId: validSysId }
            }));
            mockRequestHandler.put.mockResolvedValueOnce(createMockResponse({}, 200));
            mockRequestHandler.get.mockResolvedValueOnce(createMockResponse({
                currentApplication: { name: 'Global', scopeName: 'global', sysId: 'global' }
            }));

            const result = await manager.setCurrentApplication('  global  ');

            expect(result.success).toBe(true);
            expect(result.application).toBe('Global');
        });

        it('should still reject non-hex strings that are not "global"', async () => {
            await expect(manager.setCurrentApplication('notglobal'))
                .rejects.toThrow('Application sys_id must be a 32-character hexadecimal string or "global"');
            await expect(manager.setCurrentApplication('GLOBAL'))
                .rejects.toThrow('Application sys_id must be a 32-character hexadecimal string or "global"');
            await expect(manager.setCurrentApplication('glob'))
                .rejects.toThrow('Application sys_id must be a 32-character hexadecimal string or "global"');
        });

        it('should throw when target application is not found', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([]));

            await expect(manager.setCurrentApplication(validSysId))
                .rejects.toThrow(`Application '${validSysId}' not found`);
        });

        it('should throw when PUT to concoursepicker fails', async () => {
            const targetApp = { sys_id: validSysId, name: 'My App', scope: 'x_myapp' };

            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([targetApp]));
            mockRequestHandler.get.mockResolvedValueOnce(createMockResponse({
                currentApplication: { name: 'Old', scopeName: 'global', sysId: 'old' }
            }));
            mockRequestHandler.put.mockResolvedValueOnce(createErrorResponse(403));

            await expect(manager.setCurrentApplication(validSysId))
                .rejects.toThrow('Failed to set current application. Status: 403');
        });

        it('should add warning when previous scope cannot be retrieved', async () => {
            const targetApp = { sys_id: validSysId, name: 'My App', scope: 'x_myapp' };

            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([targetApp]));
            // getCurrentApplication throws
            mockRequestHandler.get.mockResolvedValueOnce(createErrorResponse(500));
            // PUT succeeds
            mockRequestHandler.put.mockResolvedValueOnce(createMockResponse({}, 200));
            // Verification succeeds
            mockRequestHandler.get.mockResolvedValueOnce(createMockResponse({
                currentApplication: { name: 'My App', scopeName: 'x_myapp', sysId: validSysId }
            }));

            const result = await manager.setCurrentApplication(validSysId);

            expect(result.success).toBe(true);
            expect(result.warnings.length).toBeGreaterThan(0);
            expect(result.warnings[0]).toContain('Could not retrieve previous scope');
        });

        it('should add warning when verification fails', async () => {
            const targetApp = { sys_id: validSysId, name: 'My App', scope: 'x_myapp' };

            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([targetApp]));
            mockRequestHandler.get.mockResolvedValueOnce(createMockResponse({
                currentApplication: { name: 'Old', scopeName: 'global', sysId: 'old_id' }
            }));
            mockRequestHandler.put.mockResolvedValueOnce(createMockResponse({}, 200));
            // Verification returns a different app
            mockRequestHandler.get.mockResolvedValueOnce(createMockResponse({
                currentApplication: { name: 'Other', scopeName: 'other', sysId: 'different_id' }
            }));

            const result = await manager.setCurrentApplication(validSysId);

            expect(result.success).toBe(true);
            expect(result.verified).toBe(false);
            expect(result.warnings).toContain('Scope change could not be verified — current app does not match target');
        });
    });

    // ================================================================
    // getCurrentApplication
    // ================================================================
    describe('getCurrentApplication', () => {
        it('should return the current application mapped from concoursepicker', async () => {
            const concoursepickerData = {
                currentApplication: { name: 'Global', scopeName: 'global', sysId: 'app123' }
            };
            mockRequestHandler.get.mockResolvedValue(createMockResponse(concoursepickerData));

            const result = await manager.getCurrentApplication();

            expect(result).toEqual({ sys_id: 'app123', name: 'Global', scope: 'global' });
            expect(mockRequestHandler.get).toHaveBeenCalledTimes(1);
            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.path).toBe('/api/now/ui/concoursepicker/current');
        });

        it('should throw an error when API returns non-200', async () => {
            mockRequestHandler.get.mockResolvedValue(createErrorResponse(401));

            await expect(manager.getCurrentApplication())
                .rejects.toThrow('Failed to get current application. Status: 401');
        });
    });

    // ================================================================
    // listApplications
    // ================================================================
    describe('listApplications', () => {
        it('should list applications with default options', async () => {
            const mockApps = [
                { sys_id: 'app1', name: 'App 1', scope: 'x_app1' },
                { sys_id: 'app2', name: 'App 2', scope: 'x_app2' }
            ];
            mockRequestHandler.get.mockResolvedValue(createMockArrayResponse(mockApps));

            const result = await manager.listApplications();

            expect(result).toEqual(mockApps);
            expect(result).toHaveLength(2);
        });

        it('should pass encoded query and limit', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockArrayResponse([]));

            await manager.listApplications({ encodedQuery: 'active=true', limit: 25 });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query).toEqual(expect.objectContaining({
                sysparm_query: 'active=true',
                sysparm_limit: 25
            }));
        });

        it('should throw an error when API returns non-200', async () => {
            mockRequestHandler.get.mockResolvedValue(createErrorResponse(500));

            await expect(manager.listApplications())
                .rejects.toThrow('Failed to list applications. Status: 500');
        });
    });

    // ================================================================
    // getApplication
    // ================================================================
    describe('getApplication', () => {
        it('should return an application by sys_id', async () => {
            const mockApp = { sys_id: 'app123', name: 'My App', scope: 'x_myapp', version: '1.0.0' };
            mockRequestHandler.get.mockResolvedValue(createMockArrayResponse([mockApp]));

            const result = await manager.getApplication('app123');

            expect(result).toEqual(mockApp);
            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toBe('sys_id=app123');
        });

        it('should return null when application is not found', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockArrayResponse([]));

            const result = await manager.getApplication('nonexistent');

            expect(result).toBeNull();
        });

        it('should throw when sysId is empty', async () => {
            await expect(manager.getApplication(''))
                .rejects.toThrow('Application sys_id is required');
        });

        it('should throw when API returns non-200', async () => {
            mockRequestHandler.get.mockResolvedValue(createErrorResponse(500));

            await expect(manager.getApplication('app123'))
                .rejects.toThrow("Failed to get application 'app123'. Status: 500");
        });
    });
});
