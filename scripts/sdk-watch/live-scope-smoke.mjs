#!/usr/bin/env node
// Live, read-only check of Scripts - Background scope handling after an SDK/dependency bump.
//
// Usage: SN_INSTANCE_ALIAS=<non-prod alias> node scripts/sdk-watch/live-scope-smoke.mjs
//   optional: QA_APP_SCOPE=<a sys_app scope>        expect the script to run in that scope
//             QA_STORE_APP_SCOPE=<a sys_store_app>   expect NOT_A_DEVELOPED_APP, nothing sent
//             NEX_LIVE_CREDENTIAL_MODE=native|opt-in (default opt-in: credentials via sn-credstore)
// Needs `npm run build`. Runs only gs.info() scripts; never writes instance data.
// Use a development instance or PDI, never production.
import assert from 'node:assert/strict';
import { format } from 'node:util';

// The SDK's logger writes through console.log (stdout) by default, e.g. "[now-sdk] Access
// Token has expired, refreshing token". Keep stdout for the JSON result only.
console.log = (...args) => process.stderr.write(`${format(...args)}\n`);

const alias = process.env.SN_INSTANCE_ALIAS?.trim();
if (!alias) {
    process.stderr.write('Set SN_INSTANCE_ALIAS to a configured, non-production alias.\n');
    process.exit(2);
}
const mode = process.env.NEX_LIVE_CREDENTIAL_MODE || 'opt-in';
const core = await import('../../dist/index.js');
if (mode === 'opt-in') {
    const shim = await core.initCredentialStore();
    assert.equal(shim.active, true, `credential store not active (${shim.reason ?? 'unknown'})`);
}
const { getCredentials } = await import('@servicenow/sdk-cli/dist/auth/index.js');
const instance = new core.ServiceNowInstance({ alias, credential: await getCredentials(alias) });
const marker = `SDK_QA_${Date.now()}`;
const script = `gs.info('${marker}=' + gs.getCurrentScopeName());`;

const checks = [];
async function check(name, run) {
    try {
        checks.push({ name, pass: true, detail: await run() });
    } catch (err) {
        checks.push({ name, pass: false, detail: err.message });
    }
    process.stderr.write(`${checks.at(-1).pass ? 'PASS' : 'FAIL'} ${name}: ${checks.at(-1).detail}\n`);
}
const sent = new Map();
const runIn = async (scope) => {
    const executor = new core.BackgroundScriptExecutor(instance, scope);
    const result = await executor.executeScript(script, scope, instance);
    // The sys_id actually posted. Output alone cannot tell Global from a global-scoped app:
    // both report "scope global" and rhino.global.
    sent.set(scope, executor._scopeCache?.get(scope));
    return (result.scriptResults ?? []).map((l) => l.line).find((l) => l?.includes(marker)) ?? '';
};
const refusal = async (scope) => {
    try {
        await new core.BackgroundScriptExecutor(instance, scope).executeScript(script, scope, instance);
    } catch (err) {
        assert.ok(core.isScriptScopeError(err), `expected ScriptScopeError, got: ${err.message}`);
        return err;
    }
    throw new Error(`scope '${scope}' was not refused`);
};

await check('global runs in the Global scope (sys_id global)', async () => {
    const line = await runIn('global');
    assert.equal(sent.get('global'), 'global', `posted sys_scope=${sent.get('global')}, not the Global record`);
    assert.match(line, new RegExp(`${marker}=rhino\\.global`), `output: ${line || '(none)'}`);
    return `sys_scope=global; ${line}`;
});
await check('unknown scope refused before sending', async () => {
    const err = await refusal('x_sdk_qa_no_such_scope');
    assert.equal(err.reason, 'SCOPE_NOT_FOUND');
    return err.reason;
});
if (process.env.QA_STORE_APP_SCOPE) {
    await check(`store app ${process.env.QA_STORE_APP_SCOPE} refused`, async () => {
        const err = await refusal(process.env.QA_STORE_APP_SCOPE);
        assert.equal(err.reason, 'NOT_A_DEVELOPED_APP');
        return `${err.reason} (${err.foundAs?.name})`;
    });
}
if (process.env.QA_APP_SCOPE) {
    await check(`sys_app ${process.env.QA_APP_SCOPE} runs in its scope`, async () => {
        const line = await runIn(process.env.QA_APP_SCOPE);
        assert.match(line, new RegExp(`${marker}=${process.env.QA_APP_SCOPE}`), `output: ${line || '(none)'}`);
        return line;
    });
}

const pass = checks.every((c) => c.pass);
process.stdout.write(`${JSON.stringify({ alias, mode, pass, checks }, null, 2)}\n`);
process.exit(pass ? 0 : 1);
