#!/usr/bin/env node
/**
 * Post-processes the ctix-generated src/index.ts.
 *
 * ctix decides what to export purely from file layout, and its rule is:
 * a source file is skipped if — and only if — its own directory's index.ts
 * re-exports it. That makes curation binary per directory: either every module
 * in a folder is exported, or none of it is. There is no way to say "export
 * these three names from src/sn/amb and keep the rest private", and the
 * `excludeFiles` option is non-functional in ctix 2.8.2 (verified against the
 * config key, the CLI flag, and every glob form).
 *
 * That gap caused two real defects:
 *
 *  - src/sn/amb/index.ts re-exports the whole folder, so ctix omitted it — and
 *    AMBClient never reached the barrel. ScriptTracer was exported but its
 *    constructor requires an AMBClient, so it could not be built by any
 *    consumer, and the documented README import did not compile.
 *  - comm/http has no directory index, so ctix exported every file in it,
 *    including SessionManager — which was deliberately removed from the public
 *    surface in f5379e4 and is absent from published 3.9.0.
 *
 * Rather than hand-maintaining a 90-line barrel, generation is kept and this
 * script applies the two rules ctix cannot express. Both lists are asserted
 * against, so a rename fails the build loudly instead of silently changing the
 * public API.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const barrelPath = resolve(root, 'src/index.ts');

/** Modules ctix exports that must NOT be public. */
const DROP = ['./comm/http/SessionManager.js', './policy/internal/Classify.js'];

/** Curated exports ctix cannot express, declared in src/PublicApi.ts. */
const APPEND = './PublicApi.js';

if (!existsSync(barrelPath)) {
    console.error(`finalize-barrel: ${barrelPath} not found — did ctix run?`);
    process.exit(1);
}

const original = readFileSync(barrelPath, 'utf8');
const lines = original.split('\n');

const dropped = [];
const kept = lines.filter((line) => {
    const hit = DROP.find((m) => line.includes(`from '${m}'`));
    if (hit) {
        dropped.push(hit);
        return false;
    }
    return true;
});

// Fail loudly on rename/move rather than silently publishing an internal module.
for (const m of DROP) {
    if (!dropped.includes(m)) {
        console.error(
            `finalize-barrel: expected to remove "${m}" from the barrel, but ctix did not emit it.\n` +
                `  Either the module moved (update DROP in scripts/finalize-barrel.mjs), or a\n` +
                `  directory index now covers it. Not failing open — the public API must be deliberate.`,
        );
        process.exit(1);
    }
}

if (!existsSync(resolve(root, 'src/PublicApi.ts'))) {
    console.error('finalize-barrel: src/PublicApi.ts is missing — the curated exports would be lost.');
    process.exit(1);
}

const header = [
    '',
    '// --- appended by scripts/finalize-barrel.mjs (see that file for why) ---',
    '// Curated exports ctix cannot express: it omits src/sn/amb entirely because',
    '// that folder has its own index.ts covering every module in it.',
    `export * from '${APPEND}';`,
    '',
].join('\n');

writeFileSync(barrelPath, `${kept.join('\n').replace(/\n+$/, '\n')}${header}`);

console.log(
    `finalize-barrel: removed ${dropped.length} internal export(s) [${dropped.join(', ')}], ` +
        `appended ${APPEND}`,
);
