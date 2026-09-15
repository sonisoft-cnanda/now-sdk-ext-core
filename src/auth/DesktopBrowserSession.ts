import { WebSocket as WsWebSocket } from 'ws';
import type { BrowserCookie, BrowserSession } from './BrowserSession';

/** Desktop / DevTools failures safe to expose across CLI and embedders. */
export class DesktopBrowserError extends Error {
    constructor(
        public readonly code: 'NEX_BROWSER_UNAVAILABLE' | 'NEX_BROWSER_PROTOCOL',
        public readonly remediation: string,
    ) {
        super(remediation);
        this.name = 'DesktopBrowserError';
    }
}

export function isDesktopBrowserError(error: unknown): error is DesktopBrowserError {
    if (!error || typeof error !== 'object') return false;
    const value = error as { code?: unknown; remediation?: unknown };
    return (value.code === 'NEX_BROWSER_UNAVAILABLE' || value.code === 'NEX_BROWSER_PROTOCOL') &&
        typeof value.remediation === 'string';
}

/** Minimal WebSocket surface used by CDP. `ws` and test fakes both satisfy this. */
export interface CdpSocket {
    readonly readyState: number;
    on(event: 'open' | 'message' | 'error' | 'close', listener: (data?: unknown) => void): unknown;
    once(event: 'open' | 'message' | 'error' | 'close', listener: (data?: unknown) => void): unknown;
    send(data: string): void;
    close(): void;
}

export interface CdpWebSocketConstructor {
    new (url: string): CdpSocket;
}

export interface InjectBrowserSessionCdpOptions {
    cdpUrl: string;
    session: BrowserSession;
    timeoutMs?: number;
    fetch?: typeof fetch;
    WebSocket?: CdpWebSocketConstructor;
}

interface CdpResponse {
    id?: number;
    error?: { message?: string };
    result?: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const POLL_MS = 250;
const SOCKET_TIMEOUT_MS = 10_000;
const UNAVAILABLE = 'The browser DevTools endpoint did not become ready. Confirm the browser started with --remote-debugging-port and retry.';
const PROTOCOL = 'The browser rejected a DevTools command. Confirm the debug port is reachable and retry.';

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseCdpHttpUrl(value: string): URL {
    let origin: URL;
    try {
        origin = new URL(value);
    } catch {
        throw new DesktopBrowserError('NEX_BROWSER_UNAVAILABLE', 'Browser sessions require an HTTP DevTools URL.');
    }
    if ((origin.protocol !== 'http:' && origin.protocol !== 'https:') || origin.username || origin.password) {
        throw new DesktopBrowserError('NEX_BROWSER_UNAVAILABLE', 'Browser sessions require an HTTP DevTools URL without embedded credentials.');
    }
    return origin;
}

function jsonBody(value: unknown): Record<string, unknown> | unknown[] | undefined {
    if (!value || typeof value !== 'object') return undefined;
    return Array.isArray(value) ? value : value as Record<string, unknown>;
}

async function readJson(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch {
        return undefined;
    }
}

async function waitForVersion(
    origin: URL,
    timeoutMs: number,
    fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    const endpoint = new URL('/json/version', origin);
    while (Date.now() < deadline) {
        try {
            const response = await fetchImpl(endpoint, { signal: AbortSignal.timeout(2_000) });
            if (response.ok) {
                const body = jsonBody(await readJson(response));
                if (body && !Array.isArray(body)) return body;
            }
        } catch {
            // Browser has not opened the debug port yet.
        }
        await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())));
    }
    throw new DesktopBrowserError('NEX_BROWSER_UNAVAILABLE', UNAVAILABLE);
}

async function listTargets(origin: URL, fetchImpl: typeof fetch): Promise<unknown[]> {
    for (const path of ['/json/list', '/json']) {
        try {
            const response = await fetchImpl(new URL(path, origin), { signal: AbortSignal.timeout(2_000) });
            if (!response.ok) continue;
            const body = jsonBody(await readJson(response));
            if (Array.isArray(body)) return body;
        } catch {
            // Try the next discovery path.
        }
    }
    return [];
}

function pageSocketUrl(targets: unknown[]): string | undefined {
    for (const target of targets) {
        if (!target || typeof target !== 'object') continue;
        const record = target as {type?: unknown; webSocketDebuggerUrl?: unknown};
        if (record.type === 'page' && typeof record.webSocketDebuggerUrl === 'string' && record.webSocketDebuggerUrl) {
            return record.webSocketDebuggerUrl;
        }
    }
    return undefined;
}

function socketData(data: unknown): string {
    if (typeof data === 'string') return data;
    if (data instanceof Uint8Array) return new TextDecoder().decode(data);
    return '';
}

function cdpCookie(cookie: BrowserCookie, instanceUrl: string): Record<string, unknown> {
    const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
    const params: Record<string, unknown> = {
        name: cookie.name,
        value: cookie.value,
        domain,
        path: cookie.path || '/',
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        url: instanceUrl,
    };
    if (Number.isFinite(cookie.expires) && cookie.expires > 0) params.expires = cookie.expires;
    return params;
}

class CdpClient {
    private nextId = 0;
    private readonly pending = new Map<number, {
        resolve: (value: Record<string, unknown>) => void;
        reject: (error: DesktopBrowserError) => void;
    }>();

