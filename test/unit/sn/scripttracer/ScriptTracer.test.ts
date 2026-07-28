import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ScriptTracer } from '../../../../src/sn/scripttracer/ScriptTracer';
import { ScriptTracerOptions, TraceStatement, ScriptTracerAMBMessage } from '../../../../src/sn/scripttracer/ScriptTracerModels';
import { AMBClient } from '../../../../src/sn/amb/AMBClient';
import { ServiceNowInstance } from '../../../../src/sn/ServiceNowInstance';
import { SessionManager } from '../../../../src/comm/http/SessionManager';
import { AuthenticationHandlerFactory } from '../../../../src/auth/AuthenticationHandlerFactory';
import { RequestHandlerFactory } from '../../../../src/comm/http/RequestHandlerFactory';
import { IHttpResponse } from '../../../../src/comm/http/IHttpResponse';
import { MockAuthenticationHandler } from '../../__mocks__/servicenow-sdk-mocks';

jest.mock('../../../../src/auth/AuthenticationHandlerFactory');
jest.mock('../../../../src/comm/http/RequestHandlerFactory');

class MockRequestHandler {
    get = jest.fn<() => Promise<IHttpResponse<unknown>>>();
    post = jest.fn<() => Promise<IHttpResponse<unknown>>>();
    put = jest.fn<() => Promise<IHttpResponse<unknown>>>();
    delete = jest.fn<() => Promise<IHttpResponse<unknown>>>();
}

function createMockChannel() {
    return {
        subscribe: jest.fn(),
        unsubscribe: jest.fn(),
    };
}

function createMockAMBClient(): Partial<AMBClient> {
    const serverConnection = {
        getUserToken: jest.fn().mockReturnValue('abcdef1234567890abcdef1234567890extra'),
    };
    return {
        getChannel: jest.fn().mockReturnValue(createMockChannel()),
        getServerConnection: jest.fn().mockReturnValue(serverConnection),
    };
}

function createMockInstance(): ServiceNowInstance {
    return {
        getAlias: jest.fn().mockReturnValue('test-instance'),
        getHost: jest.fn().mockReturnValue('https://test.service-now.com'),
    } as unknown as ServiceNowInstance;
}

function createSuccessResponse<T>(data: T): IHttpResponse<T> {
    return {
        data: JSON.stringify(data) as unknown as T,
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {},
        bodyObject: data,
    };
}

