import {afterEach, describe, expect, it} from '@jest/globals';
import {
    DesktopBrowserError,
    injectBrowserSessionCdp,
    isDesktopBrowserError,
} from '../../../src/auth/DesktopBrowserSession';
import type {BrowserSession} from '../../../src/auth/BrowserSession';
import type {CdpSocket} from '../../../src/auth/DesktopBrowserSession';
import {listenCdp} from '../../test_utils/cdp-fixture';

const instanceUrl = 'https://example.service-now.com';
const cookieValue = 'synthetic-cookie';
const session: BrowserSession = {
    alias: 'fixture',
    instanceUrl,
    createdAt: 0,
    storageState: {
        origins: [],
        cookies: [{
            name: 'JSESSIONID',
            value: cookieValue,
            domain: 'example.service-now.com',
            path: '/',
            expires: -1,
            secure: true,
            httpOnly: true,
            sameSite: 'Lax',
        }],
    },
};

type Listener = (data?: unknown) => void;
type Encode = 'string' | 'uint8';

class FakeWebSocket implements CdpSocket {
    static sent: Record<string, unknown>[] = [];
    static failMethods = new Set<string>();
    static omitResult = new Set<string>();
    static extraMessages: unknown[] = [];
    static encode: Encode = 'string';
    static failOpen = false;
    static startOpen = false;
    static throwOnSend = false;
    readyState = 0;
    private readonly listeners = new Map<string, Listener[]>();

    constructor(public readonly url: string) {
        if (FakeWebSocket.startOpen) {
            this.readyState = 1;
            return;
        }
        queueMicrotask(() => {
            if (FakeWebSocket.failOpen) {
                this.emit('error', new Error('connect failed'));
                return;
            }
            this.readyState = 1;
            this.emit('open');
        });
    }

    on(event: 'open' | 'message' | 'error' | 'close', listener: Listener): this {
        const list = this.listeners.get(event) ?? [];
        list.push(listener);
        this.listeners.set(event, list);
        return this;
    }

    once(event: 'open' | 'message' | 'error' | 'close', listener: Listener): this {
        const wrapped: Listener = data => {
            this.off(event, wrapped);
            listener(data);
        };
        return this.on(event, wrapped);
    }

    send(data: string): void {
        if (FakeWebSocket.throwOnSend) throw new Error('socket closed');
        const message = JSON.parse(data) as Record<string, unknown>;
        FakeWebSocket.sent.push(message);
        const id = message.id;
        const method = String(message.method);
        queueMicrotask(() => {
            for (const extra of FakeWebSocket.extraMessages) this.emit('message', extra);
            if (FakeWebSocket.failMethods.has(method)) {
                this.emit('message', this.encodeMessage({id, error: {message: 'unsupported'}}));
                return;
            }
            const result: Record<string, unknown> = {};
            if (method === 'Target.createTarget' && !FakeWebSocket.omitResult.has(method)) {
                result.targetId = 'target-1';
            }
            if (method === 'Target.attachToTarget' && !FakeWebSocket.omitResult.has(method)) {
                result.sessionId = 'session-1';
            }
            this.emit('message', this.encodeMessage({id, result}));
        });
    }

    close(): void {
        this.readyState = 3;
        this.emit('close');
    }

    private encodeMessage(payload: Record<string, unknown>): unknown {
        const text = JSON.stringify(payload);
        if (FakeWebSocket.encode === 'uint8') return new TextEncoder().encode(text);
        return text;
    }

    private off(event: string, listener: Listener): void {
        const list = this.listeners.get(event);
        if (!list) return;
        this.listeners.set(event, list.filter(item => item !== listener));
    }

    private emit(event: string, data?: unknown): void {
        for (const listener of [...(this.listeners.get(event) ?? [])]) listener(data);
    }
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {'Content-Type': 'application/json'},
    });
}

