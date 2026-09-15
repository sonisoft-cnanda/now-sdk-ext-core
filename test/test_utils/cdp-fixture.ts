import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {WebSocketServer} from 'ws';

export interface CdpFixture {
    close: () => Promise<void>;
    messages: Record<string, unknown>[];
    url: string;
}

/** Loopback DevTools endpoint that records CDP commands. Does not log cookie values. */
export async function listenCdp(): Promise<CdpFixture> {
    const messages: Record<string, unknown>[] = [];
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        const path = request.url?.split('?')[0];
        response.setHeader('Content-Type', 'application/json');
        const address = server.address();
        const port = address && typeof address !== 'string' ? address.port : 0;
        if (path === '/json/version') {
            response.end(JSON.stringify({webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser`}));
            return;
        }
        if (path === '/json/list' || path === '/json') {
            response.end(JSON.stringify([{
                type: 'page',
                webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page`,
            }]));
            return;
        }
        response.statusCode = 404;
        response.end('{}');
    });
    const sockets = new WebSocketServer({server});
    sockets.on('connection', socket => {
        socket.on('message', data => {
            const message = JSON.parse(String(data)) as Record<string, unknown>;
            messages.push(message);
            socket.send(JSON.stringify({id: message.id, result: {}}));
        });
    });
    await new Promise<void>(resolveListen => {
        server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('CDP fixture failed to listen');
    return {
        messages,
        url: `http://127.0.0.1:${address.port}`,
        close: async () => {
            await new Promise<void>(resolveClose => {
                sockets.close(() => resolveClose());
            });
            await new Promise<void>((resolveClose, reject) => {
                server.close(error => error ? reject(error) : resolveClose());
            });
        },
    };
}
