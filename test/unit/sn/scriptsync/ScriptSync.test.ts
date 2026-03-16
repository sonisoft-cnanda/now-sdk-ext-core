/**
 * Unit tests for ScriptSync
 * Uses mocks instead of real credentials
 *
 * NOTE: Node built-in modules (like 'fs') cannot be mocked with jest.mock()
 * in ESM mode. We use jest.unstable_mockModule() + dynamic imports instead.
 */

import { describe, it, expect, beforeEach, jest, afterEach } from '@jest/globals';
import { ServiceNowInstance, ServiceNowSettingsInstance } from '../../../../src/sn/ServiceNowInstance';
import { createGetCredentialsMock, MockAuthenticationHandler } from '../../__mocks__/servicenow-sdk-mocks';
import { IHttpResponse } from '../../../../src/comm/http/IHttpResponse';
import { AuthenticationHandlerFactory } from '../../../../src/auth/AuthenticationHandlerFactory';
import { RequestHandlerFactory } from '../../../../src/comm/http/RequestHandlerFactory';
import { SessionManager } from '../../../../src/comm/http/SessionManager';

// Define mock fs functions
const mockWriteFileSync = jest.fn();
const mockReadFileSync = jest.fn<(...args: any[]) => any>().mockReturnValue('mock file content');
const mockReaddirSync = jest.fn<(...args: any[]) => any>().mockReturnValue([]);

// Use jest.unstable_mockModule for ESM compatibility with Node built-in 'fs'.
// Must use jest.requireActual (sync/CJS) to avoid circular import OOM.
jest.unstable_mockModule('fs', () => {
    const actual = jest.requireActual<typeof import('fs')>('fs');
    return {
        ...actual,
        writeFileSync: mockWriteFileSync,
        readFileSync: mockReadFileSync,
        readdirSync: mockReaddirSync,
    };
});

// Mock getCredentials
const mockGetCredentials = createGetCredentialsMock();
jest.mock('@servicenow/sdk-cli/dist/auth/index.js', () => ({
    getCredentials: mockGetCredentials
}));

// Mock factories
jest.mock('../../../../src/auth/AuthenticationHandlerFactory');
jest.mock('../../../../src/comm/http/RequestHandlerFactory');

// Dynamic imports — must come after jest.unstable_mockModule so ScriptSync
// receives the mocked 'fs' module instead of the real one.
const { ScriptSync } = await import('../../../../src/sn/scriptsync/ScriptSync');
const { SCRIPT_TYPES } = await import('../../../../src/sn/scriptsync/ScriptSyncModels');

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

