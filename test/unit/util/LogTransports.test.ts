/**
 * Transport behaviour (NEX-3).
 *
 * Each case here corresponds to a way winston fails SILENTLY, verified against the
 * winston 3.14.2 source in node_modules. A unit test on the config object catches none
 * of them, because every one is a property of what winston does with that config.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as winston from 'winston';
import { Logger } from '../../../src/util/Logger';
import {
    configureLogging,
    getRootLogger,
    flushLogs,
    resetLoggingForTests,
} from '../../../src/util/LogConfig';

const LOG_ENV = ['NEX_LOG_FILE', 'NEX_LOG_LEVEL', 'NEX_LOG_DIR', 'XDG_STATE_HOME'];

/**
 * Reads the log directory until `needle` shows up.
 *
 * `flushLogs` is deliberately bounded — it is called on the way to process exit, where
 * hanging is worse than losing a line — so under parallel test load it can return before
 * the last write lands. Poll rather than lengthen a timeout and call it fixed.
 */
async function readLogsContaining(dir: string, needle: string, timeoutMs = 5000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let contents = '';
    while (Date.now() < deadline) {
        if (fs.existsSync(dir)) {
            contents = fs
                .readdirSync(dir)
                .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
                .join('');
            if (contents.includes(needle)) {
                return contents;
            }
        }
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`Timed out waiting for "${needle}" in ${dir}; saw: ${contents.slice(0, 400)}`);
}

let tmpRoot: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
    saved = Object.fromEntries(LOG_ENV.map((k) => [k, process.env[k]]));
    for (const k of LOG_ENV) delete process.env[k];
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nex-log-'));
    process.env.XDG_STATE_HOME = tmpRoot;
    resetLoggingForTests();
});

afterEach(async () => {
    await flushLogs();
    resetLoggingForTests();
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('log destination', () => {
    it('creates no directory when file logging is off — not even on first write', () => {
        const loggers = Array.from({ length: 5 }, (_, i) => new Logger(`Probe${i}`));
        // Constructing alone would not prove it: winston's File transport mkdirs in ITS
        // constructor (file.js:94), so the first write is where a lazy build could slip.
        loggers.forEach((l) => l.warn('probe'));

        // This is the whole bug — a library creating directories where it was merely
        // imported. Assert on the filesystem, not on a spy.
        expect(fs.existsSync(path.join(tmpRoot, 'now-sdk-ext'))).toBe(false);
        expect(fs.existsSync(path.join(process.cwd(), 'logs'))).toBe(false);
    });

    it('writes under the configured dir, and never into cwd', async () => {
        configureLogging({ file: true, level: 'debug' });
        new Logger('Probe').info('hello');
        await flushLogs();

        const dir = path.join(tmpRoot, 'now-sdk-ext', 'logs');
        await expect(readLogsContaining(dir, 'hello')).resolves.toContain('hello');
        expect(fs.existsSync(path.join(process.cwd(), 'logs'))).toBe(false);
    });
});

describe('console transport', () => {
    it('never writes to stdout, at any level', () => {
        configureLogging({ level: 'silly', consoleLevel: 'silly' });
        const out = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
        const err = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
            const logger = new Logger('StreamProbe');
            // Iterate the level set rather than a hand-written list: transports.Console
            // routes by a stderrLevels MAP and falls through to stdout for anything
            // absent from it (console.js:56 vs :85), so a level added later would
            // silently start corrupting MCP's JSON-RPC framing on fd 1.
            for (const level of Object.keys(winston.config.npm.levels)) {
                (logger as unknown as Record<string, (m: string) => void>)[level]?.(
                    `probe-${level}`,
                );
            }
            expect(out).not.toHaveBeenCalled();
            expect(err).toHaveBeenCalled();
        } finally {
            out.mockRestore();
            err.mockRestore();
        }
    });

    it('renders the message, not the literal string "undefined"', () => {
        configureLogging({ consoleLevel: 'debug', level: 'debug' });
        const err = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
            new Logger('RenderProbe').error('a distinctive message', { field: 'kept' });
            const written = err.mock.calls.map((c) => String(c[0])).join('');
            // The logger-level chain ends at metadata(), which never sets the MESSAGE
            // symbol; without a finalizing format on the transport every line is
            // literally "undefined".
            expect(written).toContain('a distinctive message');
            expect(written).toContain('RenderProbe');
            expect(written.trim()).not.toBe('undefined');
        } finally {
            err.mockRestore();
        }
    });
});

describe('the no-transport trap', () => {
    it('never lets winston print a raw, unredacted record to stderr', () => {
        // winston/lib/winston/logger.js:300 console.error's the RAW info object when a
        // logger has no transports — at line 300, BEFORE format.transform() at line 312.
        // So redaction never runs. "Off" must mean a silent transport, never [].
        configureLogging({ file: false, console: false });
        const err = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
        const consoleErr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            new Logger('QuietProbe').error('boom', {
                auth: { cookie: 'SENTINEL-COOKIE-VALUE' },
            });
            const written = [
                ...err.mock.calls.map((c) => String(c[0])),
                ...consoleErr.mock.calls.map((c) => c.map(String).join(' ')),
            ].join('');
            expect(written).not.toContain('SENTINEL-COOKIE-VALUE');
            expect(written).not.toContain('no transports');
        } finally {
            err.mockRestore();
            consoleErr.mockRestore();
        }
    });

    it('keeps at least one transport attached in every configuration', () => {
        configureLogging({ file: false, console: false });
        expect(getRootLogger().transports.length).toBeGreaterThan(0);
    });
});

