/**
 * Unit tests for InstanceDiscovery
 * Tests table, app, and plugin discovery operations
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { InstanceDiscovery } from '../../../../src/sn/discovery/InstanceDiscovery';
import { IHttpResponse } from '../../../../src/comm/http/IHttpResponse';
import { MockAuthenticationHandler, createGetCredentialsMock } from '../../__mocks__/servicenow-sdk-mocks';
import { AuthenticationHandlerFactory } from '../../../../src/auth/AuthenticationHandlerFactory';
import { RequestHandlerFactory } from '../../../../src/comm/http/RequestHandlerFactory';
import { SessionManager } from '../../../../src/comm/http/SessionManager';
import { ServiceNowInstance, ServiceNowSettingsInstance } from '../../../../src/sn/ServiceNowInstance';

jest.mock('../../../../src/auth/AuthenticationHandlerFactory');
jest.mock('../../../../src/comm/http/RequestHandlerFactory');
jest.mock('@servicenow/sdk-cli/dist/auth/index.js', () => ({
    getCredentials: createGetCredentialsMock()
}));

const mockGetCredentials = createGetCredentialsMock();

class MockRequestHandler {
    get = jest.fn<() => Promise<IHttpResponse<unknown>>>();
    post = jest.fn<() => Promise<IHttpResponse<unknown>>>();
    put = jest.fn<() => Promise<IHttpResponse<unknown>>>();
    delete = jest.fn<() => Promise<IHttpResponse<unknown>>>();
}

function createMockResponse(data: unknown, status: number = 200): IHttpResponse<unknown> {
    return {
        data,
        status,
        statusText: status === 200 ? 'OK' : 'Error',
        headers: {},
        config: {},
        bodyObject: data
    };
}

describe('InstanceDiscovery - Unit Tests', () => {
    let instance: ServiceNowInstance;
    let discovery: InstanceDiscovery;
    let mockAuthHandler: MockAuthenticationHandler;
    let mockRequestHandler: MockRequestHandler;

    beforeEach(async () => {
        jest.clearAllMocks();
        SessionManager.resetInstance();

        mockAuthHandler = new MockAuthenticationHandler();
        mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
        mockRequestHandler = new MockRequestHandler();

        jest.spyOn(AuthenticationHandlerFactory, 'createAuthHandler')
            .mockReturnValue(mockAuthHandler as unknown as ReturnType<typeof AuthenticationHandlerFactory.createAuthHandler>);
        jest.spyOn(RequestHandlerFactory, 'createRequestHandler')
            .mockReturnValue(mockRequestHandler as unknown as ReturnType<typeof RequestHandlerFactory.createRequestHandler>);

        const credential = await mockGetCredentials('test-instance');
        const snSettings: ServiceNowSettingsInstance = {
            alias: 'test-instance',
            credential: credential
        };
        instance = new ServiceNowInstance(snSettings);
        discovery = new InstanceDiscovery(instance);
    });

    describe('Constructor', () => {
        it('should create instance with ServiceNow instance', () => {
            expect(discovery).toBeInstanceOf(InstanceDiscovery);
        });
    });

    describe('listTables', () => {
        it('should query sys_db_object table', async () => {
            mockRequestHandler.get.mockResolvedValue(
                createMockResponse({ result: [{ sys_id: '1', name: 'incident', label: 'Incident' }] })
            );

            await discovery.listTables();

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.path).toBe('/api/now/table/sys_db_object');
        });

        it('should apply namePrefix filter', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));

            await discovery.listTables({ namePrefix: 'cmdb_' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('nameSTARTSWITHcmdb_');
        });

        it('should apply extendableOnly filter', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));

            await discovery.listTables({ extendableOnly: true });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('is_extendable=true');
        });

        it('should apply scope filter', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));

            await discovery.listTables({ scope: 'global' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('sys_scope=global');
        });

        it('should pass limit and offset', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));

            await discovery.listTables({ limit: 50, offset: 100 });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_limit).toBe(50);
            expect(callArgs.query.sysparm_offset).toBe(100);
        });

        it('should pass fields as sysparm_fields', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));

            await discovery.listTables({ fields: ['name', 'label', 'super_class'] });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_fields).toBe('name,label,super_class');
        });

        it('should return table definitions array', async () => {
            const mockTables = [
                { sys_id: '1', name: 'incident', label: 'Incident' },
                { sys_id: '2', name: 'sys_user', label: 'User' }
            ];
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: mockTables }));

            const tables = await discovery.listTables();
            expect(tables).toHaveLength(2);
            expect(tables[0].name).toBe('incident');
        });

        it('should throw on API error', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse(null, 500));

            await expect(discovery.listTables()).rejects.toThrow('Failed to list tables');
        });
    });

    describe('listScopedApps', () => {
        it('should query sys_app table', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));

            await discovery.listScopedApps();

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.path).toBe('/api/now/table/sys_app');
        });

        it('should apply activeOnly filter', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));

            await discovery.listScopedApps({ activeOnly: true });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('active=true');
        });

        it('should apply namePrefix filter', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));

            await discovery.listScopedApps({ namePrefix: 'ITSM' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('nameSTARTSWITHITSM');
        });

        it('should throw on API error', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse(null, 500));

            await expect(discovery.listScopedApps()).rejects.toThrow('Failed to list scoped applications');
        });
    });

    describe('listStoreApps', () => {
        it('should query sys_store_app table', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));

            await discovery.listStoreApps();

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.path).toBe('/api/now/table/sys_store_app');
        });

        it('should apply activeOnly filter', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));

            await discovery.listStoreApps({ activeOnly: true });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('active=true');
        });

        it('should throw on API error', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse(null, 500));

            await expect(discovery.listStoreApps()).rejects.toThrow('Failed to list store applications');
        });
    });

    describe('listPlugins', () => {
        it('should query v_plugin table', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));

            await discovery.listPlugins();

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.path).toBe('/api/now/table/v_plugin');
        });

        it('should apply activeOnly filter', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));

            await discovery.listPlugins({ activeOnly: true });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('active=active');
        });

        it('should apply namePrefix filter', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));

            await discovery.listPlugins({ namePrefix: 'com.snc' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('nameSTARTSWITHcom.snc');
        });

        it('should return empty array on empty result', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));

            const plugins = await discovery.listPlugins();
            expect(plugins).toHaveLength(0);
        });

        it('should throw on API error', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse(null, 500));

            await expect(discovery.listPlugins()).rejects.toThrow('Failed to list plugins');
        });
    });

    describe('Combined query building', () => {
        it('should combine multiple filters with ^', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));

            await discovery.listTables({ namePrefix: 'cmdb_', extendableOnly: true, query: 'labelISNOTEMPTY' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            const query = callArgs.query.sysparm_query;
            expect(query).toContain('nameSTARTSWITHcmdb_');
            expect(query).toContain('is_extendable=true');
            expect(query).toContain('labelISNOTEMPTY');
            expect(query).toContain('^');
        });
    });
});
