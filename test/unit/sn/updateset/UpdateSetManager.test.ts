/**
 * Unit tests for UpdateSetManager
 * Uses mocks instead of real credentials
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ServiceNowInstance, ServiceNowSettingsInstance } from '../../../../src/sn/ServiceNowInstance';
import { createGetCredentialsMock, MockAuthenticationHandler } from '../../__mocks__/servicenow-sdk-mocks';
import { UpdateSetManager } from '../../../../src/sn/updateset/UpdateSetManager';
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

describe('UpdateSetManager - Unit Tests', () => {
    let instance: ServiceNowInstance;
    let manager: UpdateSetManager;
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
            manager = new UpdateSetManager(instance);
        }
    });

    // ================================================================
    // Constructor
    // ================================================================
    describe('constructor', () => {
        it('should create an UpdateSetManager instance', () => {
            expect(manager).toBeDefined();
            expect(manager).toBeInstanceOf(UpdateSetManager);
        });
    });

    // ================================================================
    // setCurrentUpdateSet
    // ================================================================
    describe('setCurrentUpdateSet', () => {
        it('should set the current update set successfully', async () => {
            mockRequestHandler.put.mockResolvedValue(createMockResponse({}, 200));

            await manager.setCurrentUpdateSet({ name: 'My Update Set', sysId: 'abc123' });

            expect(mockRequestHandler.put).toHaveBeenCalledTimes(1);
            const callArgs = mockRequestHandler.put.mock.calls[0][0] as any;
            expect(callArgs.path).toBe('/api/now/ui/concoursepicker/updateset');
            expect(callArgs.json).toEqual({ name: 'My Update Set', sysId: 'abc123' });
        });

        it('should throw an error when name is empty', async () => {
            await expect(manager.setCurrentUpdateSet({ name: '', sysId: 'abc123' }))
                .rejects.toThrow('Update set name is required');
        });

        it('should throw an error when sysId is empty', async () => {
            await expect(manager.setCurrentUpdateSet({ name: 'Test', sysId: '' }))
                .rejects.toThrow('Update set sysId is required');
        });

        it('should throw an error when API returns non-200', async () => {
            mockRequestHandler.put.mockResolvedValue(createErrorResponse(403));

            await expect(manager.setCurrentUpdateSet({ name: 'Test', sysId: 'abc123' }))
                .rejects.toThrow('Failed to set current update set. Status: 403');
        });
    });

    // ================================================================
    // getCurrentUpdateSet
    // ================================================================
    describe('getCurrentUpdateSet', () => {
        it('should return the current update set mapped from concoursepicker', async () => {
            const concoursepickerData = {
                currentUpdateSet: { name: 'Default', sysId: 'set123' }
            };
            mockRequestHandler.get.mockResolvedValue(createMockResponse(concoursepickerData, 200));

            const result = await manager.getCurrentUpdateSet();

            expect(result).toEqual({ sys_id: 'set123', name: 'Default', state: 'in progress' });
            expect(mockRequestHandler.get).toHaveBeenCalledTimes(1);
            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.path).toBe('/api/now/ui/concoursepicker/current');
        });

        it('should throw an error when API returns non-200', async () => {
            mockRequestHandler.get.mockResolvedValue(createErrorResponse(500));

            await expect(manager.getCurrentUpdateSet())
                .rejects.toThrow('Failed to get current update set. Status: 500');
        });
    });

    // ================================================================
    // listUpdateSets
    // ================================================================
    describe('listUpdateSets', () => {
        it('should list update sets with default options', async () => {
            const mockSets = [
                { sys_id: 'set1', name: 'Set 1', state: 'in progress' },
                { sys_id: 'set2', name: 'Set 2', state: 'complete' }
            ];
            mockRequestHandler.get.mockResolvedValue(createMockArrayResponse(mockSets));

            const result = await manager.listUpdateSets();

            expect(result).toEqual(mockSets);
            expect(result).toHaveLength(2);
            expect(mockRequestHandler.get).toHaveBeenCalledTimes(1);
        });

        it('should pass encoded query and limit parameters', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockArrayResponse([]));

            await manager.listUpdateSets({ encodedQuery: 'state=in progress', limit: 50, fields: 'name,state' });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query).toEqual(expect.objectContaining({
                sysparm_query: 'state=in progress',
                sysparm_limit: 50,
                sysparm_fields: 'name,state'
            }));
        });

        it('should throw an error when API returns non-200', async () => {
            mockRequestHandler.get.mockResolvedValue(createErrorResponse(500));

            await expect(manager.listUpdateSets())
                .rejects.toThrow('Failed to list update sets. Status: 500');
        });
    });

    // ================================================================
    // createUpdateSet
    // ================================================================
    describe('createUpdateSet', () => {
        it('should create an update set with default state', async () => {
            const mockCreated = { sys_id: 'new123', name: 'New Set', state: 'in progress' };
            mockRequestHandler.post.mockResolvedValue(createMockResponse(mockCreated, 201));

            const result = await manager.createUpdateSet({ name: 'New Set' });

            expect(result).toEqual(mockCreated);
            expect(mockRequestHandler.post).toHaveBeenCalledTimes(1);
            const callArgs = mockRequestHandler.post.mock.calls[0][0] as any;
            expect(callArgs.json).toEqual(expect.objectContaining({
                name: 'New Set',
                state: 'in progress'
            }));
        });

        it('should create an update set with description and application', async () => {
            const mockCreated = { sys_id: 'new456', name: 'Feature Set', state: 'in progress', description: 'Test desc' };
            mockRequestHandler.post.mockResolvedValue(createMockResponse(mockCreated, 201));

            const result = await manager.createUpdateSet({
                name: 'Feature Set',
                description: 'Test desc',
                application: 'app123',
                state: 'complete'
            });

            expect(result).toEqual(mockCreated);
            const callArgs = mockRequestHandler.post.mock.calls[0][0] as any;
            expect(callArgs.json).toEqual(expect.objectContaining({
                name: 'Feature Set',
                description: 'Test desc',
                application: 'app123',
                state: 'complete'
            }));
        });

        it('should throw an error when name is empty', async () => {
            await expect(manager.createUpdateSet({ name: '' }))
                .rejects.toThrow('Update set name is required');
        });

        it('should throw an error when API returns non-200/201', async () => {
            mockRequestHandler.post.mockResolvedValue(createErrorResponse(400));

            await expect(manager.createUpdateSet({ name: 'Test' }))
                .rejects.toThrow(/Failed to create update set/);
        });
    });

    // ================================================================
    // moveRecordsToUpdateSet
    // ================================================================
    describe('moveRecordsToUpdateSet', () => {
        it('should move records by sys_id list', async () => {
            const mockRecords = [
                { sys_id: 'xml1', name: 'Record 1', type: 'sys_script', update_set: 'old_set' },
                { sys_id: 'xml2', name: 'Record 2', type: 'sys_ui_page', update_set: 'old_set' }
            ];

            // First call: GET to query records, subsequent calls: PUT for each record
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse(mockRecords));
            mockRequestHandler.put.mockResolvedValue(createMockResponse({}, 200));

            const result = await manager.moveRecordsToUpdateSet('target_set', {
                recordSysIds: ['xml1', 'xml2']
            });

            expect(result.moved).toBe(2);
            expect(result.failed).toBe(0);
            expect(result.records).toHaveLength(2);
            expect(mockRequestHandler.put).toHaveBeenCalledTimes(2);
        });

        it('should move records from a source update set', async () => {
            const mockRecords = [
                { sys_id: 'xml1', name: 'Record 1', type: 'sys_script', update_set: 'source_set' }
            ];

            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse(mockRecords));
            mockRequestHandler.put.mockResolvedValue(createMockResponse({}, 200));

            const result = await manager.moveRecordsToUpdateSet('target_set', {
                sourceUpdateSet: 'source_set'
            });

            expect(result.moved).toBe(1);
            const getCallArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(getCallArgs.query.sysparm_query).toContain('update_set=source_set');
        });

        it('should move records by time range', async () => {
            const mockRecords = [
                { sys_id: 'xml1', name: 'Record 1', type: 'sys_script', update_set: 'some_set' }
            ];

            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse(mockRecords));
            mockRequestHandler.put.mockResolvedValue(createMockResponse({}, 200));

            const result = await manager.moveRecordsToUpdateSet('target_set', {
                timeRange: { start: '2025-01-01', end: '2025-12-31' }
            });

            expect(result.moved).toBe(1);
            const getCallArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(getCallArgs.query.sysparm_query).toContain('sys_created_onBETWEEN');
        });

        it('should handle failed PUT operations', async () => {
            const mockRecords = [
                { sys_id: 'xml1', name: 'Record 1', type: 'sys_script', update_set: 'old_set' }
            ];

            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse(mockRecords));
            mockRequestHandler.put.mockResolvedValue(createErrorResponse(500));

            const result = await manager.moveRecordsToUpdateSet('target_set', {
                recordSysIds: ['xml1']
            });

            expect(result.moved).toBe(0);
            expect(result.failed).toBe(1);
            expect(result.errors).toHaveLength(1);
        });

        it('should call onProgress callback', async () => {
            const mockRecords = [
                { sys_id: 'xml1', name: 'Record 1', type: 'sys_script', update_set: 'old_set' }
            ];

            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse(mockRecords));
            mockRequestHandler.put.mockResolvedValue(createMockResponse({}, 200));

            const onProgress = jest.fn();
            await manager.moveRecordsToUpdateSet('target_set', {
                recordSysIds: ['xml1'],
                onProgress
            });

            expect(onProgress).toHaveBeenCalled();
        });

        it('should throw when targetUpdateSetId is empty', async () => {
            await expect(manager.moveRecordsToUpdateSet('', {}))
                .rejects.toThrow('Target update set ID is required');
        });

        it('should throw when no selection criteria provided', async () => {
            await expect(manager.moveRecordsToUpdateSet('target_set', {}))
                .rejects.toThrow('At least one selection criteria is required');
        });
    });

    // ================================================================
    // cloneUpdateSet
    // ================================================================
    describe('cloneUpdateSet', () => {
        it('should clone an update set successfully', async () => {
            const sourceSet = { sys_id: 'src123', name: 'Source Set', state: 'in progress', description: 'Desc' };
            const newSet = { sys_id: 'new123', name: 'Clone Set', state: 'in progress' };
            const xmlRecords = [
                { sys_id: 'xml1', name: 'Rec1', type: 'sys_script', target_name: 'test', payload: '<xml/>', category: 'customer', update_set: 'src123' },
                { sys_id: 'xml2', name: 'Rec2', type: 'sys_ui_page', target_name: 'page', payload: '<xml/>', category: 'customer', update_set: 'src123' }
            ];

            // GET source update set
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([sourceSet]));
            // POST create new update set
            mockRequestHandler.post.mockResolvedValueOnce(createMockResponse(newSet, 201));
            // GET xml records
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse(xmlRecords));
            // POST clone record 1
            mockRequestHandler.post.mockResolvedValueOnce(createMockResponse({ sys_id: 'cloned1' }, 201));
            // POST clone record 2
            mockRequestHandler.post.mockResolvedValueOnce(createMockResponse({ sys_id: 'cloned2' }, 201));

            const result = await manager.cloneUpdateSet('src123', 'Clone Set');

            expect(result.newUpdateSetId).toBe('new123');
            expect(result.newUpdateSetName).toBe('Clone Set');
            expect(result.sourceUpdateSetId).toBe('src123');
            expect(result.sourceUpdateSetName).toBe('Source Set');
            expect(result.recordsCloned).toBe(2);
            expect(result.totalSourceRecords).toBe(2);
        });

        it('should call onProgress callback during clone', async () => {
            const sourceSet = { sys_id: 'src123', name: 'Source Set', state: 'in progress' };
            const newSet = { sys_id: 'new123', name: 'Clone Set', state: 'in progress' };

            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([sourceSet]));
            mockRequestHandler.post.mockResolvedValueOnce(createMockResponse(newSet, 201));
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([]));

            const onProgress = jest.fn();
            await manager.cloneUpdateSet('src123', 'Clone Set', onProgress);

            expect(onProgress).toHaveBeenCalledWith('Fetching source update set...');
            expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('Found source update set'));
            expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('Created new update set'));
        });

        it('should throw when sourceUpdateSetId is empty', async () => {
            await expect(manager.cloneUpdateSet('', 'Clone'))
                .rejects.toThrow('Source update set ID is required');
        });

        it('should throw when newName is empty', async () => {
            await expect(manager.cloneUpdateSet('src123', ''))
                .rejects.toThrow('New update set name is required');
        });

        it('should throw when source update set is not found', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([]));

            await expect(manager.cloneUpdateSet('src123', 'Clone'))
                .rejects.toThrow("Source update set 'src123' not found");
        });

        it('should throw when creating new update set fails', async () => {
            const sourceSet = { sys_id: 'src123', name: 'Source Set', state: 'in progress' };
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([sourceSet]));
            mockRequestHandler.post.mockResolvedValueOnce(createErrorResponse(500));

            await expect(manager.cloneUpdateSet('src123', 'Clone'))
                .rejects.toThrow(/Failed to create new update set/);
        });
    });

    // ================================================================
    // inspectUpdateSet
    // ================================================================
    describe('inspectUpdateSet', () => {
        it('should inspect an update set and group by type', async () => {
            const updateSet = { sys_id: 'set123', name: 'My Set', state: 'in progress', description: 'Test' };
            const xmlRecords = [
                { sys_id: 'xml1', type: 'sys_script_include', target_name: 'ScriptA', name: 'ScriptA', update_set: 'set123' },
                { sys_id: 'xml2', type: 'sys_script_include', target_name: 'ScriptB', name: 'ScriptB', update_set: 'set123' },
                { sys_id: 'xml3', type: 'sys_ui_page', target_name: 'PageA', name: 'PageA', update_set: 'set123' }
            ];

            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([updateSet]));
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse(xmlRecords));

            const result = await manager.inspectUpdateSet('set123');

            expect(result.updateSet.sys_id).toBe('set123');
            expect(result.updateSet.name).toBe('My Set');
            expect(result.totalRecords).toBe(3);
            expect(result.components).toHaveLength(2);

            const scriptComponent = result.components.find(c => c.type === 'sys_script_include');
            expect(scriptComponent).toBeDefined();
            expect(scriptComponent!.count).toBe(2);
            expect(scriptComponent!.items).toContain('ScriptA');
            expect(scriptComponent!.items).toContain('ScriptB');

            const pageComponent = result.components.find(c => c.type === 'sys_ui_page');
            expect(pageComponent).toBeDefined();
            expect(pageComponent!.count).toBe(1);
        });

        it('should handle empty update set', async () => {
            const updateSet = { sys_id: 'set123', name: 'Empty Set', state: 'in progress' };

            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([updateSet]));
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([]));

            const result = await manager.inspectUpdateSet('set123');

            expect(result.totalRecords).toBe(0);
            expect(result.components).toHaveLength(0);
        });

        it('should throw when updateSetSysId is empty', async () => {
            await expect(manager.inspectUpdateSet(''))
                .rejects.toThrow('Update set sys_id is required');
        });

        it('should throw when update set is not found', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockArrayResponse([]));

            await expect(manager.inspectUpdateSet('nonexistent'))
                .rejects.toThrow("Update set 'nonexistent' not found");
        });
    });
});