describe('ScriptTracer', () => {
    let mockAMBClient: Partial<AMBClient>;
    let mockInstance: ServiceNowInstance;
    let mockAuthHandler: MockAuthenticationHandler;
    let mockRequestHandler: MockRequestHandler;

    beforeEach(() => {
        jest.clearAllMocks();
        SessionManager.resetInstance();

        mockAuthHandler = new MockAuthenticationHandler();
        mockRequestHandler = new MockRequestHandler();

        jest.spyOn(AuthenticationHandlerFactory, 'createAuthHandler')
            .mockReturnValue(mockAuthHandler as unknown as ReturnType<typeof AuthenticationHandlerFactory.createAuthHandler>);
        jest.spyOn(RequestHandlerFactory, 'createRequestHandler')
            .mockReturnValue(mockRequestHandler as unknown as ReturnType<typeof RequestHandlerFactory.createRequestHandler>);

        mockAMBClient = createMockAMBClient();
        mockInstance = createMockInstance();
    });

    describe('constructor', () => {
        it('initializes with idle state', () => {
            const tracer = new ScriptTracer(mockAMBClient as AMBClient, mockInstance);
            expect(tracer.state).toBe('idle');
        });

        it('stores AMBClient and instance', () => {
            const tracer = new ScriptTracer(mockAMBClient as AMBClient, mockInstance);
            expect(tracer.state).toBe('idle');
            expect(tracer.traceStatements).toEqual([]);
        });

        it('initializes with empty trace statements', () => {
            const tracer = new ScriptTracer(mockAMBClient as AMBClient, mockInstance);
            expect(tracer.traceStatements).toEqual([]);
        });

        it('sessionId is null before start', () => {
            const tracer = new ScriptTracer(mockAMBClient as AMBClient, mockInstance);
            expect(tracer.sessionId).toBeNull();
        });
    });

    describe('deriveSessionId', () => {
        it('returns first 32 chars upper-cased', () => {
            const tracer = new ScriptTracer(mockAMBClient as AMBClient, mockInstance);
            const result = (tracer as any).deriveSessionId('abcdef1234567890abcdef1234567890extra');
            expect(result).toBe('ABCDEF1234567890ABCDEF1234567890');
        });

        it('handles exact 32-char token', () => {
            const tracer = new ScriptTracer(mockAMBClient as AMBClient, mockInstance);
            const result = (tracer as any).deriveSessionId('abcdef1234567890abcdef1234567890');
            expect(result).toBe('ABCDEF1234567890ABCDEF1234567890');
        });

        it('handles short tokens gracefully', () => {
            const tracer = new ScriptTracer(mockAMBClient as AMBClient, mockInstance);
            const result = (tracer as any).deriveSessionId('short');
            expect(result).toBe('SHORT');
        });

        it('handles empty token', () => {
            const tracer = new ScriptTracer(mockAMBClient as AMBClient, mockInstance);
            const result = (tracer as any).deriveSessionId('');
            expect(result).toBe('');
        });
    });

    describe('start()', () => {
        it('transitions idle → starting → tracing', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.post.mockResolvedValue(
                createSuccessResponse({ result: { token: 'ABCDEF1234567890ABCDEF1234567890' } })
            );

            const tracer = new ScriptTracer(mockAMBClient as AMBClient, mockInstance);
            const result = await tracer.start();

            expect(result.success).toBe(true);
            expect(tracer.state).toBe('tracing');
        });

        it('calls debugger/start then scripttracer/start', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.post.mockResolvedValue(
                createSuccessResponse({ result: { token: 'ABCDEF1234567890ABCDEF1234567890' } })
            );

            const tracer = new ScriptTracer(mockAMBClient as AMBClient, mockInstance);
            await tracer.start();

            const postCalls = mockRequestHandler.post.mock.calls;
            expect(postCalls.length).toBe(2);

            const firstCallPath = (postCalls[0] as any)[0].path;
            const secondCallPath = (postCalls[1] as any)[0].path;
            expect(firstCallPath).toContain('debugger/start');
            expect(secondCallPath).toContain('scripttracer/start');
        });

        it('uses SessionManager to get request', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.post.mockResolvedValue(
                createSuccessResponse({ result: { token: 'ABCDEF1234567890ABCDEF1234567890' } })
            );

            const tracer = new ScriptTracer(mockAMBClient as AMBClient, mockInstance);
            await tracer.start();

            // Verify SessionManager was used (request handler post was called)
            expect(mockRequestHandler.post).toHaveBeenCalled();
        });

        it('subscribes to /scripttracer/{sessionId}', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.post.mockResolvedValue(
                createSuccessResponse({ result: { token: 'ABCDEF1234567890ABCDEF1234567890' } })
            );

            const tracer = new ScriptTracer(mockAMBClient as AMBClient, mockInstance);
            await tracer.start();

            const getChannelCalls = (mockAMBClient.getChannel as jest.Mock).mock.calls;
            const channelNames = getChannelCalls.map((c: any) => c[0]);
            const sessionId = tracer.sessionId;
            expect(channelNames).toContain(`/scripttracer/${sessionId}`);
        });

        it('subscribes to /debugger/watcher/console/{sessionId}', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.post.mockResolvedValue(
                createSuccessResponse({ result: { token: 'ABCDEF1234567890ABCDEF1234567890' } })
            );

            const tracer = new ScriptTracer(mockAMBClient as AMBClient, mockInstance);
            await tracer.start();

            const getChannelCalls = (mockAMBClient.getChannel as jest.Mock).mock.calls;
            const channelNames = getChannelCalls.map((c: any) => c[0]);
            const sessionId = tracer.sessionId;
            expect(channelNames).toContain(`/debugger/watcher/console/${sessionId}`);
        });

        it('subscribes to /debugger/watcher/{sessionId}', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.post.mockResolvedValue(
                createSuccessResponse({ result: { token: 'ABCDEF1234567890ABCDEF1234567890' } })
            );

            const tracer = new ScriptTracer(mockAMBClient as AMBClient, mockInstance);
            await tracer.start();

            const getChannelCalls = (mockAMBClient.getChannel as jest.Mock).mock.calls;
            const channelNames = getChannelCalls.map((c: any) => c[0]);
            const sessionId = tracer.sessionId;
            expect(channelNames).toContain(`/debugger/watcher/${sessionId}`);
        });

        it('subscribes to /debugger/sessionlog/{sessionId}', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.post.mockResolvedValue(
                createSuccessResponse({ result: { token: 'ABCDEF1234567890ABCDEF1234567890' } })
            );

            const tracer = new ScriptTracer(mockAMBClient as AMBClient, mockInstance);
            await tracer.start();

            const getChannelCalls = (mockAMBClient.getChannel as jest.Mock).mock.calls;
            const channelNames = getChannelCalls.map((c: any) => c[0]);
            const sessionId = tracer.sessionId;
            expect(channelNames).toContain(`/debugger/sessionlog/${sessionId}`);
        });

        it('returns success with sessionId', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.post.mockResolvedValue(
                createSuccessResponse({ result: { token: 'ABCDEF1234567890ABCDEF1234567890' } })
            );

            const tracer = new ScriptTracer(mockAMBClient as AMBClient, mockInstance);
            const result = await tracer.start();

            expect(result.success).toBe(true);
            expect(result.sessionId).toBeDefined();
            expect(result.sessionId!.length).toBeGreaterThan(0);
        });

        it('throws on REST failure', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.post.mockRejectedValue(new Error('Network error'));

            const tracer = new ScriptTracer(mockAMBClient as AMBClient, mockInstance);
            await expect(tracer.start()).rejects.toThrow('Network error');
            expect(tracer.state).toBe('error');
        });

        it('throws if already tracing', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.post.mockResolvedValue(
                createSuccessResponse({ result: { token: 'ABCDEF1234567890ABCDEF1234567890' } })
            );

            const tracer = new ScriptTracer(mockAMBClient as AMBClient, mockInstance);
            await tracer.start();

            await expect(tracer.start()).rejects.toThrow(/already/i);
        });
    });

    describe('stop()', () => {
        it('calls scripttracer/stop', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.post.mockResolvedValue(
                createSuccessResponse({ result: { token: 'ABCDEF1234567890ABCDEF1234567890' } })
            );

            const tracer = new ScriptTracer(mockAMBClient as AMBClient, mockInstance);
            await tracer.start();

            mockRequestHandler.post.mockClear();
            mockRequestHandler.post.mockResolvedValue(
                createSuccessResponse({ result: {} })
            );

            const result = await tracer.stop();

            const postCalls = mockRequestHandler.post.mock.calls;
            expect(postCalls.length).toBe(1);
            expect((postCalls[0] as any)[0].path).toContain('scripttracer/stop');
            expect(result.success).toBe(true);
        });

        it('unsubscribes from all channels', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.post.mockResolvedValue(
                createSuccessResponse({ result: { token: 'ABCDEF1234567890ABCDEF1234567890' } })
            );

            const mockChannel = createMockChannel();
            (mockAMBClient.getChannel as jest.Mock).mockReturnValue(mockChannel);

            const tracer = new ScriptTracer(mockAMBClient as AMBClient, mockInstance);
            await tracer.start();

            mockRequestHandler.post.mockClear();
            mockRequestHandler.post.mockResolvedValue(
                createSuccessResponse({ result: {} })
            );

            await tracer.stop();

            expect(mockChannel.unsubscribe).toHaveBeenCalled();
        });

        it('transitions to stopped', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.post.mockResolvedValue(
                createSuccessResponse({ result: { token: 'ABCDEF1234567890ABCDEF1234567890' } })
            );

            const tracer = new ScriptTracer(mockAMBClient as AMBClient, mockInstance);
            await tracer.start();

            mockRequestHandler.post.mockClear();
            mockRequestHandler.post.mockResolvedValue(
                createSuccessResponse({ result: {} })
            );

            await tracer.stop();
            expect(tracer.state).toBe('stopped');
        });

        it('throws if not tracing', async () => {
            const tracer = new ScriptTracer(mockAMBClient as AMBClient, mockInstance);
            await expect(tracer.stop()).rejects.toThrow(/not.*trac/i);
        });
    });

    describe('trace handling', () => {
        function setupChannelListenerCapture(ambClient: Partial<AMBClient>) {
            const listeners = new Map<string, (msg: any) => void>();
            (ambClient.getChannel as jest.Mock).mockImplementation((channelName: string) => ({
                subscribe: jest.fn().mockImplementation((listener: any) => {
                    listeners.set(channelName, listener);
                }),
                unsubscribe: jest.fn(),
            }));
            return listeners;
        }

        it('collects statements from AMB messages', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.post.mockResolvedValue(
                createSuccessResponse({ result: { token: 'ABCDEF1234567890ABCDEF1234567890' } })
            );

            const listeners = setupChannelListenerCapture(mockAMBClient);

            const tracer = new ScriptTracer(mockAMBClient as AMBClient, mockInstance);
            await tracer.start();

            const sid = tracer.sessionId;
            const traceListener = listeners.get(`/scripttracer/${sid}`);
            expect(traceListener).toBeDefined();

            traceListener!({
                data: {
                    sent_by: 12345,
                    traceStatements: [{
                        scriptField: 'script',
                        fileName: 'test rule',
                        fileTypeLabel: 'Business Rule',
                        currentField: 'condition',
                        tableName: 'incident',
                        tableLabel: 'Incident',
                        scriptKey: 'sys_script.abc123.condition',
                        condition: 'true',
                        linesContext: { currentLineNumber: 1, startLineNumber: 1, content: 'gs.log("test")' },
                        diff: [{ previous: null, name: 'state', value: '1' }],
                        state: {},
                    }],
                },
            });

            expect(tracer.traceStatements.length).toBe(1);
            expect(tracer.traceStatements[0].fileName).toBe('test rule');
        });

        it('invokes onTrace callback', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.post.mockResolvedValue(
                createSuccessResponse({ result: { token: 'ABCDEF1234567890ABCDEF1234567890' } })
            );

            const listeners = setupChannelListenerCapture(mockAMBClient);

            const onTrace = jest.fn();
            const tracer = new ScriptTracer(mockAMBClient as AMBClient, mockInstance, { onTrace });
            await tracer.start();

            const sid = tracer.sessionId;
            const traceListener = listeners.get(`/scripttracer/${sid}`);

            const traceMsg: ScriptTracerAMBMessage = {
                data: {
                    sent_by: 12345,
                    traceStatements: [{
                        scriptField: 'script',
                        fileName: 'callback test',
                        fileTypeLabel: 'Business Rule',
                        currentField: 'script',
                        tableName: 'incident',
                        tableLabel: 'Incident',
                        scriptKey: 'sys_script.xyz.script',
                        condition: '',
                        linesContext: { currentLineNumber: 1, startLineNumber: 1, content: '' },
                        diff: [],
                        state: {},
                    }],
                },
            };

            traceListener!(traceMsg);
            expect(onTrace).toHaveBeenCalledWith(traceMsg.data.traceStatements);
        });

        it('clearTraceStatements resets', async () => {
            mockAuthHandler.isLoggedIn = jest.fn().mockReturnValue(true);
            mockRequestHandler.post.mockResolvedValue(
                createSuccessResponse({ result: { token: 'ABCDEF1234567890ABCDEF1234567890' } })
            );

            const listeners = setupChannelListenerCapture(mockAMBClient);

            const tracer = new ScriptTracer(mockAMBClient as AMBClient, mockInstance);
            await tracer.start();

            const sid = tracer.sessionId;
            const traceListener = listeners.get(`/scripttracer/${sid}`);

            traceListener!({
                data: {
                    sent_by: 1,
                    traceStatements: [{
                        scriptField: 'script', fileName: 'x', fileTypeLabel: 'BR',
                        currentField: 's', tableName: 't', tableLabel: 'T',
                        scriptKey: 'k', condition: '', linesContext: { currentLineNumber: 1, startLineNumber: 1, content: '' },
                        diff: [], state: {},
                    }],
                },
            });

            expect(tracer.traceStatements.length).toBe(1);
            tracer.clearTraceStatements();
            expect(tracer.traceStatements.length).toBe(0);
        });
    });
});