describe('shared root logger', () => {
    it('opens one file transport no matter how many Loggers exist', async () => {
        configureLogging({ file: true, level: 'debug' });
        const loggers = Array.from({ length: 50 }, (_, i) => new Logger(`Manager${i}`));
        loggers.forEach((l) => l.info('work'));
        await flushLogs();

        // The 120 MB of logs came from ServiceNowRequest being constructed per HTTP
        // call: each built a RequestHandler whose field initializer opened four more
        // append streams that were never closed.
        const fileTransports = getRootLogger().transports.filter(
            (t) => t instanceof winston.transports.File,
        );
        expect(fileTransports).toHaveLength(1);
    });

    it('picks up a reconfiguration without rebuilding every Logger', async () => {
        const logger = new Logger('Rebuilt');
        logger.info('before');
        configureLogging({ file: true, level: 'debug' });
        logger.debug('after-reconfigure');
        await flushLogs();

        const dir = path.join(tmpRoot, 'now-sdk-ext', 'logs');
        await expect(readLogsContaining(dir, 'after-reconfigure')).resolves.toContain(
            'after-reconfigure',
        );
    });

    it('keeps its own label even when metadata carries one', async () => {
        configureLogging({ file: true, level: 'debug' });
        // Latent today, but metadata objects here are built ad hoc and grow. A caller
        // key named `label` silently misattributed the record to another component.
        new Logger('RealOwner').info('labelled message', { label: 'IMPOSTER', keep: 1 });
        await flushLogs();

        const dir = path.join(tmpRoot, 'now-sdk-ext', 'logs');
        const raw = await readLogsContaining(dir, 'labelled message');
        const line = raw
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { label?: string; metadata?: Record<string, unknown> })
            .find((l) => (l.metadata as Record<string, unknown> | undefined)?.keep === 1);

        expect(line?.label).toBe('RealOwner');
    });

    it('still labels each record with its own logger name', async () => {
        configureLogging({ file: true, level: 'debug' });
        new Logger('AlphaManager').info('alpha message');
        new Logger('BetaManager').info('beta message');
        await flushLogs();

        const dir = path.join(tmpRoot, 'now-sdk-ext', 'logs');
        const raw = await readLogsContaining(dir, 'beta message');
        const lines = raw
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { label?: string; message?: string });

        expect(lines.find((l) => l.message === 'alpha message')?.label).toBe('AlphaManager');
        expect(lines.find((l) => l.message === 'beta message')?.label).toBe('BetaManager');
    });
});

describe('reuse after flushLogs', () => {
    it('does not write to an ended stream — a Logger kept across a flush must rebuild', async () => {
        configureLogging({ file: true, level: 'debug' });
        const logger = new Logger('Reused');
        logger.info('before flush');

        // flushLogs ends the shared root. configureLogging and resetLoggingForTests
        // both bump the epoch when they drop it; flushLogs did not, so any Logger that
        // had already cached the root kept writing to the ended stream. That throws
        // "write after end" — a crash, not a lost line — and flushLogs is public API
        // meant to be called mid-process, not only on the way out.
        await flushLogs();

        expect(() => logger.info('after flush')).not.toThrow();

        await flushLogs();
        const dir = path.join(tmpRoot, 'now-sdk-ext', 'logs');
        await expect(readLogsContaining(dir, 'after flush')).resolves.toContain('after flush');
    });

    it('keeps every live Logger usable, not just newly constructed ones', async () => {
        configureLogging({ file: true, level: 'debug' });
        const first = new Logger('First');
        const second = new Logger('Second');
        first.info('warmup');
        second.info('warmup');

        await flushLogs();

        expect(() => first.warn('first still works')).not.toThrow();
        expect(() => second.warn('second still works')).not.toThrow();
    });
});

describe('rotation', () => {
    it('caps file growth instead of growing without bound', async () => {
        configureLogging({ file: true, level: 'debug', maxSizeBytes: 2048, maxFiles: 3 });
        const logger = new Logger('Chatty');
        for (let i = 0; i < 400; i++) {
            logger.info(`line ${i} ${'x'.repeat(120)}`);
        }
        await flushLogs();

        const dir = path.join(tmpRoot, 'now-sdk-ext', 'logs');
        const files = fs.readdirSync(dir);
        expect(files.length).toBeGreaterThan(1);
        for (const f of files) {
            // Winston checks size before writing, so a file can exceed maxsize by at
            // most one record. Allow generous headroom; the point is bounded, not exact.
            expect(fs.statSync(path.join(dir, f)).size).toBeLessThan(2048 * 20);
        }
    });
});

describe('degrades rather than throwing', () => {
    it('survives an unwritable log directory', () => {
        // A directory path that descends through a regular file. mkdir fails with
        // ENOTDIR immediately, on every platform.
        const blocker = path.join(tmpRoot, 'not-a-directory');
        fs.writeFileSync(blocker, 'x');
        const unwritable = path.join(blocker, 'logs');

        const err = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
        try {
            // mkdirSync happens in the File transport constructor and precedes its own
            // `lazy` handling, so with a lazily-built root this throw would otherwise
            // surface from an ordinary .info() deep inside business logic.
            configureLogging({ file: true, dir: unwritable });
            expect(() => new Logger('Unwritable').info('still fine')).not.toThrow();
        } finally {
            err.mockRestore();
        }

        // and it degrades to console rather than losing the record entirely
        expect(getRootLogger().transports.length).toBeGreaterThan(0);
    });
});
