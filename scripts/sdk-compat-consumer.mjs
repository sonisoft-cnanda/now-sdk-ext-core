#!/usr/bin/env node
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const root = resolve(new URL('..', import.meta.url).pathname);
const output = mkdtemp(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'sdk-compat-'));

function run(command, args, cwd, env = {}) {
    const result = spawnSync(command, args, {
        cwd,
        env: {...process.env, ...env},
        encoding: 'utf8',
        timeout: 180_000,
    });
    assert.equal(result.status, 0, `${command} failed (${result.status}): ${result.stderr}`);
    return result;
}

async function fixture(name) {
    const dir = join(await output, name);
    await import('node:fs/promises').then(({mkdir}) => mkdir(dir, {recursive: true}));
    await writeFile(join(dir, 'package.json'), JSON.stringify({private: true, type: 'module'}));
    return dir;
}

run('npm', ['run', 'build'], root);
const pack = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', await output], root).stdout);
assert.equal(pack.length, 1);
const tarball = join(await output, pack[0].filename);

const bare = await fixture('bare');
run('npm', ['install', '--ignore-scripts', tarball], bare);
// Model a consumer/bundler that pruned only core's optional shim. npm's broad
// --omit=optional also removes the SDK keyring's platform binary and does not
// represent a valid native-SDK installation.
await rm(join(bare, 'node_modules/@sonisoft/sn-credstore'), {recursive: true, force: true});
await writeFile(join(bare, 'check.mjs'), `
import assert from 'node:assert/strict';
const before = process.env.SN_CREDSTORE_PATCHED;
const core = await import('@sonisoft/now-sdk-ext-core');
assert.equal(process.env.SN_CREDSTORE_PATCHED, before);
assert.equal((await core.initCredentialStore()).reason, 'not-installed');
assert.equal(typeof core.ServiceNowRequest, 'function');
`);
run('node', ['check.mjs'], bare);

const optIn = await fixture('opt-in');
run('npm', ['install', '--ignore-scripts', tarball, '@sonisoft/sn-credstore@1.2.0'], optIn);
const storePath = join(optIn, 'state', 'credentials.json');
await writeFile(join(optIn, 'check.mjs'), `
import assert from 'node:assert/strict';
import {loadConfig} from '@sonisoft/sn-credstore';
import {initCredentialStore} from '@sonisoft/now-sdk-ext-core';
assert.equal(loadConfig().blobPath, process.env.SN_CRED_STORE_PATH);
assert.deepEqual(await initCredentialStore(), {active: true});
`);
run('node', ['check.mjs'], optIn, {
    SN_CRED_STORE: 'file',
    SN_CRED_STORE_ALLOW_PLAINTEXT: '1',
    SN_CRED_STORE_PATH: storePath,
});

const downstream = await fixture('cli');
run('npm', ['install', '--ignore-scripts', '@sonisoft/now-sdk-ext-cli@5.6.0', tarball], downstream);
const installedCore = JSON.parse(await readFile(join(downstream, 'node_modules/@sonisoft/now-sdk-ext-core/package.json')));
assert.equal(installedCore.dependencies['@servicenow/sdk'], '4.12.0');
run('node', ['node_modules/@sonisoft/now-sdk-ext-cli/bin/run.js', '--help'], downstream, {
    SN_CRED_STORE_DISABLE: '1',
});

process.stderr.write('SDK compatibility consumer PASS: bare import, opt-in backend, and nex CLI entrypoint.\n');
