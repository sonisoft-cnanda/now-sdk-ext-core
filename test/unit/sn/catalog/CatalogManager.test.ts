/**
 * Unit tests for CatalogManager
 * Uses mocks instead of real credentials
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ServiceNowInstance, ServiceNowSettingsInstance } from '../../../../src/sn/ServiceNowInstance';
import { createGetCredentialsMock, MockAuthenticationHandler } from '../../__mocks__/servicenow-sdk-mocks';
import { CatalogManager, VARIABLE_TYPE_MAP, getVariableTypeName } from '../../../../src/sn/catalog/CatalogManager';
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

function createMockResponse(data: any, status: number = 200) {
    return {
        data: { result: data },
        status,
        statusText: 'OK',
        headers: {},
        config: {},
        bodyObject: { result: data }
    } as IHttpResponse<any>;
}

function createMockListResponse(data: any[], status: number = 200) {
    return {
        data: { result: data },
        status,
        statusText: 'OK',
        headers: {},
        config: {},
        bodyObject: { result: data }
    } as IHttpResponse<any>;
}

function createMockStatsResponse(count: number, status: number = 200) {
    return {
        data: { result: { stats: { count: String(count) } } },
        status,
        statusText: 'OK',
        headers: {},
        config: {},
        bodyObject: { result: { stats: { count: String(count) } } }
    } as IHttpResponse<any>;
}

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

describe('CatalogManager - Unit Tests', () => {
    let instance: ServiceNowInstance;
    let catalogMgr: CatalogManager;
    let mockAuthHandler: MockAuthenticationHandler;
    let mockRequestHandler: MockRequestHandler;

    beforeEach(async () => {
        jest.clearAllMocks();
        SessionManager.resetInstance();

        mockAuthHandler = new MockAuthenticationHandler();
        mockRequestHandler = new MockRequestHandler();

        jest.spyOn(AuthenticationHandlerFactory, 'createAuthHandler')
            .mockReturnValue(mockAuthHandler as unknown as ReturnType<typeof AuthenticationHandlerFactory.createAuthHandler>);
        jest.spyOn(RequestHandlerFactory, 'createRequestHandler')
            .mockReturnValue(mockRequestHandler as unknown as ReturnType<typeof RequestHandlerFactory.createRequestHandler>);

        const alias = 'test-instance';
        const credential = await mockGetCredentials(alias);

        if (credential) {
            const snSettings: ServiceNowSettingsInstance = {
                alias: alias,
                credential: credential
            };
            instance = new ServiceNowInstance(snSettings);
            catalogMgr = new CatalogManager(instance);
        }
    });

    // ============================================================
    // Constructor
    // ============================================================

    describe('Constructor', () => {
        it('should create instance with ServiceNow instance', () => {
            expect(catalogMgr).toBeInstanceOf(CatalogManager);
            expect((catalogMgr as any)._instance).toBe(instance);
        });

        it('should initialize logger', () => {
            expect((catalogMgr as any)._logger).toBeDefined();
        });

        it('should initialize TableAPIRequest', () => {
            expect((catalogMgr as any)._tableAPI).toBeDefined();
        });

        it('should initialize AggregateQuery', () => {
            expect((catalogMgr as any)._aggregateQuery).toBeDefined();
        });

        it('should initialize ServiceNowRequest', () => {
            expect((catalogMgr as any)._req).toBeDefined();
        });
    });

    // ============================================================
    // Static utilities
    // ============================================================

    describe('VARIABLE_TYPE_MAP', () => {
        it('should map known type codes', () => {
            expect(VARIABLE_TYPE_MAP['1']).toBe('Yes/No');
            expect(VARIABLE_TYPE_MAP['6']).toBe('Single Line Text');
            expect(VARIABLE_TYPE_MAP['8']).toBe('Reference');
            expect(VARIABLE_TYPE_MAP['21']).toBe('List Collector');
        });
    });

    describe('getVariableTypeName', () => {
        it('should return friendly name for known type', () => {
            expect(getVariableTypeName('6')).toBe('Single Line Text');
        });

        it('should return Unknown for undefined type', () => {
            expect(getVariableTypeName(undefined)).toBe('Unknown');
        });

        it('should return Unknown (code) for unknown type', () => {
            expect(getVariableTypeName('999')).toBe('Unknown (999)');
        });
    });

    // ============================================================
    // listCatalogItems
    // ============================================================

    describe('listCatalogItems', () => {
        it('should return catalog items with default options', async () => {
            const mockItems = [
                { sys_id: 'item1', name: 'Standard Laptop', active: 'true' },
                { sys_id: 'item2', name: 'VM Provisioning', active: 'true' }
            ];
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse(mockItems));

            const result = await catalogMgr.listCatalogItems();

            expect(result).toHaveLength(2);
            expect(result[0].sys_id).toBe('item1');
            expect(mockRequestHandler.get).toHaveBeenCalledTimes(1);
        });

        it('should pass active filter', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await catalogMgr.listCatalogItems({ active: true });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('active=true');
        });

        it('should pass text search with LIKE on name and short_description', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await catalogMgr.listCatalogItems({ textSearch: 'laptop' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('nameLIKElaptop');
            expect(callArgs.query.sysparm_query).toContain('short_descriptionLIKElaptop');
        });

        it('should filter by category', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await catalogMgr.listCatalogItems({ categorySysId: 'cat1' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('category=cat1');
        });

        it('should filter by catalog', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await catalogMgr.listCatalogItems({ catalogSysId: 'sc1' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('sc_catalogs=sc1');
        });

        it('should pass limit and offset', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await catalogMgr.listCatalogItems({ limit: 10, offset: 5 });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_limit).toBe(10);
            expect(callArgs.query.sysparm_offset).toBe(5);
        });

        it('should include sysparm_fields', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await catalogMgr.listCatalogItems();

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_fields).toBeDefined();
            expect(callArgs.query.sysparm_fields).toContain('sys_id');
            expect(callArgs.query.sysparm_fields).toContain('name');
        });

        it('should pass custom query string', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await catalogMgr.listCatalogItems({ query: 'sys_created_on>2024-01-01' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('sys_created_on>2024-01-01');
        });

        it('should throw error with unknown status when response is null', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(null as any);

            await expect(catalogMgr.listCatalogItems())
                .rejects.toThrow('Failed to list catalog items. Status: unknown');
        });

        it('should throw error on failed API call', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createErrorResponse(500));

            await expect(catalogMgr.listCatalogItems())
                .rejects.toThrow('Failed to list catalog items');
        });
    });

    // ============================================================
    // getCatalogItem
    // ============================================================

    describe('getCatalogItem', () => {
        it('should return item detail with variables', async () => {
            const mockItem = { sys_id: 'item1', name: 'Standard Laptop', active: 'true' };
            const mockVars = [
                { sys_id: 'var1', name: 'os', type: '5', order: '100' },
                { sys_id: 'var2', name: 'ram', type: '6', order: '200' }
            ];
            // First call: get catalog item
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([mockItem]));
            // Second call: get direct variables
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse(mockVars));
            // Third call: get variable set items (empty)
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            const result = await catalogMgr.getCatalogItem('item1');

            expect(result.item.sys_id).toBe('item1');
            expect(result.variables).toHaveLength(2);
            expect(result.variables[0].friendly_type).toBe('Select Box');
            expect(result.variables[1].friendly_type).toBe('Single Line Text');
        });

        it('should return item without variables when includeVariables is false', async () => {
            const mockItem = { sys_id: 'item1', name: 'Standard Laptop', active: 'true' };
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([mockItem]));

            const result = await catalogMgr.getCatalogItem('item1', false);

            expect(result.item.sys_id).toBe('item1');
            expect(result.variables).toHaveLength(0);
            // Only 1 GET call (no variable fetching)
            expect(mockRequestHandler.get).toHaveBeenCalledTimes(1);
        });

        it('should include variable set variables', async () => {
            const mockItem = { sys_id: 'item1', name: 'VM Provisioning', active: 'true' };
            const mockDirectVars = [
                { sys_id: 'var1', name: 'hostname', type: '6', order: '100' }
            ];
            const mockSetItems = [
                { sys_id: 'si1', sc_cat_item: 'item1', variable_set: 'vs1' }
            ];
            const mockSetVars = [
                { sys_id: 'var2', name: 'cpu_count', type: '6', order: '200', variable_set: 'vs1' }
            ];

            // Get catalog item
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([mockItem]));
            // Get direct variables
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse(mockDirectVars));
            // Get variable set items
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse(mockSetItems));
            // Get variable set variables
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse(mockSetVars));

            const result = await catalogMgr.getCatalogItem('item1');

            expect(result.variables).toHaveLength(2);
            expect(result.variables[0].name).toBe('hostname');
            expect(result.variables[1].name).toBe('cpu_count');
        });

        it('should deduplicate variables by sys_id', async () => {
            const mockItem = { sys_id: 'item1', name: 'Test Item', active: 'true' };
            const mockDirectVars = [
                { sys_id: 'var1', name: 'field1', type: '6', order: '100' }
            ];
            const mockSetItems = [
                { sys_id: 'si1', sc_cat_item: 'item1', variable_set: 'vs1' }
            ];
            // Same sys_id as direct var
            const mockSetVars = [
                { sys_id: 'var1', name: 'field1', type: '6', order: '100', variable_set: 'vs1' }
            ];

            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([mockItem]));
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse(mockDirectVars));
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse(mockSetItems));
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse(mockSetVars));

            const result = await catalogMgr.getCatalogItem('item1');

            expect(result.variables).toHaveLength(1);
        });

        it('should sort variables by order field', async () => {
            const mockItem = { sys_id: 'item1', name: 'Test Item', active: 'true' };
            const mockDirectVars = [
                { sys_id: 'var1', name: 'second', type: '6', order: '200' },
                { sys_id: 'var2', name: 'first', type: '6', order: '100' }
            ];

            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([mockItem]));
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse(mockDirectVars));
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            const result = await catalogMgr.getCatalogItem('item1');

            expect(result.variables[0].name).toBe('first');
            expect(result.variables[1].name).toBe('second');
        });

        it('should handle variables with missing order field', async () => {
            const mockItem = { sys_id: 'item1', name: 'Test Item', active: 'true' };
            const mockDirectVars = [
                { sys_id: 'var1', name: 'has_order', type: '6', order: '100' },
                { sys_id: 'var2', name: 'no_order', type: '6' }
            ];

            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([mockItem]));
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse(mockDirectVars));
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            const result = await catalogMgr.getCatalogItem('item1');

            expect(result.variables).toHaveLength(2);
            // Variable without order (defaults to 0) sorts first
            expect(result.variables[0].name).toBe('no_order');
            expect(result.variables[1].name).toBe('has_order');
        });

        it('should throw error with unknown status when response is null', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(null as any);

            await expect(catalogMgr.getCatalogItem('item1'))
                .rejects.toThrow("Catalog item 'item1' not found. Status: unknown");
        });

        it('should throw error if sysId is empty', async () => {
            await expect(catalogMgr.getCatalogItem(''))
                .rejects.toThrow('Catalog item sys_id is required');
        });

        it('should throw error when item not found', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await expect(catalogMgr.getCatalogItem('nonexistent'))
                .rejects.toThrow("Catalog item 'nonexistent' not found");
        });

        it('should throw error on failed API call', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createErrorResponse(500));

            await expect(catalogMgr.getCatalogItem('item1'))
                .rejects.toThrow("Catalog item 'item1' not found");
        });
    });

    // ============================================================
    // listCatalogCategories
    // ============================================================

    describe('listCatalogCategories', () => {
        it('should return categories with default options', async () => {
            const mockCategories = [
                { sys_id: 'cat1', title: 'Hardware', active: 'true' },
                { sys_id: 'cat2', title: 'Software', active: 'true' }
            ];
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse(mockCategories));

            const result = await catalogMgr.listCatalogCategories();

            expect(result).toHaveLength(2);
            expect(result[0].title).toBe('Hardware');
        });

        it('should filter by parent category', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await catalogMgr.listCatalogCategories({ parentSysId: 'cat-parent' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('parent=cat-parent');
        });

        it('should filter by catalog', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await catalogMgr.listCatalogCategories({ catalogSysId: 'sc1' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('sc_catalog=sc1');
        });

        it('should filter by active status', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await catalogMgr.listCatalogCategories({ active: true });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('active=true');
        });

        it('should filter by title', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await catalogMgr.listCatalogCategories({ title: 'Hardware' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('title=Hardware');
        });

        it('should pass limit and offset', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await catalogMgr.listCatalogCategories({ limit: 50, offset: 10 });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_limit).toBe(50);
            expect(callArgs.query.sysparm_offset).toBe(10);
        });

        it('should pass custom query string', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await catalogMgr.listCatalogCategories({ query: 'orderGT5' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_query).toContain('orderGT5');
        });

        it('should throw error with unknown status when response is null', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(null as any);

            await expect(catalogMgr.listCatalogCategories())
                .rejects.toThrow('Failed to list catalog categories. Status: unknown');
        });

        it('should throw error on failed API call', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createErrorResponse(500));

            await expect(catalogMgr.listCatalogCategories())
                .rejects.toThrow('Failed to list catalog categories');
        });
    });

    // ============================================================
    // getCatalogCategory
    // ============================================================

    describe('getCatalogCategory', () => {
        it('should return category detail with item count', async () => {
            const mockCategory = { sys_id: 'cat1', title: 'Hardware', active: 'true' };
            // First call: table API for category record
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([mockCategory]));
            // Second call: stats API for item count
            mockRequestHandler.get.mockResolvedValueOnce(createMockStatsResponse(15));

            const result = await catalogMgr.getCatalogCategory('cat1');

            expect(result.category.sys_id).toBe('cat1');
            expect(result.itemCount).toBe(15);
        });

        it('should throw error if sysId is empty', async () => {
            await expect(catalogMgr.getCatalogCategory(''))
                .rejects.toThrow('Catalog category sys_id is required');
        });

        it('should throw error when category not found', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await expect(catalogMgr.getCatalogCategory('nonexistent'))
                .rejects.toThrow("Catalog category 'nonexistent' not found");
        });

        it('should throw error on failed API call', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createErrorResponse(500));

            await expect(catalogMgr.getCatalogCategory('cat1'))
                .rejects.toThrow("Catalog category 'cat1' not found");
        });

        it('should throw error with unknown status when response is null', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(null as any);

            await expect(catalogMgr.getCatalogCategory('cat1'))
                .rejects.toThrow("Catalog category 'cat1' not found. Status: unknown");
        });
    });

    // ============================================================
    // listCatalogItemVariables
    // ============================================================

    describe('listCatalogItemVariables', () => {
        it('should return variables with friendly_type enrichment', async () => {
            const mockVars = [
                { sys_id: 'var1', name: 'os_choice', type: '5', order: '100' },
                { sys_id: 'var2', name: 'hostname', type: '6', order: '200' }
            ];
            // Direct variables
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse(mockVars));
            // Variable set items (empty)
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            const result = await catalogMgr.listCatalogItemVariables({
                catalogItemSysId: 'item1'
            });

            expect(result).toHaveLength(2);
            expect(result[0].friendly_type).toBe('Select Box');
            expect(result[1].friendly_type).toBe('Single Line Text');
        });

        it('should include variable set variables by default', async () => {
            const mockDirectVars = [
                { sys_id: 'var1', name: 'field1', type: '6', order: '100' }
            ];
            const mockSetItems = [
                { sys_id: 'si1', sc_cat_item: 'item1', variable_set: 'vs1' }
            ];
            const mockSetVars = [
                { sys_id: 'var2', name: 'field2', type: '6', order: '200', variable_set: 'vs1' }
            ];

            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse(mockDirectVars));
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse(mockSetItems));
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse(mockSetVars));

            const result = await catalogMgr.listCatalogItemVariables({
                catalogItemSysId: 'item1'
            });

            expect(result).toHaveLength(2);
        });

        it('should exclude variable set variables when includeVariableSets is false', async () => {
            const mockDirectVars = [
                { sys_id: 'var1', name: 'field1', type: '6', order: '100' }
            ];

            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse(mockDirectVars));

            const result = await catalogMgr.listCatalogItemVariables({
                catalogItemSysId: 'item1',
                includeVariableSets: false
            });

            expect(result).toHaveLength(1);
            // Only 1 GET call (no variable set query)
            expect(mockRequestHandler.get).toHaveBeenCalledTimes(1);
        });

        it('should throw error if catalogItemSysId is empty', async () => {
            await expect(catalogMgr.listCatalogItemVariables({
                catalogItemSysId: ''
            })).rejects.toThrow('Catalog item sys_id is required');
        });
    });

    // ============================================================
    // submitCatalogRequest
    // ============================================================

    describe('submitCatalogRequest', () => {
        it('should submit request and return REQ + RITM', async () => {
            const orderResult = {
                sys_id: 'req-sys-id',
                number: 'REQ0010001',
                request_number: 'REQ0010001',
                request_id: 'req-sys-id',
                table: 'sc_request'
            };
            const ritmResult = [
                { sys_id: 'ritm-sys-id', number: 'RITM0010001' }
            ];

            // First call: order_now POST
            mockRequestHandler.post.mockResolvedValueOnce(createMockResponse(orderResult));
            // Second call: RITM lookup GET
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse(ritmResult));

            const result = await catalogMgr.submitCatalogRequest({
                catalogItemSysId: 'item1',
                quantity: 1,
                variables: { acrobat: 'false', photoshop: 'true' }
            });

            expect(result.requestNumber).toBe('REQ0010001');
            expect(result.requestSysId).toBe('req-sys-id');
            expect(result.requestItemNumber).toBe('RITM0010001');
            expect(result.requestItemSysId).toBe('ritm-sys-id');
        });

        it('should use default quantity of 1', async () => {
            const orderResult = {
                sys_id: 'req-sys-id',
                number: 'REQ0010001',
                request_number: 'REQ0010001',
                request_id: 'req-sys-id',
                table: 'sc_request'
            };

            mockRequestHandler.post.mockResolvedValueOnce(createMockResponse(orderResult));
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await catalogMgr.submitCatalogRequest({
                catalogItemSysId: 'item1'
            });

            const callArgs = mockRequestHandler.post.mock.calls[0][0] as any;
            expect(callArgs.json.sysparm_quantity).toBe(1);
        });

        it('should pass variables in request body', async () => {
            const orderResult = {
                sys_id: 'req-sys-id',
                number: 'REQ0010001',
                request_number: 'REQ0010001',
                request_id: 'req-sys-id',
                table: 'sc_request'
            };

            mockRequestHandler.post.mockResolvedValueOnce(createMockResponse(orderResult));
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await catalogMgr.submitCatalogRequest({
                catalogItemSysId: 'item1',
                variables: { os: 'windows', ram: '16gb' }
            });

            const callArgs = mockRequestHandler.post.mock.calls[0][0] as any;
            expect(callArgs.json.variables).toEqual({ os: 'windows', ram: '16gb' });
        });

        it('should succeed even if RITM fetch fails', async () => {
            const orderResult = {
                sys_id: 'req-sys-id',
                number: 'REQ0010001',
                request_number: 'REQ0010001',
                request_id: 'req-sys-id',
                table: 'sc_request'
            };

            mockRequestHandler.post.mockResolvedValueOnce(createMockResponse(orderResult));
            mockRequestHandler.get.mockRejectedValueOnce(new Error('Network error'));

            const result = await catalogMgr.submitCatalogRequest({
                catalogItemSysId: 'item1'
            });

            expect(result.requestNumber).toBe('REQ0010001');
            expect(result.requestSysId).toBe('req-sys-id');
            expect(result.requestItemNumber).toBeUndefined();
            expect(result.requestItemSysId).toBeUndefined();
        });

        it('should succeed when RITM is not yet available', async () => {
            const orderResult = {
                sys_id: 'req-sys-id',
                number: 'REQ0010001',
                request_number: 'REQ0010001',
                request_id: 'req-sys-id',
                table: 'sc_request'
            };

            mockRequestHandler.post.mockResolvedValueOnce(createMockResponse(orderResult));
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            const result = await catalogMgr.submitCatalogRequest({
                catalogItemSysId: 'item1'
            });

            expect(result.requestNumber).toBe('REQ0010001');
            expect(result.requestItemNumber).toBeUndefined();
        });

        it('should throw error if catalogItemSysId is empty', async () => {
            await expect(catalogMgr.submitCatalogRequest({
                catalogItemSysId: ''
            })).rejects.toThrow('Catalog item sys_id is required');
        });

        it('should fall back to number/sys_id when request_number/request_id are absent', async () => {
            const orderResult = {
                sys_id: 'fallback-sys-id',
                number: 'REQ0010099',
                table: 'sc_request'
            };

            mockRequestHandler.post.mockResolvedValueOnce(createMockResponse(orderResult));
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            const result = await catalogMgr.submitCatalogRequest({
                catalogItemSysId: 'item1'
            });

            expect(result.requestNumber).toBe('REQ0010099');
            expect(result.requestSysId).toBe('fallback-sys-id');
        });

        it('should throw error with unknown status when response is null', async () => {
            mockRequestHandler.post.mockResolvedValueOnce(null as any);

            await expect(catalogMgr.submitCatalogRequest({
                catalogItemSysId: 'item1'
            })).rejects.toThrow('Failed to submit catalog request. Status: unknown');
        });

        it('should throw error on failed order_now API call', async () => {
            mockRequestHandler.post.mockResolvedValueOnce(createErrorResponse(500));

            await expect(catalogMgr.submitCatalogRequest({
                catalogItemSysId: 'item1'
            })).rejects.toThrow('Failed to submit catalog request');
        });

        it('should use correct order_now URL', async () => {
            const orderResult = {
                sys_id: 'req-sys-id',
                number: 'REQ0010001',
                request_number: 'REQ0010001',
                request_id: 'req-sys-id',
                table: 'sc_request'
            };

            mockRequestHandler.post.mockResolvedValueOnce(createMockResponse(orderResult));
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            await catalogMgr.submitCatalogRequest({
                catalogItemSysId: 'item1'
            });

            const callArgs = mockRequestHandler.post.mock.calls[0][0] as any;
            expect(callArgs.path).toBe('/api/sn_sc/servicecatalog/items/item1/order_now');
        });
    });
});