describe('ScriptSync - Unit Tests', () => {
    let instance: ServiceNowInstance;
    let scriptSync: InstanceType<typeof ScriptSync>;
    let mockAuthHandler: MockAuthenticationHandler;
    let mockRequestHandler: MockRequestHandler;

    beforeEach(async () => {
        jest.clearAllMocks();
        SessionManager.resetInstance();

        // Reset fs mock defaults
        mockWriteFileSync.mockImplementation(() => undefined);
        mockReadFileSync.mockReturnValue('mock file content');
        mockReaddirSync.mockReturnValue([]);

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
            scriptSync = new ScriptSync(instance);
        }
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('Constructor', () => {
        it('should create instance with ServiceNow instance', () => {
            expect(scriptSync).toBeInstanceOf(ScriptSync);
        });
    });

    describe('parseFileName (static)', () => {
        it('should parse a valid script include filename', () => {
            const result = ScriptSync.parseFileName('MyScriptInclude.sys_script_include.js');
            expect(result.isValid).toBe(true);
            expect(result.scriptName).toBe('MyScriptInclude');
            expect(result.scriptType).toBe('sys_script_include');
        });

        it('should parse a valid business rule filename', () => {
            const result = ScriptSync.parseFileName('OnInsertRule.sys_script.js');
            expect(result.isValid).toBe(true);
            expect(result.scriptName).toBe('OnInsertRule');
            expect(result.scriptType).toBe('sys_script');
        });

        it('should parse a valid UI script filename', () => {
            const result = ScriptSync.parseFileName('MyUIScript.sys_ui_script.js');
            expect(result.isValid).toBe(true);
            expect(result.scriptName).toBe('MyUIScript');
            expect(result.scriptType).toBe('sys_ui_script');
        });

        it('should parse a valid UI action filename', () => {
            const result = ScriptSync.parseFileName('ApproveAction.sys_ui_action.js');
            expect(result.isValid).toBe(true);
            expect(result.scriptName).toBe('ApproveAction');
            expect(result.scriptType).toBe('sys_ui_action');
        });

        it('should parse a valid client script filename', () => {
            const result = ScriptSync.parseFileName('OnLoadScript.sys_script_client.js');
            expect(result.isValid).toBe(true);
            expect(result.scriptName).toBe('OnLoadScript');
            expect(result.scriptType).toBe('sys_script_client');
        });

        it('should handle names with dots', () => {
            const result = ScriptSync.parseFileName('My.Script.Name.sys_script_include.js');
            expect(result.isValid).toBe(true);
            expect(result.scriptName).toBe('My.Script.Name');
            expect(result.scriptType).toBe('sys_script_include');
        });

        it('should return invalid for unknown script type', () => {
            const result = ScriptSync.parseFileName('MyScript.unknown_type.js');
            expect(result.isValid).toBe(false);
        });

        it('should return invalid for non-js extension', () => {
            const result = ScriptSync.parseFileName('MyScript.sys_script_include.ts');
            expect(result.isValid).toBe(false);
        });

        it('should return invalid for empty string', () => {
            const result = ScriptSync.parseFileName('');
            expect(result.isValid).toBe(false);
        });

        it('should return invalid for null/undefined', () => {
            const result = ScriptSync.parseFileName(null as any);
            expect(result.isValid).toBe(false);
        });

        it('should return invalid for filename without dots', () => {
            const result = ScriptSync.parseFileName('myscript.js');
            expect(result.isValid).toBe(false);
        });

        it('should return invalid for just .js', () => {
            const result = ScriptSync.parseFileName('.js');
            expect(result.isValid).toBe(false);
        });
    });

    describe('generateFileName (static)', () => {
        it('should generate correct filename for script include', () => {
            const result = ScriptSync.generateFileName('MyScript', 'sys_script_include');
            expect(result).toBe('MyScript.sys_script_include.js');
        });

        it('should generate correct filename for business rule', () => {
            const result = ScriptSync.generateFileName('OnInsertRule', 'sys_script');
            expect(result).toBe('OnInsertRule.sys_script.js');
        });

        it('should generate correct filename for client script', () => {
            const result = ScriptSync.generateFileName('OnLoad', 'sys_script_client');
            expect(result).toBe('OnLoad.sys_script_client.js');
        });
    });

    describe('pullScript', () => {
        it('should pull a script and write it to a file', async () => {
            const mockRecord = {
                sys_id: 'abc123',
                name: 'MyScriptInclude',
                script: 'var MyScriptInclude = Class.create();'
            };

            mockRequestHandler.get.mockResolvedValue(createMockResponse([mockRecord]));

            const result = await scriptSync.pullScript({
                scriptName: 'MyScriptInclude',
                scriptType: 'sys_script_include',
                filePath: '/tmp/MyScriptInclude.sys_script_include.js'
            });

            expect(result.success).toBe(true);
            expect(result.direction).toBe('pull');
            expect(result.sysId).toBe('abc123');
            expect(result.scriptName).toBe('MyScriptInclude');
            expect(mockWriteFileSync).toHaveBeenCalledWith(
                '/tmp/MyScriptInclude.sys_script_include.js',
                'var MyScriptInclude = Class.create();',
                'utf-8'
            );
        });

        it('should return failure when script is not found', async () => {
            mockRequestHandler.get.mockResolvedValue(createMockResponse([]));

            const result = await scriptSync.pullScript({
                scriptName: 'NonExistent',
                scriptType: 'sys_script_include',
                filePath: '/tmp/NonExistent.sys_script_include.js'
            });

            expect(result.success).toBe(false);
            expect(result.error).toBe('Script not found');
        });

        it('should return failure for unknown script type', async () => {
            const result = await scriptSync.pullScript({
                scriptName: 'MyScript',
                scriptType: 'unknown_type',
                filePath: '/tmp/MyScript.unknown_type.js'
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('Unknown script type');
        });

        it('should return failure when API returns error status', async () => {
            mockRequestHandler.get.mockResolvedValue(createErrorResponse(500));

            const result = await scriptSync.pullScript({
                scriptName: 'MyScript',
                scriptType: 'sys_script_include',
                filePath: '/tmp/MyScript.sys_script_include.js'
            });

            expect(result.success).toBe(false);
        });

        it('should handle empty script content gracefully', async () => {
            const mockRecord = {
                sys_id: 'abc123',
                name: 'EmptyScript',
                script: ''
            };

            mockRequestHandler.get.mockResolvedValue(createMockResponse([mockRecord]));

            const result = await scriptSync.pullScript({
                scriptName: 'EmptyScript',
                scriptType: 'sys_script_include',
                filePath: '/tmp/EmptyScript.sys_script_include.js'
            });

            expect(result.success).toBe(true);
            expect(mockWriteFileSync).toHaveBeenCalledWith(
                '/tmp/EmptyScript.sys_script_include.js',
                '',
                'utf-8'
            );
        });

        it('should handle API exceptions', async () => {
            mockRequestHandler.get.mockRejectedValue(new Error('Network error'));

            const result = await scriptSync.pullScript({
                scriptName: 'MyScript',
                scriptType: 'sys_script_include',
                filePath: '/tmp/MyScript.sys_script_include.js'
            });

            expect(result.success).toBe(false);
            expect(result.error).toBeDefined();
        });

        it('should include timestamp in result', async () => {
            const mockRecord = {
                sys_id: 'abc123',
                name: 'MyScript',
                script: 'test'
            };

            mockRequestHandler.get.mockResolvedValue(createMockResponse([mockRecord]));

            const result = await scriptSync.pullScript({
                scriptName: 'MyScript',
                scriptType: 'sys_script_include',
                filePath: '/tmp/MyScript.sys_script_include.js'
            });

            expect(result.timestamp).toBeDefined();
            expect(typeof result.timestamp).toBe('string');
        });
    });

    describe('pushScript', () => {
        it('should push a script from a file to ServiceNow', async () => {
            const mockRecord = {
                sys_id: 'abc123',
                name: 'MyScriptInclude',
                script: 'old script content'
            };

            mockReadFileSync.mockReturnValue('new script content');

            // First call: GET to find the record
            mockRequestHandler.get.mockResolvedValue(createMockResponse([mockRecord]));

            // Second call: PUT to update the record
            mockRequestHandler.put.mockResolvedValue(createMockResponse(mockRecord));

            const result = await scriptSync.pushScript({
                scriptName: 'MyScriptInclude',
                scriptType: 'sys_script_include',
                filePath: '/tmp/MyScriptInclude.sys_script_include.js'
            });

            expect(result.success).toBe(true);
            expect(result.direction).toBe('push');
            expect(result.sysId).toBe('abc123');
            expect(mockReadFileSync).toHaveBeenCalledWith(
                '/tmp/MyScriptInclude.sys_script_include.js',
                'utf-8'
            );
        });

        it('should return failure when script is not found', async () => {
            mockReadFileSync.mockReturnValue('script content');
            mockRequestHandler.get.mockResolvedValue(createMockResponse([]));

            const result = await scriptSync.pushScript({
                scriptName: 'NonExistent',
                scriptType: 'sys_script_include',
                filePath: '/tmp/NonExistent.sys_script_include.js'
            });

            expect(result.success).toBe(false);
            expect(result.error).toBe('Script not found');
        });

        it('should return failure for unknown script type', async () => {
            const result = await scriptSync.pushScript({
                scriptName: 'MyScript',
                scriptType: 'unknown_type',
                filePath: '/tmp/MyScript.unknown_type.js'
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('Unknown script type');
        });

        it('should return failure when PUT returns error status', async () => {
            const mockRecord = {
                sys_id: 'abc123',
                name: 'MyScript',
                script: 'old content'
            };

            mockReadFileSync.mockReturnValue('new content');
            mockRequestHandler.get.mockResolvedValue(createMockResponse([mockRecord]));
            mockRequestHandler.put.mockResolvedValue(createErrorResponse(500));

            const result = await scriptSync.pushScript({
                scriptName: 'MyScript',
                scriptType: 'sys_script_include',
                filePath: '/tmp/MyScript.sys_script_include.js'
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('Update failed');
        });

        it('should handle file read exceptions', async () => {
            mockReadFileSync.mockImplementation(() => {
                throw new Error('File not found');
            });

            const result = await scriptSync.pushScript({
                scriptName: 'MyScript',
                scriptType: 'sys_script_include',
                filePath: '/tmp/nonexistent.js'
            });

            expect(result.success).toBe(false);
            expect(result.error).toContain('File not found');
        });
    });

    describe('syncAllScripts', () => {
        it('should sync all valid files in a directory', async () => {
            const files = [
                'ScriptA.sys_script_include.js',
                'RuleB.sys_script.js',
                'invalid.txt',
                'readme.md'
            ];

            mockReaddirSync.mockReturnValue(files as any);
            mockReadFileSync.mockReturnValue('script content');

            const mockRecord = {
                sys_id: 'abc123',
                name: 'ScriptA',
                script: 'old'
            };

            // Mock both GET and PUT for each valid file
            mockRequestHandler.get.mockResolvedValue(createMockResponse([mockRecord]));
            mockRequestHandler.put.mockResolvedValue(createMockResponse(mockRecord));

            const result = await scriptSync.syncAllScripts({
                directory: '/tmp/scripts'
            });

            expect(result.totalFiles).toBe(2);
            expect(result.scripts.length).toBe(2);
            expect(result.directory).toBe('/tmp/scripts');
            expect(result.timestamp).toBeDefined();
        });

        it('should filter by script types when provided', async () => {
            const files = [
                'ScriptA.sys_script_include.js',
                'RuleB.sys_script.js',
                'ClientC.sys_script_client.js'
            ];

            mockReaddirSync.mockReturnValue(files as any);
            mockReadFileSync.mockReturnValue('script content');

            const mockRecord = {
                sys_id: 'abc123',
                name: 'ScriptA',
                script: 'old'
            };

            mockRequestHandler.get.mockResolvedValue(createMockResponse([mockRecord]));
            mockRequestHandler.put.mockResolvedValue(createMockResponse(mockRecord));

            const result = await scriptSync.syncAllScripts({
                directory: '/tmp/scripts',
                scriptTypes: ['sys_script_include']
            });

            expect(result.totalFiles).toBe(1);
            expect(result.scriptTypes).toEqual(['sys_script_include']);
        });

        it('should handle directory read errors gracefully', async () => {
            mockReaddirSync.mockImplementation(() => {
                throw new Error('Directory not found');
            });

            const result = await scriptSync.syncAllScripts({
                directory: '/tmp/nonexistent'
            });

            expect(result.totalFiles).toBe(0);
            expect(result.synced).toBe(0);
            expect(result.failed).toBe(0);
        });

        it('should count synced and failed correctly', async () => {
            const files = [
                'ScriptA.sys_script_include.js',
                'ScriptB.sys_script_include.js'
            ];

            mockReaddirSync.mockReturnValue(files as any);
            mockReadFileSync.mockReturnValue('script content');

            const mockRecordA = {
                sys_id: 'abc123',
                name: 'ScriptA',
                script: 'old'
            };

            // First GET succeeds (ScriptA found), second GET returns empty (ScriptB not found)
            mockRequestHandler.get
                .mockResolvedValueOnce(createMockResponse([mockRecordA]))
                .mockResolvedValueOnce(createMockResponse([]));

            mockRequestHandler.put.mockResolvedValue(createMockResponse(mockRecordA));

            const result = await scriptSync.syncAllScripts({
                directory: '/tmp/scripts'
            });

            expect(result.totalFiles).toBe(2);
            expect(result.synced).toBe(1);
            expect(result.failed).toBe(1);
        });

        it('should use all script types when none specified', async () => {
            mockReaddirSync.mockReturnValue([] as any);

            const result = await scriptSync.syncAllScripts({
                directory: '/tmp/scripts'
            });

            expect(result.scriptTypes).toEqual(Object.keys(SCRIPT_TYPES));
        });
    });

    describe('SCRIPT_TYPES constant', () => {
        it('should define sys_script_include', () => {
            expect(SCRIPT_TYPES.sys_script_include).toBeDefined();
            expect(SCRIPT_TYPES.sys_script_include.table).toBe('sys_script_include');
            expect(SCRIPT_TYPES.sys_script_include.label).toBe('Script Include');
            expect(SCRIPT_TYPES.sys_script_include.nameField).toBe('name');
            expect(SCRIPT_TYPES.sys_script_include.scriptField).toBe('script');
            expect(SCRIPT_TYPES.sys_script_include.extension).toBe('.js');
        });

        it('should define sys_script', () => {
            expect(SCRIPT_TYPES.sys_script).toBeDefined();
            expect(SCRIPT_TYPES.sys_script.label).toBe('Business Rule');
        });

        it('should define sys_ui_script', () => {
            expect(SCRIPT_TYPES.sys_ui_script).toBeDefined();
            expect(SCRIPT_TYPES.sys_ui_script.label).toBe('UI Script');
        });

        it('should define sys_ui_action', () => {
            expect(SCRIPT_TYPES.sys_ui_action).toBeDefined();
            expect(SCRIPT_TYPES.sys_ui_action.label).toBe('UI Action');
        });

        it('should define sys_script_client', () => {
            expect(SCRIPT_TYPES.sys_script_client).toBeDefined();
            expect(SCRIPT_TYPES.sys_script_client.label).toBe('Client Script');
        });

        it('should have 5 script types', () => {
            expect(Object.keys(SCRIPT_TYPES).length).toBe(5);
        });
    });
});