function pageFetch(): typeof fetch {
    return (async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === '/json/version') {
            return jsonResponse({webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser'});
        }
        if (url.pathname === '/json/list' || url.pathname === '/json') {
            return jsonResponse([{type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1'}]);
        }
        throw new Error(`unexpected ${url.pathname}`);
    }) as typeof fetch;
}

function browserOnlyFetch(): typeof fetch {
    return (async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === '/json/version') {
            return jsonResponse({webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser'});
        }
        if (url.pathname === '/json/list' || url.pathname === '/json') return jsonResponse([]);
        throw new Error(`unexpected ${url.pathname}`);
    }) as typeof fetch;
}

afterEach(() => {
    FakeWebSocket.sent = [];
    FakeWebSocket.failMethods.clear();
    FakeWebSocket.omitResult.clear();
    FakeWebSocket.extraMessages = [];
    FakeWebSocket.encode = 'string';
    FakeWebSocket.failOpen = false;
    FakeWebSocket.startOpen = false;
    FakeWebSocket.throwOnSend = false;
});

describe('isDesktopBrowserError', () => {
    it('accepts only the desktop codes with a remediation string', () => {
        expect(isDesktopBrowserError(new DesktopBrowserError('NEX_BROWSER_UNAVAILABLE', 'retry')))
            .toBe(true);
        expect(isDesktopBrowserError(new DesktopBrowserError('NEX_BROWSER_PROTOCOL', 'retry')))
            .toBe(true);
        expect(isDesktopBrowserError(null)).toBe(false);
        expect(isDesktopBrowserError({code: 'NEX_BROWSER_PROTOCOL'})).toBe(false);
        expect(isDesktopBrowserError({code: 'NEX_AUTH_INVALID', remediation: 'no'})).toBe(false);
    });
});

describe('injectBrowserSessionCdp', () => {
    it('sets cookies and navigates a page target without logging secrets', async () => {
        await injectBrowserSessionCdp({
            cdpUrl: 'http://127.0.0.1:9222',
            session,
            fetch: pageFetch(),
            WebSocket: FakeWebSocket,
        });
        const methods = FakeWebSocket.sent.map(message => message.method);
        expect(methods).toContain('Storage.setCookies');
        expect(methods).toContain('Page.navigate');
        expect(methods).not.toContain('Target.createTarget');
        const cookies = FakeWebSocket.sent.find(message => message.method === 'Storage.setCookies')
            ?.params as {cookies: Array<{name: string; value: string; expires?: number}>};
        expect(cookies.cookies).toEqual([expect.objectContaining({
            name: 'JSESSIONID',
            value: cookieValue,
            domain: 'example.service-now.com',
            url: instanceUrl,
        })]);
        expect(cookies.cookies[0]).not.toHaveProperty('expires');
        expect(FakeWebSocket.sent.find(message => message.method === 'Page.navigate')?.params)
            .toEqual({url: instanceUrl});
        expect(JSON.stringify(methods)).not.toContain(cookieValue);
    });

    it('strips a leading-dot domain, defaults path, and keeps a finite expiry', async () => {
        const dotted: BrowserSession = {
            ...session,
            storageState: {
                origins: [],
                cookies: [{
                    ...session.storageState.cookies[0],
                    domain: '.example.service-now.com',
                    path: '',
                    expires: 1_800_000_000,
                }],
            },
        };
        await injectBrowserSessionCdp({
            cdpUrl: 'https://127.0.0.1:9222',
            session: dotted,
            fetch: pageFetch(),
            WebSocket: FakeWebSocket,
        });
        expect(FakeWebSocket.sent.find(message => message.method === 'Storage.setCookies')?.params)
            .toEqual({
                cookies: [expect.objectContaining({
                    domain: 'example.service-now.com',
                    path: '/',
                    expires: 1_800_000_000,
                })],
            });
    });

    it('falls back to Network.setCookie for every cookie when Storage.setCookies is rejected', async () => {
        FakeWebSocket.failMethods.add('Storage.setCookies');
        const lasting: BrowserSession = {
            ...session,
            storageState: {
                origins: [],
                cookies: [
                    {...session.storageState.cookies[0], expires: 1_800_000_000},
                    {...session.storageState.cookies[0], name: 'glide_user_route', expires: 0},
                ],
            },
        };
        await injectBrowserSessionCdp({
            cdpUrl: 'http://127.0.0.1:9222/',
            session: lasting,
            fetch: pageFetch(),
            WebSocket: FakeWebSocket,
        });
        const setCookies = FakeWebSocket.sent.filter(message => message.method === 'Network.setCookie');
        expect(setCookies).toHaveLength(2);
        expect(setCookies[0]?.params).toEqual(expect.objectContaining({
            name: 'JSESSIONID',
            expires: 1_800_000_000,
        }));
        expect(setCookies[1]?.params).toEqual(expect.objectContaining({name: 'glide_user_route'}));
        expect(setCookies[1]?.params).not.toHaveProperty('expires');
    });

    it('creates a page when DevTools only exposes the browser socket', async () => {
        FakeWebSocket.startOpen = true;
        await injectBrowserSessionCdp({
            cdpUrl: 'http://127.0.0.1:9222',
            session,
            fetch: browserOnlyFetch(),
            WebSocket: FakeWebSocket,
        });
        expect(FakeWebSocket.sent.map(message => message.method)).toEqual(expect.arrayContaining([
            'Target.createTarget',
            'Target.attachToTarget',
            'Storage.setCookies',
            'Page.navigate',
        ]));
        expect(FakeWebSocket.sent.find(message => message.method === 'Page.navigate')?.sessionId)
            .toBe('session-1');
    });

    it('uses /json when /json/list is unusable and ignores non-page targets', async () => {
        const fetchImpl = (async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === '/json/version') {
                return jsonResponse({webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser'});
            }
            if (url.pathname === '/json/list') return jsonResponse({not: 'array'}, 500);
            if (url.pathname === '/json') {
                return jsonResponse([
                    {type: 'iframe'},
                    {type: 'page'},
                    {type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/2'},
                ]);
            }
            throw new Error(`unexpected ${url.pathname}`);
        }) as typeof fetch;
        await injectBrowserSessionCdp({
            cdpUrl: 'http://127.0.0.1:9222',
            session,
            fetch: fetchImpl,
            WebSocket: FakeWebSocket,
        });
        expect(FakeWebSocket.sent[0] && 'sessionId' in FakeWebSocket.sent[0]).toBe(false);
        expect(FakeWebSocket.sent.map(message => message.method)).toContain('Page.navigate');
    });

    it('retries version discovery until DevTools answers', async () => {
        let attempts = 0;
        const fetchImpl = (async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === '/json/version') {
                attempts += 1;
                if (attempts === 1) throw new Error('not ready');
                if (attempts === 2) return jsonResponse(['not', 'an', 'object']);
                return jsonResponse({webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser'});
            }
            if (url.pathname === '/json/list' || url.pathname === '/json') {
                return jsonResponse([{type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/1'}]);
            }
            throw new Error(`unexpected ${url.pathname}`);
        }) as typeof fetch;
        await injectBrowserSessionCdp({
            cdpUrl: 'http://127.0.0.1:9222',
            session,
            timeoutMs: 2_000,
            fetch: fetchImpl,
            WebSocket: FakeWebSocket,
        });
        expect(attempts).toBeGreaterThanOrEqual(3);
        expect(FakeWebSocket.sent.map(message => message.method)).toContain('Page.navigate');
    });

    it('decodes binary DevTools frames and ignores uncorrelated messages', async () => {
        FakeWebSocket.encode = 'uint8';
        FakeWebSocket.extraMessages = ['not-json', '{"no":"id"}'];
        await injectBrowserSessionCdp({
            cdpUrl: 'http://127.0.0.1:9222',
            session,
            fetch: pageFetch(),
            WebSocket: FakeWebSocket,
        });
        expect(FakeWebSocket.sent.map(message => message.method)).toContain('Page.navigate');
    });

    it('rejects credential-bearing, non-HTTP, or malformed DevTools URLs', async () => {
        await expect(injectBrowserSessionCdp({
            cdpUrl: 'http://user:pass@127.0.0.1:9222',
            session,
        })).rejects.toMatchObject({code: 'NEX_BROWSER_UNAVAILABLE'});
        await expect(injectBrowserSessionCdp({
            cdpUrl: 'http://user@127.0.0.1:9222',
            session,
        })).rejects.toMatchObject({code: 'NEX_BROWSER_UNAVAILABLE'});
        await expect(injectBrowserSessionCdp({
            cdpUrl: 'ws://127.0.0.1:9222',
            session,
        })).rejects.toMatchObject({code: 'NEX_BROWSER_UNAVAILABLE'});
        await expect(injectBrowserSessionCdp({
            cdpUrl: 'not-a-url',
            session,
        })).rejects.toMatchObject({code: 'NEX_BROWSER_UNAVAILABLE'});
    });

    it('rejects an unverified or unusable session before opening a socket', async () => {
        await expect(injectBrowserSessionCdp({
            cdpUrl: 'http://127.0.0.1:9222',
            session: {...session, instanceUrl: ''},
        })).rejects.toMatchObject({code: 'NEX_BROWSER_PROTOCOL'});
        await expect(injectBrowserSessionCdp({
            cdpUrl: 'http://127.0.0.1:9222',
            session: {...session, instanceUrl: 'not a url'},
        })).rejects.toMatchObject({code: 'NEX_BROWSER_PROTOCOL'});
        await expect(injectBrowserSessionCdp({
            cdpUrl: 'http://127.0.0.1:9222',
            session: {...session, storageState: {origins: [], cookies: undefined as unknown as []}},
        })).rejects.toMatchObject({code: 'NEX_BROWSER_PROTOCOL'});
    });

    it('times out when the debug port never answers', async () => {
        const fetchImpl = (async () => { throw new Error(`JSESSIONID=${cookieValue}`); }) as typeof fetch;
        try {
            await injectBrowserSessionCdp({
                cdpUrl: 'http://127.0.0.1:9',
                session,
                timeoutMs: 40,
                fetch: fetchImpl,
                WebSocket: FakeWebSocket,
            });
            throw new Error('expected failure');
        } catch (error: unknown) {
            expect(error).toMatchObject({code: 'NEX_BROWSER_UNAVAILABLE'});
            expect(String(error)).not.toContain(cookieValue);
        }
    });

    it('fails closed when DevTools exposes no websocket', async () => {
        const fetchImpl = (async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            if (url.pathname === '/json/version') return jsonResponse({});
            if (url.pathname === '/json/list' || url.pathname === '/json') return jsonResponse([]);
            throw new Error(`unexpected ${url.pathname}`);
        }) as typeof fetch;
        await expect(injectBrowserSessionCdp({
            cdpUrl: 'http://127.0.0.1:9222',
            session,
            fetch: fetchImpl,
            WebSocket: FakeWebSocket,
        })).rejects.toMatchObject({code: 'NEX_BROWSER_UNAVAILABLE'});
    });

    it('fails closed when the page attach handshake is incomplete', async () => {
        FakeWebSocket.omitResult.add('Target.createTarget');
        await expect(injectBrowserSessionCdp({
            cdpUrl: 'http://127.0.0.1:9222',
            session,
            fetch: browserOnlyFetch(),
            WebSocket: FakeWebSocket,
        })).rejects.toMatchObject({code: 'NEX_BROWSER_PROTOCOL'});
        FakeWebSocket.omitResult.clear();
        FakeWebSocket.sent = [];
        FakeWebSocket.omitResult.add('Target.attachToTarget');
        await expect(injectBrowserSessionCdp({
            cdpUrl: 'http://127.0.0.1:9222',
            session,
            fetch: browserOnlyFetch(),
            WebSocket: FakeWebSocket,
        })).rejects.toMatchObject({code: 'NEX_BROWSER_PROTOCOL'});
    });

    it('treats a socket that never opens as unavailable', async () => {
        FakeWebSocket.failOpen = true;
        await expect(injectBrowserSessionCdp({
            cdpUrl: 'http://127.0.0.1:9222',
            session,
            fetch: pageFetch(),
            WebSocket: FakeWebSocket,
        })).rejects.toMatchObject({code: 'NEX_BROWSER_UNAVAILABLE'});
    });

    it('sanitizes protocol failures and unexpected inject errors', async () => {
        FakeWebSocket.failMethods.add('Network.enable');
        try {
            await injectBrowserSessionCdp({
                cdpUrl: 'http://127.0.0.1:9222',
                session,
                fetch: pageFetch(),
                WebSocket: FakeWebSocket,
            });
            throw new Error('expected failure');
        } catch (error: unknown) {
            expect(isDesktopBrowserError(error)).toBe(true);
            expect(error).toBeInstanceOf(DesktopBrowserError);
            expect(String(error)).not.toContain(cookieValue);
        }

        FakeWebSocket.failMethods.clear();
        FakeWebSocket.throwOnSend = true;
        await expect(injectBrowserSessionCdp({
            cdpUrl: 'http://127.0.0.1:9222',
            session,
            fetch: pageFetch(),
            WebSocket: FakeWebSocket,
        })).rejects.toMatchObject({code: 'NEX_BROWSER_PROTOCOL'});

        FakeWebSocket.throwOnSend = false;
        const exploding = {
            ...session,
            storageState: {
                origins: [] as [],
                cookies: [Object.defineProperty({...session.storageState.cookies[0]}, 'name', {
                    get() { throw new Error(`boom-${cookieValue}`); },
                })],
            },
        };
        try {
            await injectBrowserSessionCdp({
                cdpUrl: 'http://127.0.0.1:9222',
                session: exploding,
                fetch: pageFetch(),
                WebSocket: FakeWebSocket,
            });
            throw new Error('expected failure');
        } catch (error: unknown) {
            expect(error).toMatchObject({code: 'NEX_BROWSER_PROTOCOL'});
            expect(String(error)).not.toContain(cookieValue);
        }
    });
});

describe('injectBrowserSessionCdp against a real DevTools fixture', () => {
    it('uses the default WebSocket client to set cookies and navigate', async () => {
        const cdp = await listenCdp();
        try {
            await injectBrowserSessionCdp({cdpUrl: cdp.url, session});
            expect(cdp.messages.map(message => message.method)).toEqual(expect.arrayContaining([
                'Storage.setCookies',
                'Page.navigate',
            ]));
            expect(cdp.messages.find(message => message.method === 'Page.navigate')?.params)
                .toEqual({url: instanceUrl});
        } finally {
            await cdp.close();
        }
    });
});
