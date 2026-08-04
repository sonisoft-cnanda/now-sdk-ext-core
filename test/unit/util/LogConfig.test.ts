/**
 * Configuration surface for logging (NEX-3).
 *
 * The bug this closes: four Winston File transports at hard-coded RELATIVE paths, with
 * no console transport and no injectable destination. A published library therefore
 * created ./logs/ in whatever directory the process happened to start in — including an
 * MCP server whose cwd is chosen by its client — and there was no way to turn it off.
 *
 * Precedence is explicit args > env > defaults, and the default is OFF.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import {
    configureLogging,
    getLogConfig,
    resetLoggingForTests,
    defaultLogDir,
} from '../../../src/util/LogConfig';

const LOG_ENV = ['NEX_LOG_FILE', 'NEX_LOG_LEVEL', 'NEX_LOG_DIR', 'XDG_STATE_HOME'];

describe('LogConfig', () => {
    let saved: Record<string, string | undefined>;

    beforeEach(() => {
        saved = Object.fromEntries(LOG_ENV.map((k) => [k, process.env[k]]));
        for (const k of LOG_ENV) delete process.env[k];
        resetLoggingForTests();
    });

    afterEach(() => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        resetLoggingForTests();
    });

    describe('defaults', () => {
        it('does not log to a file', () => {
            expect(getLogConfig().file).toBe(false);
        });

        it('logs to the console at warn, so failures stay visible', () => {
            const cfg = getLogConfig();
            expect(cfg.console).toBe(true);
            expect(cfg.consoleLevel).toBe('warn');
        });
    });

    describe('environment', () => {
        it('NEX_LOG_FILE enables file logging', () => {
            process.env.NEX_LOG_FILE = '1';
            expect(getLogConfig().file).toBe(true);
        });

        it.each(['0', 'false', 'FALSE', ''])('treats NEX_LOG_FILE=%p as off', (value) => {
            process.env.NEX_LOG_FILE = value;
            expect(getLogConfig().file).toBe(false);
        });

        it('NEX_LOG_DIR implies enable — otherwise setting only a dir silently does nothing', () => {
            process.env.NEX_LOG_DIR = '/tmp/somewhere';
            const cfg = getLogConfig();
            expect(cfg.file).toBe(true);
            expect(cfg.dir).toBe('/tmp/somewhere');
        });

        it('an explicit NEX_LOG_FILE=0 beats NEX_LOG_DIR', () => {
            process.env.NEX_LOG_DIR = '/tmp/somewhere';
            process.env.NEX_LOG_FILE = '0';
            expect(getLogConfig().file).toBe(false);
        });

        it('NEX_LOG_LEVEL sets the level', () => {
            process.env.NEX_LOG_LEVEL = 'debug';
            expect(getLogConfig().level).toBe('debug');
        });

        it('maps trace to silly — trace is not a winston level and silently dropped records', () => {
            process.env.NEX_LOG_LEVEL = 'trace';
            expect(getLogConfig().level).toBe('silly');
        });

        it('falls back on an unknown level rather than bricking the CLI', () => {
            process.env.NEX_LOG_LEVEL = 'chatty';
            expect(getLogConfig().level).toBe('info');
        });
    });

    describe('precedence', () => {
        it('explicit args beat the environment', () => {
            process.env.NEX_LOG_LEVEL = 'debug';
            process.env.NEX_LOG_FILE = '1';
            configureLogging({ level: 'error', file: false });
            const cfg = getLogConfig();
            expect(cfg.level).toBe('error');
            expect(cfg.file).toBe(false);
        });

        it('an unset arg leaves the env value in place', () => {
            process.env.NEX_LOG_LEVEL = 'debug';
            configureLogging({ file: true });
            expect(getLogConfig().level).toBe('debug');
        });

        it('is idempotent across repeated calls', () => {
            configureLogging({ level: 'error' });
            configureLogging({ file: true });
            const cfg = getLogConfig();
            expect(cfg.level).toBe('error');
            expect(cfg.file).toBe(true);
        });
    });

    it('returns a frozen copy — a mutated config would desync from the built logger', () => {
        const cfg = getLogConfig();
        expect(Object.isFrozen(cfg)).toBe(true);
        expect(() => {
            (cfg as { level: string }).level = 'debug';
        }).toThrow();
        expect(getLogConfig().level).toBe('info');
    });

    describe('defaultLogDir', () => {
        const realPlatform = process.platform;
        const setPlatform = (value: string) =>
            Object.defineProperty(process, 'platform', { value, configurable: true });

        afterEach(() => setPlatform(realPlatform));

        it('honours XDG_STATE_HOME on every platform, which is what makes tests hermetic', () => {
            process.env.XDG_STATE_HOME = '/xdg/state';
            for (const platform of ['linux', 'darwin', 'win32']) {
                setPlatform(platform);
                expect(defaultLogDir()).toBe(path.join('/xdg/state', 'now-sdk-ext', 'logs'));
            }
        });

        it('uses ~/.local/state on linux', () => {
            setPlatform('linux');
            expect(defaultLogDir()).toBe(
                path.join(os.homedir(), '.local', 'state', 'now-sdk-ext', 'logs'),
            );
        });

        it('uses LOCALAPPDATA on win32', () => {
            setPlatform('win32');
            process.env.LOCALAPPDATA = 'C:\\Users\\x\\AppData\\Local';
            expect(defaultLogDir()).toBe(
                path.join('C:\\Users\\x\\AppData\\Local', 'now-sdk-ext', 'Logs'),
            );
            delete process.env.LOCALAPPDATA;
        });

        it('never returns a path under / when there is no usable home', () => {
            // A daemon with no HOME gets "/" from homedir(), and join("/", ".local", …)
            // is an EACCES on the first write.
            setPlatform('linux');
            const realHome = process.env.HOME;
            process.env.HOME = '/';
            try {
                expect(defaultLogDir().startsWith(os.tmpdir())).toBe(true);
            } finally {
                if (realHome === undefined) delete process.env.HOME;
                else process.env.HOME = realHome;
            }
        });
    });
});
