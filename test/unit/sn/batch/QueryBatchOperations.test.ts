/**
 * Unit tests for QueryBatchOperations
 * Tests query-based batch update and delete with dry-run safety
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { QueryBatchOperations } from '../../../../src/sn/batch/QueryBatchOperations';
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

describe('QueryBatchOperations - Unit Tests', () => {
    let instance: ServiceNowInstance;
    let queryBatch: QueryBatchOperations;
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
        queryBatch = new QueryBatchOperations(instance);
    });

    describe('Constructor', () => {
        it('should create instance with ServiceNow instance', () => {
            expect(queryBatch).toBeInstanceOf(QueryBatchOperations);
        });
    });

    describe('queryUpdate', () => {
        it('should perform dry run by default', async () => {
            mockRequestHandler.get.mockResolvedValue(
                createMockResponse({ result: [{ sys_id: 'a1' }, { sys_id: 'a2' }, { sys_id: 'a3' }] })
            );

            const result = await queryBatch.queryUpdate({
                table: 'incident',
                query: 'active=true',
                data: { urgency: '3' }
            });

            expect(result.dryRun).toBe(true);
            expect(result.matchCount).toBe(3);
            expect(result.updatedCount).toBe(0);
            expect(result.success).toBe(true);
            expect(mockRequestHandler.put).not.toHaveBeenCalled();
        });

        it('should execute updates when confirm=true', async () => {
            // First call: GET to find matching records
            mockRequestHandler.get.mockResolvedValueOnce(
                createMockResponse({ result: [{ sys_id: 'a1' }, { sys_id: 'a2' }] })
            );
            // PUT calls for each record
            mockRequestHandler.put.mockResolvedValue(
                createMockResponse({ result: { sys_id: 'a1' } })
            );

            const result = await queryBatch.queryUpdate({
                table: 'incident',
                query: 'active=true',
                data: { urgency: '3' },
                confirm: true
            });

            expect(result.dryRun).toBe(false);
            expect(result.matchCount).toBe(2);
            expect(result.updatedCount).toBe(2);
            expect(result.success).toBe(true);
            expect(result.errors).toHaveLength(0);
            expect(mockRequestHandler.put).toHaveBeenCalledTimes(2);
        });

        it('should only fetch sys_id field', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));

            await queryBatch.queryUpdate({
                table: 'incident',
                query: 'active=true',
                data: { urgency: '3' }
            });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_fields).toBe('sys_id');
        });

        it('should handle no matching records', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));

            const result = await queryBatch.queryUpdate({
                table: 'incident',
                query: 'sys_id=nonexistent',
                data: { urgency: '3' },
                confirm: true
            });

            expect(result.matchCount).toBe(0);
            expect(result.updatedCount).toBe(0);
            expect(result.success).toBe(true);
            expect(mockRequestHandler.put).not.toHaveBeenCalled();
        });

        it('should collect errors on partial failure', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(
                createMockResponse({ result: [{ sys_id: 'a1' }, { sys_id: 'a2' }] })
            );
            mockRequestHandler.put
                .mockResolvedValueOnce(createMockResponse({ result: { sys_id: 'a1' } }))
                .mockRejectedValueOnce(new Error('Forbidden'));

            const result = await queryBatch.queryUpdate({
                table: 'incident',
                query: 'active=true',
                data: { urgency: '3' },
                confirm: true
            });

            expect(result.updatedCount).toBe(1);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].sysId).toBe('a2');
            expect(result.success).toBe(false);
        });

        it('should clamp limit to max 10000', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));

            await queryBatch.queryUpdate({
                table: 'incident',
                query: 'active=true',
                data: { urgency: '3' },
                limit: 50000
            });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_limit).toBe(10000);
        });

        it('should use default limit of 200', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));

            await queryBatch.queryUpdate({
                table: 'incident',
                query: 'active=true',
                data: { urgency: '3' }
            });

            const callArgs = mockRequestHandler.get.mock.calls[0][0] as any;
            expect(callArgs.query.sysparm_limit).toBe(200);
        });

        it('should throw on empty table', async () => {
            await expect(queryBatch.queryUpdate({
                table: '',
                query: 'active=true',
                data: { urgency: '3' }
            })).rejects.toThrow('Table name is required');
        });

        it('should throw on empty query', async () => {
            await expect(queryBatch.queryUpdate({
                table: 'incident',
                query: '',
                data: { urgency: '3' }
            })).rejects.toThrow('Query is required');
        });

        it('should throw on empty data', async () => {
            await expect(queryBatch.queryUpdate({
                table: 'incident',
                query: 'active=true',
                data: {}
            })).rejects.toThrow('Update data is required');
        });

        it('should invoke onProgress callback', async () => {
            mockRequestHandler.get.mockResolvedValue(
                createMockResponse({ result: [{ sys_id: 'a1' }] })
            );

            const progressMessages: string[] = [];

            await queryBatch.queryUpdate({
                table: 'incident',
                query: 'active=true',
                data: { urgency: '3' },
                onProgress: (msg) => progressMessages.push(msg)
            });

            expect(progressMessages.length).toBeGreaterThan(0);
            expect(progressMessages[0]).toContain('Found 1 matching records');
        });

        it('should include executionTimeMs', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse({ result: [] }));

            const result = await queryBatch.queryUpdate({
                table: 'incident',
                query: 'active=true',
                data: { urgency: '3' }
            });

            expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
        });
    });

    describe('queryDelete', () => {
        it('should perform dry run by default', async () => {
            mockRequestHandler.get.mockResolvedValue(
                createMockResponse({ result: [{ sys_id: 'b1' }, { sys_id: 'b2' }] })
            );

            const result = await queryBatch.queryDelete({
                table: 'incident',
                query: 'short_descriptionLIKE[TEST]'
            });

            expect(result.dryRun).toBe(true);
            expect(result.matchCount).toBe(2);
            expect(result.deletedCount).toBe(0);
            expect(result.success).toBe(true);
            expect(mockRequestHandler.delete).not.toHaveBeenCalled();
        });

        it('should execute deletes when confirm=true', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(
                createMockResponse({ result: [{ sys_id: 'b1' }, { sys_id: 'b2' }] })
            );
            mockRequestHandler.delete.mockResolvedValue(createMockResponse(null, 204));

            const result = await queryBatch.queryDelete({
                table: 'incident',
                query: 'short_descriptionLIKE[TEST]',
                confirm: true
            });

            expect(result.dryRun).toBe(false);
            expect(result.deletedCount).toBe(2);
            expect(result.success).toBe(true);
        });

        it('should collect errors on partial delete failure', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(
                createMockResponse({ result: [{ sys_id: 'b1' }, { sys_id: 'b2' }] })
            );
            mockRequestHandler.delete
                .mockResolvedValueOnce(createMockResponse(null, 204))
                .mockRejectedValueOnce(new Error('Not found'));

            const result = await queryBatch.queryDelete({
                table: 'incident',
                query: 'short_descriptionLIKE[TEST]',
                confirm: true
            });

            expect(result.deletedCount).toBe(1);
            expect(result.errors).toHaveLength(1);
            expect(result.success).toBe(false);
        });

        it('should throw on empty table', async () => {
            await expect(queryBatch.queryDelete({
                table: '',
                query: 'active=true'
            })).rejects.toThrow('Table name is required');
        });

        it('should throw on empty query', async () => {
            await expect(queryBatch.queryDelete({
                table: 'incident',
                query: ''
            })).rejects.toThrow('Query is required');
        });
    });
});
