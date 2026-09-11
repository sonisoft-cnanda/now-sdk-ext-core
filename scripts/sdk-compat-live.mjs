#!/usr/bin/env node
import assert from 'node:assert/strict';

const alias = process.env.SN_INSTANCE_ALIAS?.trim();
if (!alias) throw new Error('Set SN_INSTANCE_ALIAS to a non-secret configured alias.');
const mode = process.env.NEX_LIVE_CREDENTIAL_MODE || 'opt-in';
assert.match(mode, /^(native|opt-in)$/);

const core = await import('../dist/index.js');
if (mode === 'opt-in') {
    const result = await core.initCredentialStore();
    assert.equal(result.active, true, `Credential backend is not active (${result.reason || 'unknown'}).`);
}
const {getCredentials} = await import('@servicenow/sdk-cli/dist/auth/index.js');
const credential = await getCredentials(alias);
assert.ok(credential, 'The approved SDK credential interface returned no credential.');

const instance = new core.ServiceNowInstance({alias, credential});
const request = new core.ServiceNowRequest(instance);
const response = await request.get({
    method: 'GET',
    path: '/api/now/table/sys_user',
    headers: {Accept: 'application/json'},
    query: {sysparm_limit: '1', sysparm_fields: 'sys_id'},
    body: null,
});
assert.equal(response.status, 200);
assert.ok(response.data && typeof response.data === 'object');
process.stderr.write(`SDK compatibility live PASS: ${mode} backend, one bounded read-only request.\n`);
