#!/usr/bin/env node
// Would initCredentialStore() work for a user whose global `now-sdk` is <version>?
//
// Usage: node scripts/sdk-watch/global-sdk-check.mjs <sdk-version> [...]   (needs `npm run build`)
//
// sn-credstore patches every @servicenow/sdk-cli copy it can find, including the global
// one, and fails closed on a release it has not reviewed — so a global `now-sdk` upgrade
// alone can break every consumer of this library. sn-credstore also searches NODE_PATH,
// which lets this script stand an exact SDK release up as the "global" copy in a temp
// prefix, without touching the machine's real global install or credential store.
//
// Exit 0 when initCredentialStore() is active next to every version given.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const versions = process.argv.slice(2);
if (!versions.length) {
    process.stderr.write('usage: global-sdk-check.mjs <sdk-version> [...]\n');
    process.exit(2);
}

const results = [];
for (const version of versions) {
    const prefix = mkdtempSync(join(tmpdir(), `global-sdk-${version}-`));
    try {
        execFileSync('npm', ['install', '--silent', '--no-audit', '--no-fund', '--prefix', prefix, `@servicenow/sdk@${version}`],
            { stdio: ['ignore', 'ignore', 'pipe'] });
        const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
            const core = await import(${JSON.stringify(join(root, 'dist/index.js'))});
            process.stdout.write(JSON.stringify(await core.initCredentialStore()));
        `], {
            encoding: 'utf8',
            env: {
                ...process.env,
                NODE_PATH: join(prefix, 'node_modules'),
                SN_CRED_STORE: 'file',
                SN_CRED_STORE_PATH: join(prefix, 'credentials.json'),
                SN_CRED_STORE_DISABLE: '',
            },
        });
        let outcome;
        try {
            outcome = JSON.parse(probe.stdout.trim().split('\n').at(-1));
        } catch {
            // initCredentialStore() throws (rather than reporting inactive) when the shim
            // refuses an SDK copy; surface that message, not the stack.
            const text = `${probe.stderr}\n${probe.stdout}`;
            const lines = text.split('\n');
            const message = (lines.find((l) => /^\w*Error: /.test(l)) ?? lines.find((l) => /has not been verified/.test(l)))?.trim();
            outcome = { active: false, reason: 'threw', detail: message ?? text.trim().split('\n').slice(0, 3).join(' ') };
        }
        results.push({ version, ...outcome });
        process.stderr.write(`global now-sdk ${version}: ${JSON.stringify(outcome)}\n`);
    } finally {
        rmSync(prefix, { recursive: true, force: true });
    }
}
const pass = results.every((r) => r.active === true);
process.stdout.write(`${JSON.stringify({ pass, results }, null, 2)}\n`);
process.exit(pass ? 0 : 1);
