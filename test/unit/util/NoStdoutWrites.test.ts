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

// Jest runs from the package root; there is no __dirname under the ESM runner.
const SRC = path.resolve(process.cwd(), 'src');

/** `src/cli/` holds standalone entry points that own their stdout and are not imported by MCP. */
const EXEMPT_DIRS = ['cli'];

const FORBIDDEN = /(?<![.\w])console\s*\.\s*(log|info|dir|table)\s*\(|process\s*\.\s*stdout\s*\.\s*write\s*\(/;

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
});
