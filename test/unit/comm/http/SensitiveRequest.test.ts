import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Logger } from '../../../../src/util/Logger';
import { configureLogging, flushLogs, resetLoggingForTests, getLogConfig } from '../../../../src/util/LogConfig';
import { RequestHandler } from '../../../../src/comm/http/RequestHandler';

const sentinel = 'private-field-sentinel';
function setup(status: number) {
    const auth = { ensureSession: jest.fn(async () => undefined) };
    const handler = new RequestHandler(auth as any);
    handler.setSession({ instanceUrl: new URL('https://example.service-now.com'), userToken: sentinel });
    const logs: unknown[] = [];
    (handler as any)._logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(k => [k, (...a: unknown[]) => logs.push(a)]));
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(sentinel, {
        status, headers: { Location: '/sys_script_include.do?sys_id=' + sentinel },
    }));
    return { handler, fetch, logs, auth };
}
const request = { path: '/sys_script_include.do', query: { secret: sentinel }, headers: null, body: null,
    fields: { 'sys_script_include.script': sentinel }, sensitive: true, redirect: 'manual' as const, responseFormat: 'text' as const };
afterEach(() => jest.restoreAllMocks());
describe('manual sensitive requests', () => {
    it('returns manual 302 with headers and body without logging payloads', async () => {
        const { handler, fetch, logs } = setup(302);
        const result = await handler.post({ ...request });
        expect(result.status).toBe(302);
        expect(result.data).toBe(sentinel);
        expect(result.headers['location']).toContain('sys_id=');
        expect(fetch.mock.calls[0][1]?.redirect).toBe('manual');
        expect(JSON.stringify(logs)).not.toContain(sentinel);
    });
    it('does not replay a manual POST 401', async () => {
        const { handler, fetch, logs, auth } = setup(401);
        await expect(handler.post({ ...request })).rejects.toMatchObject({ code: 'NEX_SESSION_EXPIRED' });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(auth.ensureSession).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(logs)).not.toContain(sentinel);
    });
    it('does not expose HTTP failure bodies in logs or errors', async () => {
        const { handler, logs } = setup(500);
        await expect(handler.post({ ...request })).rejects.not.toThrow(sentinel);
        expect(JSON.stringify(logs)).not.toContain(sentinel);
    });
    it('keeps sensitive payloads out of the real log file', async () => {
        const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), 'metadata-log-'));
        try {
            configureLogging({file:true,console:false,dir,level:'debug'});
            const {handler} = setup(500);
            (handler as any)._logger = new Logger('SensitiveFileCheck');
            await expect(handler.post({...request})).rejects.toThrow();
            await flushLogs();
            const contents = readFileSync(join(getLogConfig().dir,'nex.log'),'utf8');
            expect(contents).toContain('SensitiveFileCheck');
            expect(contents).not.toContain(sentinel);
            expect(contents).not.toContain('sys_script_include.script');
        } finally { await flushLogs(); resetLoggingForTests(); rmSync(dir,{recursive:true,force:true}); }
    });
    it('omits arbitrary SDK errors, while preserving read renewal', async () => {
        const {handler,fetch,logs} = setup(200);
        fetch.mockRejectedValueOnce(new Error(sentinel));
        await expect(handler.get({...request})).rejects.not.toThrow(sentinel);
        expect(JSON.stringify(logs)).not.toContain(sentinel);
    });

});
