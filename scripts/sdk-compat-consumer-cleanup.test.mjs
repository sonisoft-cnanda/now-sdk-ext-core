#!/usr/bin/env node
import assert from 'node:assert/strict';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const root = resolve(new URL('..', import.meta.url).pathname);
const tempRoot = await mkdtemp(join(tmpdir(), 'sdk-compat-cleanup-test-'));

function runSelfTest(mode, extraEnv = {}) {
    return spawnSync(process.execPath, ['scripts/sdk-compat-consumer.mjs', `--self-test=${mode}`], {
        cwd: root,
        env: {...process.env, TMPDIR: tempRoot, ...extraEnv},
        encoding: 'utf8',
    });
}

async function fixtureDirectories() {
    return (await readdir(tempRoot)).filter((name) => name.startsWith('sdk-compat-'));
}

try {
    const success = runSelfTest('success');
    assert.equal(success.status, 0, success.stderr);
    assert.deepEqual(await fixtureDirectories(), [], 'successful fixture was not removed');

    const failure = runSelfTest('failure');
    assert.notEqual(failure.status, 0, 'forced failure unexpectedly passed');
    assert.deepEqual(await fixtureDirectories(), [], 'failed fixture was not removed');

    const preservedFailure = runSelfTest('failure', {SDK_COMPAT_KEEP_TEMP: '1'});
    assert.notEqual(preservedFailure.status, 0, 'preserved forced failure unexpectedly passed');
    assert.equal((await fixtureDirectories()).length, 1, 'diagnostic fixture was not preserved');
} finally {
    await rm(tempRoot, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});
}

process.stderr.write('SDK compatibility consumer cleanup PASS.\n');
