/**
 * Unit tests for TaskOperations
 * Uses mocks instead of real credentials
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ServiceNowInstance, ServiceNowSettingsInstance } from '../../../../src/sn/ServiceNowInstance';
import { createGetCredentialsMock, MockAuthenticationHandler } from '../../__mocks__/servicenow-sdk-mocks';
import { TaskOperations } from '../../../../src/sn/task/TaskOperations';
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
 * Creates a mock successful response with a single task record.
 */
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

/**
 * Creates a mock response for a list of records.
 */
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

describe('TaskOperations - Unit Tests', () => {
    let instance: ServiceNowInstance;
    let taskOps: TaskOperations;
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
            taskOps = new TaskOperations(instance);
        }
    });

    describe('Constructor', () => {
        it('should create instance with ServiceNow instance', () => {
            expect(taskOps).toBeInstanceOf(TaskOperations);
            expect((taskOps as any)._instance).toBe(instance);
        });

        it('should initialize logger', () => {
            expect((taskOps as any)._logger).toBeDefined();
        });

        it('should initialize ServiceNowRequest', () => {
            expect((taskOps as any)._req).toBeDefined();
        });

        it('should initialize TableAPIRequest', () => {
            expect((taskOps as any)._tableAPI).toBeDefined();
        });
    });

    describe('addComment', () => {
        it('should add a customer-visible comment', async () => {
            const mockRecord = { sys_id: 'inc123', number: 'INC0010001', comments: 'Test comment' };
            mockRequestHandler.put.mockResolvedValueOnce(createMockResponse(mockRecord));

            const result = await taskOps.addComment({
                table: 'incident',
                recordSysId: 'inc123',
                comment: 'Test comment'
            });

            expect(result.sys_id).toBe('inc123');
            expect(mockRequestHandler.put).toHaveBeenCalledTimes(1);
        });

        it('should add a work note when isWorkNote=true', async () => {
            const mockRecord = { sys_id: 'inc123', number: 'INC0010001', work_notes: 'Internal note' };
            mockRequestHandler.put.mockResolvedValueOnce(createMockResponse(mockRecord));

            const result = await taskOps.addComment({
                table: 'incident',
                recordSysId: 'inc123',
                comment: 'Internal note',
                isWorkNote: true
            });

            expect(result.sys_id).toBe('inc123');
            expect(mockRequestHandler.put).toHaveBeenCalledTimes(1);
        });

        it('should throw error if table is empty', async () => {
            await expect(taskOps.addComment({
                table: '',
                recordSysId: 'inc123',
                comment: 'Test'
            })).rejects.toThrow('Table name is required');
        });

        it('should throw error if recordSysId is empty', async () => {
            await expect(taskOps.addComment({
                table: 'incident',
                recordSysId: '',
                comment: 'Test'
            })).rejects.toThrow('Record sys_id is required');
        });

        it('should throw error if comment is empty', async () => {
            await expect(taskOps.addComment({
                table: 'incident',
                recordSysId: 'inc123',
                comment: ''
            })).rejects.toThrow('Comment text is required');
        });

        it('should throw error on failed API call', async () => {
            mockRequestHandler.put.mockResolvedValueOnce(createErrorResponse(500));

            await expect(taskOps.addComment({
                table: 'incident',
                recordSysId: 'inc123',
                comment: 'Test'
            })).rejects.toThrow('Failed to add comments');
        });
    });

    describe('assignTask', () => {
        it('should assign task to a user', async () => {
            const mockRecord = { sys_id: 'inc123', assigned_to: 'user-abc' };
            mockRequestHandler.put.mockResolvedValueOnce(createMockResponse(mockRecord));

            const result = await taskOps.assignTask({
                table: 'incident',
                recordSysId: 'inc123',
                assignedTo: 'user-abc'
            });

            expect(result.sys_id).toBe('inc123');
            expect(mockRequestHandler.put).toHaveBeenCalledTimes(1);
        });

        it('should assign task to user and group', async () => {
            const mockRecord = { sys_id: 'inc123', assigned_to: 'user-abc', assignment_group: 'group-xyz' };
            mockRequestHandler.put.mockResolvedValueOnce(createMockResponse(mockRecord));

            const result = await taskOps.assignTask({
                table: 'incident',
                recordSysId: 'inc123',
                assignedTo: 'user-abc',
                assignmentGroup: 'group-xyz'
            });

            expect(result.sys_id).toBe('inc123');
        });

        it('should throw error if table is empty', async () => {
            await expect(taskOps.assignTask({
                table: '',
                recordSysId: 'inc123',
                assignedTo: 'user-abc'
            })).rejects.toThrow('Table name is required');
        });

        it('should throw error if recordSysId is empty', async () => {
            await expect(taskOps.assignTask({
                table: 'incident',
                recordSysId: '',
                assignedTo: 'user-abc'
            })).rejects.toThrow('Record sys_id is required');
        });

        it('should throw error if assignedTo is empty', async () => {
            await expect(taskOps.assignTask({
                table: 'incident',
                recordSysId: 'inc123',
                assignedTo: ''
            })).rejects.toThrow('Assigned to value is required');
        });

        it('should throw error on failed API call', async () => {
            mockRequestHandler.put.mockResolvedValueOnce(createErrorResponse(404));

            await expect(taskOps.assignTask({
                table: 'incident',
                recordSysId: 'inc123',
                assignedTo: 'user-abc'
            })).rejects.toThrow('Failed to assign');
        });
    });

    describe('resolveIncident', () => {
        it('should resolve incident with state 6', async () => {
            const mockRecord = { sys_id: 'inc123', state: '6', close_notes: 'Fixed' };
            mockRequestHandler.put.mockResolvedValueOnce(createMockResponse(mockRecord));

            const result = await taskOps.resolveIncident({
                sysId: 'inc123',
                resolutionNotes: 'Fixed the issue'
            });

            expect(result.sys_id).toBe('inc123');
            expect(mockRequestHandler.put).toHaveBeenCalledTimes(1);
        });

        it('should resolve incident with close code', async () => {
            const mockRecord = { sys_id: 'inc123', state: '6', close_code: 'Solved (Permanently)' };
            mockRequestHandler.put.mockResolvedValueOnce(createMockResponse(mockRecord));

            const result = await taskOps.resolveIncident({
                sysId: 'inc123',
                resolutionNotes: 'Fixed permanently',
                closeCode: 'Solved (Permanently)'
            });

            expect(result.sys_id).toBe('inc123');
        });

        it('should throw error if sysId is empty', async () => {
            await expect(taskOps.resolveIncident({
                sysId: '',
                resolutionNotes: 'Fixed'
            })).rejects.toThrow('Incident sys_id is required');
        });

        it('should throw error if resolutionNotes is empty', async () => {
            await expect(taskOps.resolveIncident({
                sysId: 'inc123',
                resolutionNotes: ''
            })).rejects.toThrow('Resolution notes are required');
        });

        it('should throw error on failed API call', async () => {
            mockRequestHandler.put.mockResolvedValueOnce(createErrorResponse(500));

            await expect(taskOps.resolveIncident({
                sysId: 'inc123',
                resolutionNotes: 'Fixed'
            })).rejects.toThrow('Failed to resolve incident');
        });
    });

    describe('closeIncident', () => {
        it('should close incident with state 7', async () => {
            const mockRecord = { sys_id: 'inc123', state: '7', close_notes: 'Closed' };
            mockRequestHandler.put.mockResolvedValueOnce(createMockResponse(mockRecord));

            const result = await taskOps.closeIncident({
                sysId: 'inc123',
                closeNotes: 'Issue resolved and verified'
            });

            expect(result.sys_id).toBe('inc123');
            expect(mockRequestHandler.put).toHaveBeenCalledTimes(1);
        });

        it('should close incident with close code', async () => {
            const mockRecord = { sys_id: 'inc123', state: '7', close_code: 'Solved (Work Around)' };
            mockRequestHandler.put.mockResolvedValueOnce(createMockResponse(mockRecord));

            const result = await taskOps.closeIncident({
                sysId: 'inc123',
                closeNotes: 'Workaround applied',
                closeCode: 'Solved (Work Around)'
            });

            expect(result.sys_id).toBe('inc123');
        });

        it('should throw error if sysId is empty', async () => {
            await expect(taskOps.closeIncident({
                sysId: '',
                closeNotes: 'Closed'
            })).rejects.toThrow('Incident sys_id is required');
        });

        it('should throw error if closeNotes is empty', async () => {
            await expect(taskOps.closeIncident({
                sysId: 'inc123',
                closeNotes: ''
            })).rejects.toThrow('Close notes are required');
        });

        it('should throw error on failed API call', async () => {
            mockRequestHandler.put.mockResolvedValueOnce(createErrorResponse(500));

            await expect(taskOps.closeIncident({
                sysId: 'inc123',
                closeNotes: 'Closed'
            })).rejects.toThrow('Failed to close incident');
        });
    });

    describe('approveChange', () => {
        it('should approve change request', async () => {
            const mockRecord = { sys_id: 'chg123', approval: 'approved' };
            mockRequestHandler.put.mockResolvedValueOnce(createMockResponse(mockRecord));

            const result = await taskOps.approveChange({
                sysId: 'chg123'
            });

            expect(result.sys_id).toBe('chg123');
            expect(mockRequestHandler.put).toHaveBeenCalledTimes(1);
        });

        it('should approve change request with comments', async () => {
            const mockRecord = { sys_id: 'chg123', approval: 'approved', comments: 'LGTM' };
            mockRequestHandler.put.mockResolvedValueOnce(createMockResponse(mockRecord));

            const result = await taskOps.approveChange({
                sysId: 'chg123',
                comments: 'LGTM'
            });

            expect(result.sys_id).toBe('chg123');
        });

        it('should throw error if sysId is empty', async () => {
            await expect(taskOps.approveChange({
                sysId: ''
            })).rejects.toThrow('Change request sys_id is required');
        });

        it('should throw error on failed API call', async () => {
            mockRequestHandler.put.mockResolvedValueOnce(createErrorResponse(403));

            await expect(taskOps.approveChange({
                sysId: 'chg123'
            })).rejects.toThrow('Failed to approve change request');
        });
    });

    describe('findByNumber', () => {
        it('should find a record by number', async () => {
            const mockRecord = { sys_id: 'inc123', number: 'INC0010001', state: '1' };
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([mockRecord]));

            const result = await taskOps.findByNumber('incident', 'INC0010001');

            expect(result).not.toBeNull();
            expect(result!.sys_id).toBe('inc123');
            expect(result!.number).toBe('INC0010001');
            expect(mockRequestHandler.get).toHaveBeenCalledTimes(1);
        });

        it('should return null when no record found', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([]));

            const result = await taskOps.findByNumber('incident', 'INC9999999');

            expect(result).toBeNull();
        });

        it('should throw error if table is empty', async () => {
            await expect(taskOps.findByNumber('', 'INC0010001'))
                .rejects.toThrow('Table name is required');
        });

        it('should throw error if number is empty', async () => {
            await expect(taskOps.findByNumber('incident', ''))
                .rejects.toThrow('Task number is required');
        });

        it('should throw error on failed API call', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(createErrorResponse(500));

            await expect(taskOps.findByNumber('incident', 'INC0010001'))
                .rejects.toThrow('Failed to query incident');
        });

        it('should return first result when multiple matches exist', async () => {
            const records = [
                { sys_id: 'first', number: 'INC0010001' },
                { sys_id: 'second', number: 'INC0010001' }
            ];
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse(records));

            const result = await taskOps.findByNumber('incident', 'INC0010001');

            expect(result).not.toBeNull();
            expect(result!.sys_id).toBe('first');
        });

        it('should work with different table types', async () => {
            const mockRecord = { sys_id: 'chg123', number: 'CHG0010001' };
            mockRequestHandler.get.mockResolvedValueOnce(createMockListResponse([mockRecord]));

            const result = await taskOps.findByNumber('change_request', 'CHG0010001');

            expect(result).not.toBeNull();
            expect(result!.sys_id).toBe('chg123');
        });
    });
});
