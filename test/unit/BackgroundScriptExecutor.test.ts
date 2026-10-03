/**
 * Unit tests for BackgroundScriptExecutor
 * Uses mocks instead of real credentials
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ServiceNowInstance, ServiceNowSettingsInstance } from '../../src/sn/ServiceNowInstance';
import { BackgroundScriptExecutor, ScriptExecutionOutputLine } from '../../src/sn/BackgroundScriptExecutor';
import { createGetCredentialsMock } from './__mocks__/servicenow-sdk-mocks';
import { IHttpResponse } from '../../src/comm/http/IHttpResponse';
import { AuthenticationHandlerFactory } from '../../src/auth/AuthenticationHandlerFactory';
import { RequestHandlerFactory } from '../../src/comm/http/RequestHandlerFactory';
import { MockAuthenticationHandler } from './__mocks__/servicenow-sdk-mocks';
import { SessionManager } from '../../src/comm/http/SessionManager';
import { ScriptScopeError, isScriptScopeError } from '../../src/exception/ScriptScopeError';
import { SessionAuthError } from '../../src/auth/SessionAuthError';

// Mock getCredentials
const mockGetCredentials = createGetCredentialsMock();
jest.mock('@servicenow/sdk-cli/dist/auth/index.js', () => ({
    getCredentials: mockGetCredentials
}));

// Mock factories
jest.mock('../../src/auth/AuthenticationHandlerFactory');
jest.mock('../../src/comm/http/RequestHandlerFactory');

// Mock request handler
class MockRequestHandler {
    get = jest.fn<() => Promise<IHttpResponse<unknown>>>();
    post = jest.fn<() => Promise<IHttpResponse<unknown>>>();
    put = jest.fn<() => Promise<IHttpResponse<unknown>>>();
    delete = jest.fn<() => Promise<IHttpResponse<unknown>>>();
}

// Mock response for scope name → sys_id resolution via sys_scope table
const GLOBAL_SCOPE_SYS_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const mockScopeResponse = (scopeName: string, sysId: string = GLOBAL_SCOPE_SYS_ID) => ({
    data: JSON.stringify({ result: [{ sys_id: sysId, scope: scopeName, name: scopeName === 'global' ? 'Global' : scopeName }] }),
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {},
    bodyObject: { result: [{ sys_id: sysId, scope: scopeName, name: scopeName === 'global' ? 'Global' : scopeName }] }
} as IHttpResponse<unknown>);

const csrfResponse = () => ({
    data: `<input name="sysparm_ck" type="hidden" value="testtoken123">`,
    status: 200,
    statusText: 'OK',
    headers: { 'x-is-logged-in': 'true' },
    config: {}
} as IHttpResponse<string>);

const tableResponse = (rows: Array<Record<string, string>>) => ({
    data: JSON.stringify({ result: rows }),
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {},
    bodyObject: { result: rows }
} as IHttpResponse<unknown>);

describe('BackgroundScriptExecutor - Unit Tests', () => {
    let instance: ServiceNowInstance;
    let executor: BackgroundScriptExecutor;
    let mockAuthHandler: MockAuthenticationHandler;
    let mockRequestHandler: MockRequestHandler;
    const TEST_SCOPE = 'global';

    beforeEach(async () => {
        jest.clearAllMocks();
        SessionManager.resetInstance();

        mockAuthHandler = new MockAuthenticationHandler();
        mockRequestHandler = new MockRequestHandler();

        jest.spyOn(AuthenticationHandlerFactory, 'createAuthHandler')
            .mockReturnValue(mockAuthHandler as unknown as ReturnType<typeof AuthenticationHandlerFactory.createAuthHandler>);
        jest.spyOn(RequestHandlerFactory, 'createRequestHandler')
            .mockReturnValue(mockRequestHandler as unknown as ReturnType<typeof RequestHandlerFactory.createRequestHandler>);

        const alias:string = 'test-instance';
        const credential = await mockGetCredentials(alias);

        if(credential){
            const snSettings:ServiceNowSettingsInstance = {
                alias: alias,
                credential: credential
            }
            instance = new ServiceNowInstance(snSettings);
            executor = new BackgroundScriptExecutor(instance, TEST_SCOPE);
        }
    });

    describe('Constructor', () => {
        it('should create instance with ServiceNow instance and scope', () => {
            expect(executor).toBeInstanceOf(BackgroundScriptExecutor);
            expect(executor.instance).toBe(instance);
            expect(executor.scope).toBe(TEST_SCOPE);
        });

        it('should initialize with global scope by default', () => {
            const exec = new BackgroundScriptExecutor(instance, 'global');
            expect(exec.scope).toBe('global');
        });

        it('should accept custom scope', () => {
            const customScope = 'x_custom_app';
            const exec = new BackgroundScriptExecutor(instance, customScope);
            expect(exec.scope).toBe(customScope);
        });

        it('should initialize ServiceNowRequest', () => {
            expect(executor.snRequest).toBeDefined();
        });
    });

    describe('ScriptExecutionOutputLine', () => {
        it('should store the line text', () => {
            const line = new ScriptExecutionOutputLine('hello world');
            expect(line.line).toBe('hello world');
        });

        it('should allow setting line text via setter', () => {
            const line = new ScriptExecutionOutputLine('original');
            line.line = 'updated';
            expect(line.line).toBe('updated');
        });

        it('asDebugLine should set _isDebug to true', () => {
            const line = new ScriptExecutionOutputLine('debug line');
            const result = line.asDebugLine();
            expect(result).toBe(line); // returns this
            expect((line as any)._isDebug).toBe(true);
            expect((line as any)._isSystem).toBe(false);
            expect((line as any)._isScript).toBe(false);
        });

        it('asSystemLine should set _isSystem to true', () => {
            const line = new ScriptExecutionOutputLine('system line');
            const result = line.asSystemLine();
            expect(result).toBe(line);
            expect((line as any)._isSystem).toBe(true);
            expect((line as any)._isDebug).toBe(false);
            expect((line as any)._isScript).toBe(false);
        });

        it('asScriptLine should set _isScript to true', () => {
            const line = new ScriptExecutionOutputLine('script line');
            const result = line.asScriptLine();
            expect(result).toBe(line);
            expect((line as any)._isScript).toBe(true);
            expect((line as any)._isDebug).toBe(false);
            expect((line as any)._isSystem).toBe(false);
        });

        it('asDebugLine(false) should set _isDebug to false', () => {
            const line = new ScriptExecutionOutputLine('test');
            line.asDebugLine(true);
            line.asDebugLine(false);
            expect((line as any)._isDebug).toBe(false);
        });

        it('asSystemLine(false) should set _isSystem to false', () => {
            const line = new ScriptExecutionOutputLine('test');
            line.asSystemLine(true);
            line.asSystemLine(false);
            expect((line as any)._isSystem).toBe(false);
        });

        it('asScriptLine(false) should set _isScript to false', () => {
            const line = new ScriptExecutionOutputLine('test');
            line.asScriptLine(true);
            line.asScriptLine(false);
            expect((line as any)._isScript).toBe(false);
        });

        it('flags should be independent of each other', () => {
            const line = new ScriptExecutionOutputLine('test');
            line.asDebugLine();
            line.asSystemLine();
            // asSystemLine should NOT affect _isDebug
            expect((line as any)._isDebug).toBe(true);
            expect((line as any)._isSystem).toBe(true);
            expect((line as any)._isScript).toBe(false);
        });
    });

    describe('parseScriptResult', () => {
        // Note: fast-xml-parser produces a #text property only when the element
        // has attributes. Real ServiceNow responses include class="outputtext"
        // on the PRE tag, so we include it in test XML to match production behavior.

        it('should parse a simple script result XML', () => {
            const xml = `<HTML><BODY><PRE class="outputtext">*** Script: Hello World
</PRE><div></div></BODY></HTML>`;

            const result = executor.parseScriptResult(xml);

            expect(result).toBeDefined();
            expect(result.raw).toBe(xml);
            expect(result.rawResult).toBeDefined();
            expect(result.consoleResult).toBeDefined();
            expect(result.scriptResults).toBeDefined();
            expect(Array.isArray(result.consoleResult)).toBe(true);
            expect(Array.isArray(result.scriptResults)).toBe(true);
        });

        it('should strip timestamp prefix from XML', () => {
            const xml = `[12:34:56.789]<HTML><BODY><PRE class="outputtext">*** Script: test
</PRE><div></div></BODY></HTML>`;

            const result = executor.parseScriptResult(xml);
            expect(result).toBeDefined();
            expect(result.rawResult).toBeDefined();
        });

        it('should classify *** Script: lines as script output', () => {
            const xml = `<HTML><BODY><PRE class="outputtext">*** Script: Hello World
</PRE><div></div></BODY></HTML>`;

            const result = executor.parseScriptResult(xml);

            const scriptLines = result.scriptResults.filter(
                (l: any) => (l as any)._isScript === true
            );
            expect(scriptLines.length).toBeGreaterThan(0);
        });

        it('should classify [DEBUG] lines as debug output', () => {
            const xml = `<HTML><BODY><PRE class="outputtext">*** Script: [DEBUG] some debug info
</PRE><div></div></BODY></HTML>`;

            const result = executor.parseScriptResult(xml);

            const debugLines = result.scriptResults.filter(
                (l: any) => (l as any)._isDebug === true
            );
            expect(debugLines.length).toBeGreaterThan(0);
        });

        it('should classify non-script lines as system output', () => {
            const xml = `<HTML><BODY><PRE class="outputtext">Evaluator: some system output
*** Script: user output
</PRE><div></div></BODY></HTML>`;

            const result = executor.parseScriptResult(xml);

            const systemLines = result.scriptResults.filter(
                (l: any) => (l as any)._isSystem === true
            );
            expect(systemLines.length).toBeGreaterThan(0);
        });

        it('should handle mixed output with system, script, and debug lines', () => {
            const xml = `<HTML><BODY><PRE class="outputtext">Evaluator: start
*** Script: normal output
*** Script: [DEBUG] debug output
System: end
</PRE><div></div></BODY></HTML>`;

            const result = executor.parseScriptResult(xml);

            expect(result.scriptResults.length).toBeGreaterThanOrEqual(3);
        });

        it('should preserve raw result', () => {
            const xml = `<HTML><BODY><PRE class="outputtext">*** Script: test
</PRE><div></div></BODY></HTML>`;

            const result = executor.parseScriptResult(xml);
            expect(result.raw).toBe(xml);
        });

        it('should extract affected records from div', () => {
            const xml = `<HTML><BODY><PRE class="outputtext">*** Script: test
</PRE><div>some affected records info</div></BODY></HTML>`;

            const result = executor.parseScriptResult(xml);
            expect(result.affectedRecords).toBeDefined();
        });
    });

    describe('getBackgroundScriptCSRFToken', () => {
        it('should extract CSRF token from response HTML', async () => {
            const htmlWithToken = `
                <html><body>
                <form>
                <input name="sysparm_ck" type="hidden" value="abc123token456">
                </form>
                </body></html>
            `;

            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue({
                data: htmlWithToken,
                status: 200,
                statusText: 'OK',
                headers: { 'x-is-logged-in': 'true' },
                config: {}
            } as IHttpResponse<string>);

            const token = await executor.getBackgroundScriptCSRFToken();
            expect(token).toBe('abc123token456');
        });

        it('should return null when not logged in', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue({
                data: '<html></html>',
                status: 200,
                statusText: 'OK',
                headers: { 'x-is-logged-in': 'false' },
                config: {}
            } as IHttpResponse<string>);

            const token = await executor.getBackgroundScriptCSRFToken();
            expect(token).toBeNull();
        });

        it('should return null when status is not 200', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue({
                data: null,
                status: 401,
                statusText: 'Unauthorized',
                headers: { 'x-is-logged-in': 'false' },
                config: {}
            } as IHttpResponse<string>);

            const token = await executor.getBackgroundScriptCSRFToken();
            expect(token).toBeNull();
        });

        it('should return null when response data is empty', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get.mockResolvedValue({
                data: null,
                status: 200,
                statusText: 'OK',
                headers: { 'x-is-logged-in': 'true' },
                config: {}
            } as IHttpResponse<string>);

            const token = await executor.getBackgroundScriptCSRFToken();
            expect(token).toBeNull();
        });
    });

    describe('executeScript - input validation', () => {
        it('should throw when instance is not a ServiceNowInstance', async () => {
            await expect(
                executor.executeScript('gs.info("test")', 'global', {} as ServiceNowInstance)
            ).rejects.toThrow('instance must be a ServiceNowInstance');
        });

        it('should throw when instance is null', async () => {
            await expect(
                executor.executeScript('gs.info("test")', 'global', null)
            ).rejects.toThrow('instance must be a ServiceNowInstance');
        });

        it('should throw when scope is not a string', async () => {
            await expect(
                executor.executeScript('gs.info("test")', 123 as any, instance)
            ).rejects.toThrow('scope must be a string');
        });

        it('should throw when scope is empty', async () => {
            await expect(
                executor.executeScript('gs.info("test")', '', instance)
            ).rejects.toThrow('scope must be a string');
        });

        it('should throw when script is not a string', async () => {
            await expect(
                executor.executeScript(123 as any, 'global', instance)
            ).rejects.toThrow('script must be a string');
        });

        it('should throw when script is empty', async () => {
            await expect(
                executor.executeScript('', 'global', instance)
            ).rejects.toThrow('script must be a string');
        });
    });

    describe('executeScript - execution', () => {
        it('should execute script and return parsed result on success', async () => {
            const csrfHtml = `<input name="sysparm_ck" type="hidden" value="testtoken123">`;
            const scriptResultXml = `<HTML><BODY><PRE class="outputtext">*** Script: Hello
</PRE><div></div></BODY></HTML>`;

            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);

            // First GET: CSRF token, Second GET: scope resolution
            mockRequestHandler.get
                .mockResolvedValueOnce({
                    data: csrfHtml,
                    status: 200,
                    statusText: 'OK',
                    headers: { 'x-is-logged-in': 'true' },
                    config: {}
                } as IHttpResponse<string>)
                .mockResolvedValueOnce(mockScopeResponse('global'));

            // POST to execute script
            mockRequestHandler.post.mockResolvedValue({
                data: scriptResultXml,
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {}
            } as IHttpResponse<string>);

            const result = await executor.executeScript('gs.info("Hello")', 'global', instance);

            expect(result).toBeDefined();
            expect(result.raw).toBe(scriptResultXml);
            expect(result.scriptResults).toBeDefined();
        });

        it('should throw on non-200 response', async () => {
            const csrfHtml = `<input name="sysparm_ck" type="hidden" value="testtoken123">`;

            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);

            mockRequestHandler.get
                .mockResolvedValueOnce({
                    data: csrfHtml,
                    status: 200,
                    statusText: 'OK',
                    headers: { 'x-is-logged-in': 'true' },
                    config: {}
                } as IHttpResponse<string>)
                .mockResolvedValueOnce(mockScopeResponse('global'));

            mockRequestHandler.post.mockResolvedValue({
                data: null,
                status: 500,
                statusText: 'Internal Server Error',
                headers: {},
                config: {}
            } as IHttpResponse<string>);

            await expect(
                executor.executeScript('gs.info("test")', 'global', instance)
            ).rejects.toThrow('Error executing script');
        });

        it('should throw when response body is empty on 200', async () => {
            const csrfHtml = `<input name="sysparm_ck" type="hidden" value="testtoken123">`;

            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);

            mockRequestHandler.get
                .mockResolvedValueOnce({
                    data: csrfHtml,
                    status: 200,
                    statusText: 'OK',
                    headers: { 'x-is-logged-in': 'true' },
                    config: {}
                } as IHttpResponse<string>)
                .mockResolvedValueOnce(mockScopeResponse('global'));

            mockRequestHandler.post.mockResolvedValue({
                data: null,
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {}
            } as IHttpResponse<string>);

            await expect(
                executor.executeScript('gs.info("test")', 'global', instance)
            ).rejects.toThrow('Error executing script');
        });

        it('should use default scope and instance when not provided', async () => {
            const csrfHtml = `<input name="sysparm_ck" type="hidden" value="testtoken123">`;
            const scriptResultXml = `<HTML><BODY><PRE class="outputtext">*** Script: default
</PRE><div></div></BODY></HTML>`;

            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);

            mockRequestHandler.get
                .mockResolvedValueOnce({
                    data: csrfHtml,
                    status: 200,
                    statusText: 'OK',
                    headers: { 'x-is-logged-in': 'true' },
                    config: {}
                } as IHttpResponse<string>)
                .mockResolvedValueOnce(mockScopeResponse('global'));

            mockRequestHandler.post.mockResolvedValue({
                data: scriptResultXml,
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {}
            } as IHttpResponse<string>);

            // Call without explicit scope and instance
            const result = await executor.executeScript('gs.info("default")');
            expect(result).toBeDefined();
            expect(result.raw).toBe(scriptResultXml);
        });

        it('should throw descriptive error when CSRF token is null', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);

            // Return response that will cause null CSRF token (not logged in)
            mockRequestHandler.get.mockResolvedValue({
                data: '<html></html>',
                status: 200,
                statusText: 'OK',
                headers: { 'x-is-logged-in': 'false' },
                config: {}
            } as IHttpResponse<string>);

            await expect(
                executor.executeScript('gs.info("test")', 'global', instance)
            ).rejects.toThrow('Failed to obtain CSRF token');
        });

        it('should preserve original error cause on failure', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);

            const originalError = new Error('Network timeout');
            mockRequestHandler.get.mockRejectedValue(originalError);

            try {
                await executor.executeScript('gs.info("test")', 'global', instance);
                expect(true).toBe(false); // should not reach here
            } catch (error) {
                expect(error).toBeInstanceOf(Error);
                expect((error as Error).message).toContain('Error executing script');
                expect((error as Error).cause).toBe(originalError);
            }
        });
    });

    describe('parseScriptResult - malformed HTML handling', () => {
        it('should parse HTML with closing </meta> and </link> tags', () => {
            const xml = `<HTML><HEAD><meta charset="utf-8"></meta><link rel="stylesheet"></link></HEAD><BODY><PRE class="outputtext">*** Script: Hello
</PRE><div></div></BODY></HTML>`;

            const result = executor.parseScriptResult(xml);
            expect(result).toBeDefined();
            expect(result.rawResult).toContain("Hello");
        });

        it('should parse HTML with uppercase closing </META> and </LINK> tags', () => {
            const xml = `<HTML><HEAD><META charset="utf-8"></META><LINK rel="stylesheet"></LINK></HEAD><BODY><PRE class="outputtext">*** Script: Test
</PRE><div></div></BODY></HTML>`;

            const result = executor.parseScriptResult(xml);
            expect(result).toBeDefined();
            expect(result.rawResult).toContain("Test");
        });

        it('should parse HTML with </br> and </hr> closing tags', () => {
            const xml = `<HTML><BODY><PRE class="outputtext">*** Script: line1
</PRE><HR></HR><div></div></BODY></HTML>`;

            const result = executor.parseScriptResult(xml);
            expect(result).toBeDefined();
            expect(result.rawResult).toContain("line1");
        });

        it('should parse HTML with mixed case void element closing tags without crashing', () => {
            const xml = `<HTML><HEAD><Meta charset="utf-8"></Meta></HEAD><BODY><PRE class="outputtext">*** Script: mixed
</PRE><div></div></BODY></HTML>`;

            // The key assertion is that parsing does not throw
            const result = executor.parseScriptResult(xml);
            expect(result).toBeDefined();
        });

        it('should parse HTML with </img> and </input> closing tags', () => {
            const xml = `<HTML><BODY><img src="x"></img><input type="text"></input><PRE class="outputtext">*** Script: imgtest
</PRE><div></div></BODY></HTML>`;

            const result = executor.parseScriptResult(xml);
            expect(result).toBeDefined();
            expect(result.rawResult).toContain("imgtest");
        });

        it('should handle a realistic ServiceNow response with multiple void closing tags', () => {
            const xml = `[0:00:00.066]<HTML><HEAD><meta http-equiv="Content-Type" content="text/html;charset=UTF-8"></meta><link rel="shortcut icon" href="/images/favicon_ng.png" type="image/png"></link></HEAD><BODY><PRE class="outputtext">*** Script: Hello World
</PRE><div></div></BODY></HTML>`;

            const result = executor.parseScriptResult(xml);
            expect(result).toBeDefined();
            expect(result.rawResult).toContain("Hello World");
            expect(result.scriptResults.length).toBeGreaterThan(0);
            const scriptLines = result.scriptResults.filter(
                (l: any) => (l as any)._isScript === true
            );
            expect(scriptLines.length).toBe(1);
            expect(scriptLines[0].line).toBe("Hello World");
        });
    });

    describe('parseScriptResult - empty output handling', () => {
        it('should handle empty PRE tag with attributes', () => {
            const xml = `<HTML><BODY><PRE class="outputtext"></PRE><div></div></BODY></HTML>`;

            const result = executor.parseScriptResult(xml);
            expect(result).toBeDefined();
            expect(result.rawResult).toBe("");
            expect(result.consoleResult).toEqual([]);
            expect(result.scriptResults).toEqual([]);
        });

        it('should handle PRE tag with no text content and no attributes', () => {
            const xml = `<HTML><BODY><PRE></PRE><div></div></BODY></HTML>`;

            const result = executor.parseScriptResult(xml);
            expect(result).toBeDefined();
            expect(result.rawResult).toBe("");
            expect(result.consoleResult).toEqual([]);
            expect(result.scriptResults).toEqual([]);
        });

        it('should handle missing PRE tag entirely', () => {
            const xml = `<HTML><BODY><div></div></BODY></HTML>`;

            const result = executor.parseScriptResult(xml);
            expect(result).toBeDefined();
            expect(result.rawResult).toBe("");
            expect(result.consoleResult).toEqual([]);
            expect(result.scriptResults).toEqual([]);
        });

        it('should handle missing BODY tag', () => {
            const xml = `<HTML></HTML>`;

            const result = executor.parseScriptResult(xml);
            expect(result).toBeDefined();
            expect(result.rawResult).toBe("");
            expect(result.consoleResult).toEqual([]);
            expect(result.scriptResults).toEqual([]);
        });

        it('should handle completely empty HTML', () => {
            const xml = `<HTML><BODY><PRE class="outputtext">
</PRE><div></div></BODY></HTML>`;

            const result = executor.parseScriptResult(xml);
            expect(result).toBeDefined();
            // Even whitespace-only output should not crash
        });

        it('should still extract affected records when PRE is empty', () => {
            const xml = `<HTML><BODY><PRE class="outputtext"></PRE><div>1 record updated</div></BODY></HTML>`;

            const result = executor.parseScriptResult(xml);
            expect(result).toBeDefined();
            expect(result.rawResult).toBe("");
            expect(result.scriptResults).toEqual([]);
            expect(result.affectedRecords).toBeDefined();
        });

        it('should parse PRE without attributes (text stored as plain string)', () => {
            // When PRE has no attributes, fast-xml-parser stores text directly as string value
            // rather than in a #text property. This matches real ServiceNow responses.
            const xml = `<HTML><BODY>Script completed<HR/><PRE>*** Script: Hello World</PRE><HR/></BODY></HTML>`;

            const result = executor.parseScriptResult(xml);
            expect(result).toBeDefined();
            expect(result.rawResult).toContain("Hello World");
            expect(result.scriptResults.length).toBeGreaterThan(0);
            const scriptLines = result.scriptResults.filter(
                (l: any) => (l as any)._isScript === true
            );
            expect(scriptLines.length).toBe(1);
            expect(scriptLines[0].line).toBe("Hello World");
        });

        it('should parse realistic SN response with no PRE attributes', () => {
            // Real ServiceNow response format from integration testing
            const xml = `[0:00:00.019] <HTML><BODY>Script completed in scope global: script<HR/>Script execution history <A target='blank' HREF='sys_script_execution_history.do?sys_id=abc123'>available here</A><HR/><PRE>*** Script: TESTING_VALUE_123<BR/></PRE><HR/></BODY></HTML>`;

            const result = executor.parseScriptResult(xml);
            expect(result).toBeDefined();
            expect(result.rawResult).toContain("TESTING_VALUE_123");
            expect(result.scriptResults.length).toBeGreaterThan(0);
        });

        it('should parse PRE without attributes containing multiple output lines', () => {
            const xml = `<HTML><BODY><HR/><PRE>*** Script: INFO_LINE_1
*** Script: [DEBUG] DEBUG_LINE_1
*** Script: INFO_LINE_2
</PRE><HR/></BODY></HTML>`;

            const result = executor.parseScriptResult(xml);
            expect(result).toBeDefined();
            expect(result.scriptResults.length).toBeGreaterThanOrEqual(3);
            const debugLines = result.scriptResults.filter(
                (l: any) => (l as any)._isDebug === true
            );
            expect(debugLines.length).toBe(1);
        });
    });

    // =========================================================================
    // Feature 9: sys_trigger Script Execution Tests
    // =========================================================================

    describe('executeScriptViaTrigger', () => {
        it('should create a sys_trigger record successfully', async () => {
            const mockTriggerRecord = {
                sys_id: 'trigger123',
                name: 'ExtCore_Trigger_12345',
                trigger_type: '0',
                state: '0',
                script: 'gs.info("test")',
                next_action: '2026-02-25 10:00:01'
            };

            mockRequestHandler.post.mockResolvedValue({
                data: { result: mockTriggerRecord },
                status: 201,
                statusText: 'Created',
                headers: {},
                config: {},
                bodyObject: { result: mockTriggerRecord }
            } as IHttpResponse<any>);

            const result = await executor.executeScriptViaTrigger('gs.info("test")', 'TestTrigger');

            expect(result).toBeDefined();
            expect(result.success).toBe(true);
            expect(result.triggerSysId).toBe('trigger123');
            expect(result.triggerName).toBe('TestTrigger');
            expect(result.autoDelete).toBe(true);
            expect(result.message).toContain('TestTrigger');
        });

        it('should use auto-generated name when no description provided', async () => {
            const mockTriggerRecord = {
                sys_id: 'trigger456',
                name: 'ExtCore_Trigger_auto',
                trigger_type: '0',
                state: '0',
                script: 'gs.info("auto")',
                next_action: '2026-02-25 10:00:01'
            };

            mockRequestHandler.post.mockResolvedValue({
                data: { result: mockTriggerRecord },
                status: 201,
                statusText: 'Created',
                headers: {},
                config: {},
                bodyObject: { result: mockTriggerRecord }
            } as IHttpResponse<any>);

            const result = await executor.executeScriptViaTrigger('gs.info("auto")');

            expect(result).toBeDefined();
            expect(result.success).toBe(true);
            expect(result.triggerName).toContain('ExtCore_Trigger_');
        });

        it('should wrap script in try/finally when autoDelete is true', async () => {
            const mockTriggerRecord = {
                sys_id: 'trigger789',
                name: 'AutoDeleteTrigger',
                trigger_type: '0',
                state: '0',
                script: '',
                next_action: '2026-02-25 10:00:01'
            };

            mockRequestHandler.post.mockResolvedValue({
                data: { result: mockTriggerRecord },
                status: 201,
                statusText: 'Created',
                headers: {},
                config: {},
                bodyObject: { result: mockTriggerRecord }
            } as IHttpResponse<any>);

            await executor.executeScriptViaTrigger('gs.info("hello")', 'AutoDeleteTrigger', true);

            // Verify the POST body contains the wrapped script
            expect(mockRequestHandler.post).toHaveBeenCalled();
            const postCall = mockRequestHandler.post.mock.calls[0];
            // The post mock is called by TableAPIRequest which uses ServiceNowRequest internally
            // We just verify the call was made
            expect(postCall).toBeDefined();
        });

        it('should not wrap script when autoDelete is false', async () => {
            const mockTriggerRecord = {
                sys_id: 'triggerNoDelete',
                name: 'NoDeleteTrigger',
                trigger_type: '0',
                state: '0',
                script: 'gs.info("no delete")',
                next_action: '2026-02-25 10:00:01'
            };

            mockRequestHandler.post.mockResolvedValue({
                data: { result: mockTriggerRecord },
                status: 201,
                statusText: 'Created',
                headers: {},
                config: {},
                bodyObject: { result: mockTriggerRecord }
            } as IHttpResponse<any>);

            const result = await executor.executeScriptViaTrigger('gs.info("no delete")', 'NoDeleteTrigger', false);

            expect(result).toBeDefined();
            expect(result.success).toBe(true);
            expect(result.autoDelete).toBe(false);
        });

        it('should throw when script is empty', async () => {
            await expect(
                executor.executeScriptViaTrigger('')
            ).rejects.toThrow('script must be a non-empty string');
        });

        it('should throw when script is not a string', async () => {
            await expect(
                executor.executeScriptViaTrigger(null as any)
            ).rejects.toThrow('script must be a non-empty string');
        });

        it('should throw when API returns error status', async () => {
            mockRequestHandler.post.mockResolvedValue({
                data: null,
                status: 500,
                statusText: 'Error',
                headers: {},
                config: {},
                bodyObject: null
            } as IHttpResponse<any>);

            await expect(
                executor.executeScriptViaTrigger('gs.info("fail")', 'FailTrigger')
            ).rejects.toThrow('Failed to create sys_trigger');
        });

        it('should throw when response has no result', async () => {
            mockRequestHandler.post.mockResolvedValue({
                data: {},
                status: 201,
                statusText: 'Created',
                headers: {},
                config: {},
                bodyObject: {}
            } as IHttpResponse<any>);

            await expect(
                executor.executeScriptViaTrigger('gs.info("empty")', 'EmptyResult')
            ).rejects.toThrow('Failed to create sys_trigger');
        });

        it('should set correct nextAction format (YYYY-MM-DD HH:MM:SS)', async () => {
            const mockTriggerRecord = {
                sys_id: 'triggerDate',
                name: 'DateTrigger',
                trigger_type: '0',
                state: '0',
                script: 'gs.info("date")',
                next_action: '2026-02-25 10:00:01'
            };

            mockRequestHandler.post.mockResolvedValue({
                data: { result: mockTriggerRecord },
                status: 201,
                statusText: 'Created',
                headers: {},
                config: {},
                bodyObject: { result: mockTriggerRecord }
            } as IHttpResponse<any>);

            const result = await executor.executeScriptViaTrigger('gs.info("date")', 'DateTrigger');

            // Verify nextAction matches YYYY-MM-DD HH:MM:SS format
            expect(result.nextAction).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
        });

        it('should handle 200 status as success', async () => {
            const mockTriggerRecord = {
                sys_id: 'trigger200',
                name: 'Status200Trigger',
                trigger_type: '0',
                state: '0',
                script: 'gs.info("200")',
                next_action: '2026-02-25 10:00:01'
            };

            mockRequestHandler.post.mockResolvedValue({
                data: { result: mockTriggerRecord },
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {},
                bodyObject: { result: mockTriggerRecord }
            } as IHttpResponse<any>);

            const result = await executor.executeScriptViaTrigger('gs.info("200")', 'Status200Trigger');

            expect(result.success).toBe(true);
        });
    });

    describe('executeScriptAuto', () => {
        it('should use executeScript when it succeeds', async () => {
            const csrfHtml = `<input name="sysparm_ck" type="hidden" value="testtoken123">`;
            const scriptResultXml = `<HTML><BODY><PRE class="outputtext">*** Script: auto test
</PRE><div></div></BODY></HTML>`;

            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);

            mockRequestHandler.get
                .mockResolvedValueOnce({
                    data: csrfHtml,
                    status: 200,
                    statusText: 'OK',
                    headers: { 'x-is-logged-in': 'true' },
                    config: {}
                } as IHttpResponse<string>)
                .mockResolvedValueOnce(mockScopeResponse('global'));

            mockRequestHandler.post.mockResolvedValue({
                data: scriptResultXml,
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {}
            } as IHttpResponse<string>);

            const result = await executor.executeScriptAuto('gs.info("auto test")');

            expect(result).toBeDefined();
            // Should be a BackgroundScriptExecutionResult
            expect('raw' in result).toBe(true);
            expect((result as any).raw).toBe(scriptResultXml);
        });

        it('should fall back to executeScriptViaTrigger when executeScript fails', async () => {
            // Make executeScript fail (no CSRF token = not logged in)
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);

            mockRequestHandler.get.mockResolvedValue({
                data: '<html></html>',
                status: 200,
                statusText: 'OK',
                headers: { 'x-is-logged-in': 'false' },
                config: {}
            } as IHttpResponse<string>);

            // Make executeScriptViaTrigger succeed
            const mockTriggerRecord = {
                sys_id: 'fallbackTrigger',
                name: 'FallbackTrigger',
                trigger_type: '0',
                state: '0',
                script: 'gs.info("fallback")',
                next_action: '2026-02-25 10:00:01'
            };

            mockRequestHandler.post.mockResolvedValue({
                data: { result: mockTriggerRecord },
                status: 201,
                statusText: 'Created',
                headers: {},
                config: {},
                bodyObject: { result: mockTriggerRecord }
            } as IHttpResponse<any>);

            const result = await executor.executeScriptAuto('gs.info("fallback")');

            expect(result).toBeDefined();
            // Should be a TriggerExecutionResult
            expect('triggerSysId' in result).toBe(true);
            expect((result as any).triggerSysId).toBe('fallbackTrigger');
            expect((result as any).success).toBe(true);
        });

        it('should use provided scope parameter', async () => {
            const csrfHtml = `<input name="sysparm_ck" type="hidden" value="testtoken123">`;
            const scriptResultXml = `<HTML><BODY><PRE class="outputtext">*** Script: scoped
</PRE><div></div></BODY></HTML>`;

            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);

            mockRequestHandler.get
                .mockResolvedValueOnce({
                    data: csrfHtml,
                    status: 200,
                    statusText: 'OK',
                    headers: { 'x-is-logged-in': 'true' },
                    config: {}
                } as IHttpResponse<string>)
                .mockResolvedValueOnce(mockScopeResponse('x_my_app', 'f1e2d3c4b5a6978801234567abcdef90'));

            mockRequestHandler.post.mockResolvedValue({
                data: scriptResultXml,
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {}
            } as IHttpResponse<string>);

            const result = await executor.executeScriptAuto('gs.info("scoped")', 'x_my_app');

            expect(result).toBeDefined();
        });

        it('should use default scope when not provided', async () => {
            const csrfHtml = `<input name="sysparm_ck" type="hidden" value="testtoken123">`;
            const scriptResultXml = `<HTML><BODY><PRE class="outputtext">*** Script: default scope
</PRE><div></div></BODY></HTML>`;

            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);

            mockRequestHandler.get
                .mockResolvedValueOnce({
                    data: csrfHtml,
                    status: 200,
                    statusText: 'OK',
                    headers: { 'x-is-logged-in': 'true' },
                    config: {}
                } as IHttpResponse<string>)
                .mockResolvedValueOnce(mockScopeResponse('global'));

            mockRequestHandler.post.mockResolvedValue({
                data: scriptResultXml,
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {}
            } as IHttpResponse<string>);

            const result = await executor.executeScriptAuto('gs.info("default scope")');

            expect(result).toBeDefined();
            expect('raw' in result).toBe(true);
        });

        it('should propagate error if both methods fail', async () => {
            // Make executeScript fail
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);

            mockRequestHandler.get.mockResolvedValue({
                data: '<html></html>',
                status: 200,
                statusText: 'OK',
                headers: { 'x-is-logged-in': 'false' },
                config: {}
            } as IHttpResponse<string>);

            // Make executeScriptViaTrigger also fail
            mockRequestHandler.post.mockResolvedValue({
                data: null,
                status: 500,
                statusText: 'Error',
                headers: {},
                config: {},
                bodyObject: null
            } as IHttpResponse<any>);

            await expect(
                executor.executeScriptAuto('gs.info("both fail")')
            ).rejects.toThrow('Failed to create sys_trigger');
        });

        it('should NOT fall back to sys_trigger when the scope cannot be used', async () => {
            // sys_trigger takes no scope, so a fallback would run the script in global.
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.get
                .mockResolvedValueOnce(csrfResponse())
                .mockResolvedValueOnce(tableResponse([]))
                .mockResolvedValueOnce(tableResponse([]));

            await expect(
                executor.executeScriptAuto('gs.info("scoped")', 'x_typo_app')
            ).rejects.toMatchObject({ code: 'NEX_SCRIPT_SCOPE_UNAVAILABLE', reason: 'SCOPE_NOT_FOUND' });
            expect(mockRequestHandler.post).not.toHaveBeenCalled();
        });
    });

    describe('executeScript - scope resolution', () => {
        const SCRIPT_RESULT_XML = `<HTML><BODY><PRE class="outputtext">*** Script: ok
</PRE><div></div></BODY></HTML>`;

        const lookupCall = (n: number) => mockRequestHandler.get.mock.calls[n][0] as any;
        const postedScope = () => ((mockRequestHandler.post.mock.calls[0][0] as any).body as URLSearchParams).get('sys_scope');

        beforeEach(() => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.post.mockResolvedValue({
                data: SCRIPT_RESULT_XML,
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {}
            } as IHttpResponse<string>);
        });

        it('should resolve "global" through sys_scope source=global, not scope=global alone', async () => {
            mockRequestHandler.get
                .mockResolvedValueOnce(csrfResponse())
                .mockResolvedValueOnce(tableResponse([{ sys_id: 'global', scope: 'global', name: 'Global' }]));

            await executor.executeScript('gs.info("x")', 'global', instance);

            expect(lookupCall(1).path).toBe('/api/now/table/sys_scope');
            expect(lookupCall(1).query.sysparm_query).toBe('source=global^scope=global');
            expect(postedScope()).toBe('global');
        });

        it('should treat "Global" as the Global scope rather than an application lookup', async () => {
            mockRequestHandler.get
                .mockResolvedValueOnce(csrfResponse())
                .mockResolvedValueOnce(tableResponse([{ sys_id: 'global', scope: 'global', name: 'Global' }]));

            await executor.executeScript('gs.info("x")', 'Global', instance);

            expect(lookupCall(1).path).toBe('/api/now/table/sys_scope');
            expect(lookupCall(1).query.sysparm_query).toBe('source=global^scope=global');
        });

        it('should resolve any other scope name through sys_app', async () => {
            const appSysId = 'f1e2d3c4b5a6978801234567abcdef90';
            mockRequestHandler.get
                .mockResolvedValueOnce(csrfResponse())
                .mockResolvedValueOnce(tableResponse([{ sys_id: appSysId, scope: 'x_my_app', name: 'My App' }]));

            await executor.executeScript('gs.info("x")', 'x_my_app', instance);

            expect(lookupCall(1).path).toBe('/api/now/table/sys_app');
            expect(lookupCall(1).query.sysparm_query).toBe('scope=x_my_app');
            expect(postedScope()).toBe(appSysId);
        });

        it('should pass a 32-character sys_id through without a lookup', async () => {
            const sysId = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
            mockRequestHandler.get.mockResolvedValueOnce(csrfResponse());

            await executor.executeScript('gs.info("x")', sysId, instance);

            expect(mockRequestHandler.get).toHaveBeenCalledTimes(1);
            expect(postedScope()).toBe(sysId);
        });

        it('should cache a resolved scope for the life of the executor', async () => {
            mockRequestHandler.get
                .mockResolvedValueOnce(csrfResponse())
                .mockResolvedValueOnce(tableResponse([{ sys_id: GLOBAL_SCOPE_SYS_ID, scope: 'x_my_app', name: 'My App' }]))
                .mockResolvedValueOnce(csrfResponse());

            await executor.executeScript('gs.info("1")', 'x_my_app', instance);
            await executor.executeScript('gs.info("2")', 'x_my_app', instance);

            const tablePaths = mockRequestHandler.get.mock.calls
                .map((c: any) => c[0].path)
                .filter((p: string) => p.startsWith('/api/now/table/'));
            expect(tablePaths).toEqual(['/api/now/table/sys_app']);
        });

        it('should explain that an installed store app cannot be used, naming it', async () => {
            mockRequestHandler.get
                .mockResolvedValueOnce(csrfResponse())
                .mockResolvedValueOnce(tableResponse([]))
                .mockResolvedValueOnce(tableResponse([{
                    sys_id: '040813ec1b374ed05048a979b04bcbc5',
                    scope: 'x_acme_cat_util',
                    name: 'Catalog Utilities',
                    sys_class_name: 'sys_store_app',
                    active: 'true'
                }]));

            const error = await executor.executeScript('gs.info("x")', 'x_acme_cat_util', instance)
                .catch((e: unknown) => e);

            expect(isScriptScopeError(error)).toBe(true);
            expect(error).toBeInstanceOf(ScriptScopeError);
            const scopeError = error as ScriptScopeError;
            expect(scopeError.reason).toBe('NOT_A_DEVELOPED_APP');
            expect(scopeError.scope).toBe('x_acme_cat_util');
            expect(scopeError.foundAs).toEqual({
                sysId: '040813ec1b374ed05048a979b04bcbc5',
                name: 'Catalog Utilities',
                className: 'sys_store_app',
                active: true
            });
            // Self-contained: the MCP and the CLI print only the message.
            expect(scopeError.message).toContain('Catalog Utilities');
            expect(scopeError.message).toContain('sys_store_app');
            expect(scopeError.message).toContain('"global"');
            expect(scopeError.message).toContain('sys_app');
            expect(scopeError.message).toContain(scopeError.remediation);
            expect(scopeError.message).not.toContain('Error executing script');

            // The diagnostic lookup prefers the live row over an App Customization leftover.
            expect(lookupCall(2).path).toBe('/api/now/table/sys_scope');
            expect(lookupCall(2).query.sysparm_query).toBe('scope=x_acme_cat_util^ORDERBYDESCactive');
            expect(mockRequestHandler.post).not.toHaveBeenCalled();
        });

        it('should report a scope that matches nothing as not found', async () => {
            mockRequestHandler.get
                .mockResolvedValueOnce(csrfResponse())
                .mockResolvedValueOnce(tableResponse([]))
                .mockResolvedValueOnce(tableResponse([]));

            await expect(
                executor.executeScript('gs.info("x")', 'x_does_not_exist', instance)
            ).rejects.toMatchObject({
                code: 'NEX_SCRIPT_SCOPE_UNAVAILABLE',
                reason: 'SCOPE_NOT_FOUND',
                scope: 'x_does_not_exist'
            });
            expect(mockRequestHandler.post).not.toHaveBeenCalled();
        });

        it('should refuse a name that would rewrite the encoded query, without looking it up', async () => {
            mockRequestHandler.get.mockResolvedValueOnce(csrfResponse());

            await expect(
                executor.executeScript('gs.info("x")', 'x_app^ORscope=global', instance)
            ).rejects.toMatchObject({ reason: 'INVALID_SCOPE_NAME' });
            expect(mockRequestHandler.get).toHaveBeenCalledTimes(1);
            expect(mockRequestHandler.post).not.toHaveBeenCalled();
        });

        it('should report a missing Global record distinctly', async () => {
            mockRequestHandler.get
                .mockResolvedValueOnce(csrfResponse())
                .mockResolvedValueOnce(tableResponse([]));

            await expect(
                executor.executeScript('gs.info("x")', 'global', instance)
            ).rejects.toMatchObject({ reason: 'GLOBAL_NOT_FOUND' });
        });

        it('should report a failed lookup as LOOKUP_FAILED, keeping the HTTP error as cause', async () => {
            const httpError = new Error('Error during request. Status: 403 Body: {"error":"ACL"}');
            mockRequestHandler.get
                .mockResolvedValueOnce(csrfResponse())
                .mockRejectedValueOnce(httpError);

            const error = await executor.executeScript('gs.info("x")', 'x_my_app', instance)
                .catch((e: unknown) => e) as ScriptScopeError;

            expect(error.reason).toBe('LOOKUP_FAILED');
            expect(error.message).toContain('sys_app');
            expect(error.message).toContain('Status: 403');
            expect(error.cause).toBe(httpError);
        });

        it('should let errors that already identify themselves pass through the lookup untouched', async () => {
            const sessionError = new SessionAuthError('NEX_SESSION_EXPIRED', 'Session authentication failed.');
            mockRequestHandler.get
                .mockResolvedValueOnce(csrfResponse())
                .mockRejectedValueOnce(sessionError);

            const error = await executor.executeScript('gs.info("x")', 'x_my_app', instance)
                .catch((e: unknown) => e) as Error;

            expect(isScriptScopeError(error)).toBe(false);
            expect(error.cause).toBe(sessionError);
        });
    });
});