    constructor(private readonly socket: CdpSocket) {
        this.socket.on('message', (data: unknown) => {
            let parsed: CdpResponse;
            try {
                parsed = JSON.parse(socketData(data)) as CdpResponse;
            } catch {
                return;
            }
            if (typeof parsed.id !== 'number') return;
            const waiter = this.pending.get(parsed.id);
            if (!waiter) return;
            this.pending.delete(parsed.id);
            if (parsed.error) waiter.reject(new DesktopBrowserError('NEX_BROWSER_PROTOCOL', PROTOCOL));
            else waiter.resolve(parsed.result ?? {});
        });
    }

    send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> {
        const id = ++this.nextId;
        const payload: Record<string, unknown> = { id, method };
        if (params) payload.params = params;
        if (sessionId) payload.sessionId = sessionId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new DesktopBrowserError('NEX_BROWSER_PROTOCOL', PROTOCOL));
            }, SOCKET_TIMEOUT_MS);
            this.pending.set(id, {
                resolve: value => { clearTimeout(timer); resolve(value); },
                reject: error => { clearTimeout(timer); reject(error); },
            });
            try {
                this.socket.send(JSON.stringify(payload));
            } catch {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new DesktopBrowserError('NEX_BROWSER_PROTOCOL', PROTOCOL));
            }
        });
    }

    close(): void {
        for (const waiter of this.pending.values()) waiter.reject(new DesktopBrowserError('NEX_BROWSER_PROTOCOL', PROTOCOL));
        this.pending.clear();
        try { this.socket.close(); } catch { /* already closed */ }
    }
}

async function openSocket(url: string, WebSocketImpl: CdpWebSocketConstructor): Promise<CdpSocket> {
    const socket = new WebSocketImpl(url);
    if (socket.readyState === 1) return socket;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            try { socket.close(); } catch { /* ignore */ }
            reject(new DesktopBrowserError('NEX_BROWSER_UNAVAILABLE', UNAVAILABLE));
        }, SOCKET_TIMEOUT_MS);
        const succeed = () => { clearTimeout(timer); resolve(socket); };
        const fail = () => {
            clearTimeout(timer);
            try { socket.close(); } catch { /* ignore */ }
            reject(new DesktopBrowserError('NEX_BROWSER_UNAVAILABLE', UNAVAILABLE));
        };
        socket.once('open', succeed);
        socket.once('error', fail);
    });
}

async function applyCookiesAndNavigate(client: CdpClient, session: BrowserSession, sessionId?: string): Promise<void> {
    await client.send('Network.enable', undefined, sessionId);
    try {
        await client.send('Storage.setCookies', {
            cookies: session.storageState.cookies.map(cookie => cdpCookie(cookie, session.instanceUrl)),
        }, sessionId);
    } catch {
        for (const cookie of session.storageState.cookies) {
            await client.send('Network.setCookie', cdpCookie(cookie, session.instanceUrl), sessionId);
        }
    }
    await client.send('Page.navigate', { url: session.instanceUrl }, sessionId);
}

async function injectThroughSocket(url: string, session: BrowserSession, WebSocketImpl: CdpWebSocketConstructor, attachTarget: boolean): Promise<void> {
    const socket = await openSocket(url, WebSocketImpl);
    const client = new CdpClient(socket);
    try {
        let sessionId: string | undefined;
        if (attachTarget) {
            const created = await client.send('Target.createTarget', { url: 'about:blank' });
            const targetId = typeof created.targetId === 'string' ? created.targetId : undefined;
            if (!targetId) throw new DesktopBrowserError('NEX_BROWSER_PROTOCOL', PROTOCOL);
            const attached = await client.send('Target.attachToTarget', { targetId, flatten: true });
            sessionId = typeof attached.sessionId === 'string' ? attached.sessionId : undefined;
            if (!sessionId) throw new DesktopBrowserError('NEX_BROWSER_PROTOCOL', PROTOCOL);
        }
        await applyCookiesAndNavigate(client, session, sessionId);
    } finally {
        client.close();
    }
}

/**
 * Apply a verified cookie session to an existing Chromium DevTools endpoint
 * and navigate to the instance. Does not close the browser.
 */
export async function injectBrowserSessionCdp(options: InjectBrowserSessionCdpOptions): Promise<void> {
    const origin = parseCdpHttpUrl(options.cdpUrl);
    if (!options.session?.instanceUrl || !Array.isArray(options.session.storageState?.cookies)) {
        throw new DesktopBrowserError('NEX_BROWSER_PROTOCOL', 'A verified browser session is required before opening the desktop UI.');
    }
    try {
        new URL(options.session.instanceUrl);
    } catch {
        throw new DesktopBrowserError('NEX_BROWSER_PROTOCOL', 'A verified browser session is required before opening the desktop UI.');
    }

    const fetchImpl = options.fetch ?? fetch;
    const WebSocketImpl = options.WebSocket ?? WsWebSocket;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const version = await waitForVersion(origin, timeoutMs, fetchImpl);
    const pageUrl = pageSocketUrl(await listTargets(origin, fetchImpl));
    const browserUrl = typeof version.webSocketDebuggerUrl === 'string' ? version.webSocketDebuggerUrl : undefined;
    const socketUrl = pageUrl ?? browserUrl;
    if (!socketUrl) throw new DesktopBrowserError('NEX_BROWSER_UNAVAILABLE', UNAVAILABLE);

    try {
        await injectThroughSocket(socketUrl, options.session, WebSocketImpl, !pageUrl);
    } catch (error: unknown) {
        if (isDesktopBrowserError(error)) throw error;
        throw new DesktopBrowserError('NEX_BROWSER_PROTOCOL', PROTOCOL);
    }
}
