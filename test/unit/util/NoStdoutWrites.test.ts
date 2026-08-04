/**
 * Core must never write to stdout.
 *
 * The MCP server speaks JSON-RPC over stdout, and it imports these managers. One stray
 * `console.log` anywhere in core desynchronises the protocol framing for the whole
 * session — a failure that looks like a broken MCP client, not like a logging bug.
 *
 * A transport-level test cannot catch this: a `console.log` bypasses winston entirely,
 * so the logger can be perfectly configured while the process still writes to fd 1.
 * Hence a source scan, which is the only thing that covers code paths no unit test
 * happens to execute.
 */

import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { Console } from 'node:console';
import { Writable } from 'node:stream';

// Jest runs from the package root; there is no __dirname under the ESM runner.
const SRC = path.resolve(process.cwd(), 'src');

/** `src/cli/` holds standalone entry points that own their stdout and are not imported by MCP. */
const EXEMPT_DIRS = ['cli'];

/**
 * Console methods that could plausibly appear in source. Probed, not assumed — the
 * first version of this guard hardcoded `log|info|dir|table` and so did not catch
 * `console.debug`, which is an alias for `console.log` and writes to fd 1. A guard
 * with a hole in it is worse than no guard, because it reads like coverage.
 *
 * `clear` is excluded deliberately: it writes escape codes to stdout, but probing it
 * would wipe the test runner's terminal.
 */
const CANDIDATES = [
    'log', 'info', 'debug', 'dir', 'dirxml', 'table', 'group', 'groupCollapsed',
    'count', 'timeEnd', 'timeLog', 'trace', 'warn', 'error', 'assert',
] as const;

/**
 * Returns the candidates that actually write to stdout on this Node version.
 *
 * Probes a fresh `Console` bound to throwaway streams rather than the global one.
 * Under Jest the global `console` is Jest's own reporter shim, which funnels every
 * level into a single sink — probing it reports `warn`/`error` as stdout writers and
 * would forbid the very calls this library is supposed to make.
 */
function stdoutConsoleMethods(): string[] {
    const found: string[] = [];

    for (const name of CANDIDATES) {
        let sawStdout = false;
        const out = new Writable({
            write(_c, _e, cb) {
                sawStdout = true;
                cb();
            },
        });
        const err = new Writable({
            write(_c, _e, cb) {
                cb();
            },
        });
        const probe = new Console({ stderr: err, stdout: out }) as unknown as Record<
            string,
            unknown
        >;
        const fn = probe[name];
        if (typeof fn !== 'function') continue;

        try {
            // timeEnd/timeLog need a live label, or they are a no-op plus a warning.
            if (name === 'timeEnd' || name === 'timeLog') {
                (probe.time as (l: string) => void).call(probe, 'nex-probe');
            }
            (fn as (...a: unknown[]) => unknown).call(probe, 'nex-probe');
        } catch {
            // A method that throws on a probe cannot be a silent stdout leak.
        }
        if (sawStdout) found.push(name);
    }
    return found.sort();
}

const STDOUT_METHODS = stdoutConsoleMethods();

const FORBIDDEN = new RegExp(
    `(?<![.\\w])console\\s*\\.\\s*(?:${STDOUT_METHODS.join('|')})\\s*\\(` +
        `|process\\s*\\.\\s*stdout\\s*\\.\\s*write\\s*\\(`,
);

function sourceFiles(dir: string, relative = ''): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const rel = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            return EXEMPT_DIRS.includes(rel) ? [] : sourceFiles(path.join(dir, entry.name), rel);
        }
        return entry.name.endsWith('.ts') ? [rel] : [];
    });
}

/** Strips line comments, block comments, and string literals before scanning. */
function stripNonCode(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/`(?:\\[\s\S]|[^\\`])*`/g, '``')
        .replace(/'(?:\\.|[^\\'])*'/g, "''")
        .replace(/"(?:\\.|[^\\"])*"/g, '""');
}

describe('core never writes to stdout', () => {
    const offenders = sourceFiles(SRC)
        .map((rel) => ({
            rel,
            code: stripNonCode(fs.readFileSync(path.join(SRC, rel), 'utf8')),
        }))
        .flatMap(({ rel, code }) =>
            code
                .split('\n')
                .map((line, i) => ({ rel, line: line.trim(), number: i + 1 }))
                .filter(({ line }) => FORBIDDEN.test(line)),
        );

    it('has no console.log or process.stdout.write outside the standalone CLI entry points', () => {
        expect(
            offenders.map((o) => `${o.rel}: ${o.line}`),
            // ServiceNowProcessorRequest logged a caught error with console.log, and
            // XMLHttpRequest's debug() did console.log.apply — both inside the MCP
            // process, both on fd 1.
        ).toEqual([]);
    });

    it('scans a meaningful number of files, so a broken walk cannot pass vacuously', () => {
        expect(sourceFiles(SRC).length).toBeGreaterThan(50);
    });

    it('detects the stdout-writing console methods rather than trusting a hardcoded list', () => {
        // If the probe silently found nothing, FORBIDDEN would match almost nothing and
        // the scan above would pass while covering exactly zero methods.
        expect(STDOUT_METHODS).toEqual(
            expect.arrayContaining(['debug', 'dir', 'info', 'log', 'table']),
        );
        // console.warn/error/trace go to stderr and must NOT be forbidden — they are how
        // this library is supposed to talk.
        expect(STDOUT_METHODS).not.toContain('warn');
        expect(STDOUT_METHODS).not.toContain('error');
        expect(STDOUT_METHODS).not.toContain('trace');
    });

    it.each(['log', 'debug', 'info', 'table'])('would catch a console.%s regression', (method) => {
        expect(FORBIDDEN.test(`  console.${method}('leak')`)).toBe(true);
    });

    it('does not flag stderr calls or a property merely named log', () => {
        expect(FORBIDDEN.test('logger.log("fine")')).toBe(false);
        expect(FORBIDDEN.test('console.error("fine")')).toBe(false);
        expect(FORBIDDEN.test('this.console.log')).toBe(false);
    });
});
