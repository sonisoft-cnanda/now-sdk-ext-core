/**
 * Unit tests for AttachmentManager
 * Uses mocks instead of real credentials
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ServiceNowInstance, ServiceNowSettingsInstance } from '../../../../src/sn/ServiceNowInstance';
import { createGetCredentialsMock, MockAuthenticationHandler } from '../../__mocks__/servicenow-sdk-mocks';
import { IHttpResponse } from '../../../../src/comm/http/IHttpResponse';
import { AuthenticationHandlerFactory } from '../../../../src/auth/AuthenticationHandlerFactory';
import { RequestHandlerFactory } from '../../../../src/comm/http/RequestHandlerFactory';
import { SessionManager } from '../../../../src/comm/http/SessionManager';
import { AttachmentManager } from '../../../../src/sn/attachment/AttachmentManager';

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

describe('AttachmentManager - Unit Tests', () => {
    let instance: ServiceNowInstance;
    let attachmentManager: AttachmentManager;
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
            attachmentManager = new AttachmentManager(instance);
        }
    });

    describe('Constructor', () => {
        it('should create instance with ServiceNow instance', () => {
            expect(attachmentManager).toBeInstanceOf(AttachmentManager);
        });
    });

    describe('Constants', () => {
        it('should define ATTACHMENT_API_PATH', () => {
            expect(AttachmentManager.ATTACHMENT_API_PATH).toBe('/api/now/attachment');
        });

        it('should define ATTACHMENT_FILE_API_PATH', () => {
            expect(AttachmentManager.ATTACHMENT_FILE_API_PATH).toBe('/api/now/attachment/file');
        });

        it('should define ATTACHMENT_TABLE', () => {
            expect(AttachmentManager.ATTACHMENT_TABLE).toBe('sys_attachment');
        });
    });

    describe('uploadAttachment', () => {
        it('should upload an attachment successfully', async () => {
            const mockAttachment = {
                sys_id: 'att123',
                file_name: 'test.txt',
                table_name: 'incident',
                table_sys_id: 'inc123',
                content_type: 'text/plain',
                size_bytes: '100'
            };

            mockRequestHandler.post.mockResolvedValue(createMockResponse(mockAttachment, 201));

            const result = await attachmentManager.uploadAttachment({
                tableName: 'incident',
                recordSysId: 'inc123',
                fileName: 'test.txt',
                contentType: 'text/plain',
                data: 'Hello World'
            });

            expect(result).toBeDefined();
            expect(result.sys_id).toBe('att123');
            expect(result.file_name).toBe('test.txt');
            expect(mockRequestHandler.post).toHaveBeenCalled();
        });

        it('should upload a Buffer attachment successfully', async () => {
            const mockAttachment = {
                sys_id: 'att456',
                file_name: 'image.png',
                table_name: 'incident',
                table_sys_id: 'inc123',
                content_type: 'image/png',
                size_bytes: '2048'
            };

            mockRequestHandler.post.mockResolvedValue(createMockResponse(mockAttachment, 200));

            const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
            const result = await attachmentManager.uploadAttachment({
                tableName: 'incident',
                recordSysId: 'inc123',
                fileName: 'image.png',
                contentType: 'image/png',
                data: buffer
            });

            expect(result).toBeDefined();
            expect(result.sys_id).toBe('att456');
            expect(result.file_name).toBe('image.png');
        });

        it('should throw on upload failure', async () => {
            mockRequestHandler.post.mockResolvedValue(createErrorResponse(500));

            await expect(
                attachmentManager.uploadAttachment({
                    tableName: 'incident',
                    recordSysId: 'inc123',
                    fileName: 'test.txt',
                    contentType: 'text/plain',
                    data: 'data'
                })
            ).rejects.toThrow('Failed to upload attachment');
        });

        it('should throw when response has no result', async () => {
            mockRequestHandler.post.mockResolvedValue({
                data: {},
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {},
                bodyObject: {}
            } as IHttpResponse<any>);

            await expect(
                attachmentManager.uploadAttachment({
                    tableName: 'incident',
                    recordSysId: 'inc123',
                    fileName: 'test.txt',
                    contentType: 'text/plain',
                    data: 'data'
                })
            ).rejects.toThrow('Failed to upload attachment');
        });
    });

    describe('listAttachments', () => {
        it('should list attachments for a record', async () => {
            const mockAttachments = [
                {
                    sys_id: 'att1',
                    file_name: 'file1.txt',
                    table_name: 'incident',
                    table_sys_id: 'inc123',
                    content_type: 'text/plain'
                },
                {
                    sys_id: 'att2',
                    file_name: 'file2.pdf',
                    table_name: 'incident',
                    table_sys_id: 'inc123',
                    content_type: 'application/pdf'
                }
            ];

            mockRequestHandler.get.mockResolvedValue(createMockResponse(mockAttachments));

            const result = await attachmentManager.listAttachments({
                tableName: 'incident',
                recordSysId: 'inc123'
            });

            expect(result).toBeDefined();
            expect(result.length).toBe(2);
            expect(result[0].file_name).toBe('file1.txt');
            expect(result[1].file_name).toBe('file2.pdf');
        });

        it('should return empty array when no attachments found', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse([]));

            const result = await attachmentManager.listAttachments({
                tableName: 'incident',
                recordSysId: 'inc123'
            });

            expect(result).toBeDefined();
            expect(result.length).toBe(0);
        });

        it('should use default limit of 100', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse([]));

            await attachmentManager.listAttachments({
                tableName: 'incident',
                recordSysId: 'inc123'
            });

            // Verify the request was made (the limit is embedded in the query)
            expect(mockRequestHandler.get).toHaveBeenCalled();
        });

        it('should use custom limit when provided', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse([]));

            await attachmentManager.listAttachments({
                tableName: 'incident',
                recordSysId: 'inc123',
                limit: 10
            });

            expect(mockRequestHandler.get).toHaveBeenCalled();
        });

        it('should throw on API failure', async () => {
            mockRequestHandler.get.mockResolvedValue(createErrorResponse(500));

            await expect(
                attachmentManager.listAttachments({
                    tableName: 'incident',
                    recordSysId: 'inc123'
                })
            ).rejects.toThrow('Failed to list attachments');
        });
    });

    describe('getAttachment', () => {
        it('should get a single attachment by sys_id', async () => {
            const mockAttachment = {
                sys_id: 'att123',
                file_name: 'report.pdf',
                table_name: 'incident',
                table_sys_id: 'inc456',
                content_type: 'application/pdf',
                size_bytes: '50000'
            };

            mockRequestHandler.get.mockResolvedValue(createMockResponse([mockAttachment]));

            const result = await attachmentManager.getAttachment('att123');

            expect(result).toBeDefined();
            expect(result.sys_id).toBe('att123');
            expect(result.file_name).toBe('report.pdf');
        });

        it('should throw when attachment not found', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse([]));

            await expect(
                attachmentManager.getAttachment('nonexistent')
            ).rejects.toThrow("Attachment with sys_id 'nonexistent' not found");
        });

        it('should throw on API failure', async () => {
            mockRequestHandler.get.mockResolvedValue(createErrorResponse(500));

            await expect(
                attachmentManager.getAttachment('att123')
            ).rejects.toThrow("Attachment with sys_id 'att123' not found");
        });

        it('should throw when bodyObject is null', async () => {
            mockRequestHandler.get.mockResolvedValue({
                data: null,
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {},
                bodyObject: null
            } as IHttpResponse<any>);

            await expect(
                attachmentManager.getAttachment('att123')
            ).rejects.toThrow("Attachment with sys_id 'att123' not found");
        });
    });
});
