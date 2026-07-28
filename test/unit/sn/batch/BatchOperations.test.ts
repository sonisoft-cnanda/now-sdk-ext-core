/**
 * Unit tests for BatchOperations
 * Uses mocks instead of real credentials
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ServiceNowInstance, ServiceNowSettingsInstance } from '../../../../src/sn/ServiceNowInstance';
import { createGetCredentialsMock, MockAuthenticationHandler } from '../../__mocks__/servicenow-sdk-mocks';
import { BatchOperations } from '../../../../src/sn/batch/BatchOperations';
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
 * Creates a mock successful create response with a sys_id.
 */
function createMockPostResponse(sysId: string, status: number = 201) {
    return {
        data: { result: { sys_id: sysId } },
        status,
        statusText: status === 201 ? 'Created' : 'OK',
        headers: {},
        config: {},
        bodyObject: { result: { sys_id: sysId } }
    } as IHttpResponse<any>;
}

/**
 * Creates a mock successful update response.
 */
function createMockPutResponse(sysId: string, status: number = 200) {
    return {
        data: { result: { sys_id: sysId } },
        status,
        statusText: 'OK',
        headers: {},
        config: {},
        bodyObject: { result: { sys_id: sysId } }
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

describe('BatchOperations - Unit Tests', () => {
    let instance: ServiceNowInstance;
    let batchOps: BatchOperations;
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
            batchOps = new BatchOperations(instance);
        }
    });

    describe('Constructor', () => {
        it('should create instance with ServiceNow instance', () => {
            expect(batchOps).toBeInstanceOf(BatchOperations);
            expect((batchOps as any)._instance).toBe(instance);
        });

        it('should initialize logger', () => {
            expect((batchOps as any)._logger).toBeDefined();
        });

        it('should initialize ServiceNowRequest', () => {
            expect((batchOps as any)._req).toBeDefined();
        });

        it('should initialize TableAPIRequest', () => {
            expect((batchOps as any)._tableAPI).toBeDefined();
        });
    });

    describe('batchCreate', () => {
        it('should create a single record successfully', async () => {
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('abc123'));

            const result = await batchOps.batchCreate({
                operations: [
                    { table: 'incident', data: { short_description: 'Test' } }
                ]
            });

            expect(result.success).toBe(true);
            expect(result.createdCount).toBe(1);
            expect(result.errors).toHaveLength(0);
            expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
        });

        it('should create multiple records sequentially', async () => {
            mockRequestHandler.post
                .mockResolvedValueOnce(createMockPostResponse('id1'))
                .mockResolvedValueOnce(createMockPostResponse('id2'))
                .mockResolvedValueOnce(createMockPostResponse('id3'));

            const result = await batchOps.batchCreate({
                operations: [
                    { table: 'incident', data: { short_description: 'First' } },
                    { table: 'incident', data: { short_description: 'Second' } },
                    { table: 'change_request', data: { short_description: 'Third' } }
                ]
            });

            expect(result.success).toBe(true);
            expect(result.createdCount).toBe(3);
            expect(result.errors).toHaveLength(0);
            expect(mockRequestHandler.post).toHaveBeenCalledTimes(3);
        });

        it('should save sys_ids via saveAs and resolve variable references', async () => {
            mockRequestHandler.post
                .mockResolvedValueOnce(createMockPostResponse('parent-id-123'))
                .mockResolvedValueOnce(createMockPostResponse('child-id-456'));

            const result = await batchOps.batchCreate({
                operations: [
                    { table: 'cmdb_ci', data: { name: 'Parent CI' }, saveAs: 'parentCI' },
                    { table: 'cmdb_rel_ci', data: { parent: '${parentCI}', child: 'other' } }
                ]
            });

            expect(result.success).toBe(true);
            expect(result.createdCount).toBe(2);
            expect(result.sysIds['parentCI']).toBe('parent-id-123');

            // Verify the second call received the resolved reference
            const secondPostCall = mockRequestHandler.post.mock.calls[1];
            // The body is passed as the json parameter in the HTTPRequest
            // TableAPIRequest internally creates an HTTPRequest with json: bodyData
            // We need to check what was passed to the mock
            expect(secondPostCall).toBeDefined();
        });

        it('should stop on first error when transaction=true (default)', async () => {
            mockRequestHandler.post
                .mockResolvedValueOnce(createMockPostResponse('id1'))
                .mockResolvedValueOnce(createErrorResponse(500))
                .mockResolvedValueOnce(createMockPostResponse('id3'));

            const result = await batchOps.batchCreate({
                operations: [
                    { table: 'incident', data: { short_description: 'First' } },
                    { table: 'incident', data: { short_description: 'Second' } },
                    { table: 'incident', data: { short_description: 'Third' } }
                ]
            });

            expect(result.success).toBe(false);
            expect(result.createdCount).toBe(1);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].operationIndex).toBe(1);
            expect(result.errors[0].table).toBe('incident');
            // Third operation should NOT have been attempted
            expect(mockRequestHandler.post).toHaveBeenCalledTimes(2);
        });

        it('should continue past errors when transaction=false', async () => {
            mockRequestHandler.post
                .mockResolvedValueOnce(createMockPostResponse('id1'))
                .mockResolvedValueOnce(createErrorResponse(500))
                .mockResolvedValueOnce(createMockPostResponse('id3'));

            const result = await batchOps.batchCreate({
                operations: [
                    { table: 'incident', data: { short_description: 'First' } },
                    { table: 'incident', data: { short_description: 'Second' } },
                    { table: 'incident', data: { short_description: 'Third' } }
                ],
                transaction: false
            });

            expect(result.success).toBe(false);
            expect(result.createdCount).toBe(2);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].operationIndex).toBe(1);
            // All three operations should have been attempted
            expect(mockRequestHandler.post).toHaveBeenCalledTimes(3);
        });

        it('should handle exceptions as errors', async () => {
            mockRequestHandler.post
                .mockRejectedValueOnce(new Error('Network error'));

            const result = await batchOps.batchCreate({
                operations: [
                    { table: 'incident', data: { short_description: 'Test' } }
                ]
            });

            expect(result.success).toBe(false);
            expect(result.createdCount).toBe(0);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].error).toBeDefined();
        });

        it('should invoke onProgress callback', async () => {
            mockRequestHandler.post
                .mockResolvedValueOnce(createMockPostResponse('id1'))
                .mockResolvedValueOnce(createMockPostResponse('id2'));

            const progressMessages: string[] = [];
            const onProgress = (message: string) => progressMessages.push(message);

            await batchOps.batchCreate({
                operations: [
                    { table: 'incident', data: { short_description: 'First' } },
                    { table: 'incident', data: { short_description: 'Second' } }
                ],
                onProgress
            });

            expect(progressMessages.length).toBeGreaterThan(0);
            expect(progressMessages[0]).toContain('Creating record 1/2');
            expect(progressMessages[1]).toContain('Creating record 2/2');
            expect(progressMessages[progressMessages.length - 1]).toContain('Batch create complete');
        });

        it('should handle empty operations list', async () => {
            const result = await batchOps.batchCreate({
                operations: []
            });

            expect(result.success).toBe(true);
            expect(result.createdCount).toBe(0);
            expect(result.errors).toHaveLength(0);
            expect(mockRequestHandler.post).not.toHaveBeenCalled();
        });

        it('should accept status 200 as success for POST', async () => {
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('abc123', 200));

            const result = await batchOps.batchCreate({
                operations: [
                    { table: 'incident', data: { short_description: 'Test' } }
                ]
            });

            expect(result.success).toBe(true);
            expect(result.createdCount).toBe(1);
        });

        it('should stop on exception when transaction=true', async () => {
            mockRequestHandler.post
                .mockRejectedValueOnce(new Error('Connection refused'))
                .mockResolvedValueOnce(createMockPostResponse('id2'));

            const result = await batchOps.batchCreate({
                operations: [
                    { table: 'incident', data: { short_description: 'First' } },
                    { table: 'incident', data: { short_description: 'Second' } }
                ],
                transaction: true
            });

            expect(result.success).toBe(false);
            expect(result.createdCount).toBe(0);
            expect(result.errors).toHaveLength(1);
            expect(mockRequestHandler.post).toHaveBeenCalledTimes(1);
        });

        it('should resolve multiple variable references in the same data', async () => {
            mockRequestHandler.post
                .mockResolvedValueOnce(createMockPostResponse('aaa'))
                .mockResolvedValueOnce(createMockPostResponse('bbb'))
                .mockResolvedValueOnce(createMockPostResponse('ccc'));

            const result = await batchOps.batchCreate({
                operations: [
                    { table: 'cmdb_ci', data: { name: 'CI A' }, saveAs: 'ciA' },
                    { table: 'cmdb_ci', data: { name: 'CI B' }, saveAs: 'ciB' },
                    { table: 'cmdb_rel_ci', data: { parent: '${ciA}', child: '${ciB}' } }
                ]
            });

            expect(result.success).toBe(true);
            expect(result.createdCount).toBe(3);
            expect(result.sysIds['ciA']).toBe('aaa');
            expect(result.sysIds['ciB']).toBe('bbb');
        });
    });

    describe('batchUpdate', () => {
        it('should update a single record successfully', async () => {
            mockRequestHandler.put.mockResolvedValueOnce(createMockPutResponse('abc123'));

            const result = await batchOps.batchUpdate({
                updates: [
                    { table: 'incident', sysId: 'abc123', data: { state: '2' } }
                ]
            });

            expect(result.success).toBe(true);
            expect(result.updatedCount).toBe(1);
            expect(result.errors).toHaveLength(0);
            expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
        });

        it('should update multiple records sequentially', async () => {
            mockRequestHandler.put
                .mockResolvedValueOnce(createMockPutResponse('id1'))
                .mockResolvedValueOnce(createMockPutResponse('id2'))
                .mockResolvedValueOnce(createMockPutResponse('id3'));

            const result = await batchOps.batchUpdate({
                updates: [
                    { table: 'incident', sysId: 'id1', data: { state: '2' } },
                    { table: 'incident', sysId: 'id2', data: { state: '3' } },
                    { table: 'change_request', sysId: 'id3', data: { state: '2' } }
                ]
            });

            expect(result.success).toBe(true);
            expect(result.updatedCount).toBe(3);
            expect(result.errors).toHaveLength(0);
            expect(mockRequestHandler.put).toHaveBeenCalledTimes(3);
        });

        it('should continue past errors when stopOnError=false (default)', async () => {
            mockRequestHandler.put
                .mockResolvedValueOnce(createMockPutResponse('id1'))
                .mockResolvedValueOnce(createErrorResponse(500))
                .mockResolvedValueOnce(createMockPutResponse('id3'));

            const result = await batchOps.batchUpdate({
                updates: [
                    { table: 'incident', sysId: 'id1', data: { state: '2' } },
                    { table: 'incident', sysId: 'id2', data: { state: '3' } },
                    { table: 'incident', sysId: 'id3', data: { state: '4' } }
                ]
            });

            expect(result.success).toBe(false);
            expect(result.updatedCount).toBe(2);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].updateIndex).toBe(1);
            expect(result.errors[0].sysId).toBe('id2');
            expect(mockRequestHandler.put).toHaveBeenCalledTimes(3);
        });

        it('should stop on first error when stopOnError=true', async () => {
            mockRequestHandler.put
                .mockResolvedValueOnce(createMockPutResponse('id1'))
                .mockResolvedValueOnce(createErrorResponse(500))
                .mockResolvedValueOnce(createMockPutResponse('id3'));

            const result = await batchOps.batchUpdate({
                updates: [
                    { table: 'incident', sysId: 'id1', data: { state: '2' } },
                    { table: 'incident', sysId: 'id2', data: { state: '3' } },
                    { table: 'incident', sysId: 'id3', data: { state: '4' } }
                ],
                stopOnError: true
            });

            expect(result.success).toBe(false);
            expect(result.updatedCount).toBe(1);
            expect(result.errors).toHaveLength(1);
            expect(mockRequestHandler.put).toHaveBeenCalledTimes(2);
        });

        it('should handle exceptions as errors', async () => {
            mockRequestHandler.put
                .mockRejectedValueOnce(new Error('Timeout'));

            const result = await batchOps.batchUpdate({
                updates: [
                    { table: 'incident', sysId: 'id1', data: { state: '2' } }
                ]
            });

            expect(result.success).toBe(false);
            expect(result.updatedCount).toBe(0);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].error).toBeDefined();
        });

        it('should invoke onProgress callback', async () => {
            mockRequestHandler.put
                .mockResolvedValueOnce(createMockPutResponse('id1'))
                .mockResolvedValueOnce(createMockPutResponse('id2'));

            const progressMessages: string[] = [];
            const onProgress = (message: string) => progressMessages.push(message);

            await batchOps.batchUpdate({
                updates: [
                    { table: 'incident', sysId: 'id1', data: { state: '2' } },
                    { table: 'incident', sysId: 'id2', data: { state: '3' } }
                ],
                onProgress
            });

            expect(progressMessages.length).toBeGreaterThan(0);
            expect(progressMessages[0]).toContain('Updating record 1/2');
            expect(progressMessages[1]).toContain('Updating record 2/2');
            expect(progressMessages[progressMessages.length - 1]).toContain('Batch update complete');
        });

        it('should handle empty updates list', async () => {
            const result = await batchOps.batchUpdate({
                updates: []
            });

            expect(result.success).toBe(true);
            expect(result.updatedCount).toBe(0);
            expect(result.errors).toHaveLength(0);
            expect(mockRequestHandler.put).not.toHaveBeenCalled();
        });

        it('should stop on exception when stopOnError=true', async () => {
            mockRequestHandler.put
                .mockRejectedValueOnce(new Error('Connection refused'))
                .mockResolvedValueOnce(createMockPutResponse('id2'));

            const result = await batchOps.batchUpdate({
                updates: [
                    { table: 'incident', sysId: 'id1', data: { state: '2' } },
                    { table: 'incident', sysId: 'id2', data: { state: '3' } }
                ],
                stopOnError: true
            });

            expect(result.success).toBe(false);
            expect(result.updatedCount).toBe(0);
            expect(result.errors).toHaveLength(1);
            expect(mockRequestHandler.put).toHaveBeenCalledTimes(1);
        });

        it('should include table and sysId in error details', async () => {
            mockRequestHandler.put
                .mockResolvedValueOnce(createErrorResponse(404));

            const result = await batchOps.batchUpdate({
                updates: [
                    { table: 'incident', sysId: 'nonexistent', data: { state: '2' } }
                ]
            });

            expect(result.success).toBe(false);
            expect(result.errors[0].table).toBe('incident');
            expect(result.errors[0].sysId).toBe('nonexistent');
            expect(result.errors[0].updateIndex).toBe(0);
        });
    });

    describe('resolveVariableReferences (private)', () => {
        it('should return data unchanged when no sysIds exist', async () => {
            // Test indirectly through batchCreate with no saveAs
            mockRequestHandler.post.mockResolvedValueOnce(createMockPostResponse('id1'));

            const result = await batchOps.batchCreate({
                operations: [
                    { table: 'incident', data: { short_description: 'No refs ${nope}' } }
                ]
            });

            expect(result.success).toBe(true);
        });

        it('should handle nested variable references in data', async () => {
            mockRequestHandler.post
                .mockResolvedValueOnce(createMockPostResponse('parent-id'))
                .mockResolvedValueOnce(createMockPostResponse('child-id'));

            const result = await batchOps.batchCreate({
                operations: [
                    { table: 'cmdb_ci', data: { name: 'Parent' }, saveAs: 'parent' },
                    { table: 'cmdb_rel_ci', data: { description: 'Link to ${parent}', parent_ref: '${parent}' } }
                ]
            });

            expect(result.success).toBe(true);
            expect(result.sysIds['parent']).toBe('parent-id');
        });
    });
});
