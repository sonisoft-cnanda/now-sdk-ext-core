import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {comparePreferences} from '../../../../dist/sn/metadata/internal/MetadataPreferences.js';
import {COPY,COPY_A,COPY_B,GLOBAL_SET} from './lifecycle.mjs';
const {values}=parseArgs({options:{auth:{type:'string'},'private-dir':{type:'string'}}});
assert.equal(values.auth,'dev206299');assert.ok(values['private-dir']);
const root=values['private-dir'],report=JSON.parse(readFileSync(join(root,'lifecycle-safe.json'),'utf8'));
const baseline=JSON.parse(readFileSync(join(root,report.snapshots.find(s=>s.label==='L0_immutable_baseline').file),'utf8'));
const checks=[];
function call(args) {
    const argv=[...args,'-a','dev206299','--read-only','--json'];
    const run=spawnSync('nex',argv,{encoding:'utf8',maxBuffer:5*1024*1024,timeout:60000});
    assert.equal(run.status,0,'audit_command_failed');
    const start=run.stdout.search(/^\s*\{/m);assert.ok(start>=0,'audit_json');
    const result=JSON.parse(run.stdout.slice(start));
    checks.push({utc:new Date().toISOString(),argv,status:run.status});return result;
}
function rows(table,query,fields) {
    const count=call(['aggregate','count','-t',table,'-q',query]);
    const result=call(['query','-t',table,'-q',query,'-f',fields,'-l','1000']);
    const records=result.records??result.result;
    assert.ok(Array.isArray(records),'audit_records');
    const scalar=v=>v&&typeof v==='object'?v.value:v;
    const normalized=records.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,scalar(v)])));
    // Accept the CLI's documented count wrappers, then enforce membership below.
    const total=count.count??count.result?.stats?.count??count.stats?.count??count.totalCount;
    assert.equal(Number(total),normalized.length,'audit_count');
    const after=call(['aggregate','count','-t',table,'-q',query]);
    assert.equal(Number(after.count??after.result?.stats?.count??after.stats?.count??after.totalCount),normalized.length,'audit_count_changed');
    checks.push({table,query,count:normalized.length});return normalized;
}
const preferences=rows('sys_user_preference',`user=${baseline[0].user}`,'sys_id,user,name,value');
assert.ok(preferences.every(r=>r.user===baseline[0].user));
const comparison=comparePreferences(baseline,preferences);
writeFileSync(join(root,'audit-preferences.json'),JSON.stringify(preferences),{mode:0o600});
const ledger=report.ledger;
for(const table of new Set(ledger.map(r=>r.table))) {
    const ids=ledger.filter(r=>r.table===table).map(r=>r.sysId);
    const records=rows(table,`sys_idIN${ids.join(',')}`,'sys_id,sys_scope');
    assert.ok(records.every(r=>ids.includes(r.sys_id)&&['global',COPY].includes(r.sys_scope)));
    checks.push({table,records});
}
if(ledger.length) {
    const names=ledger.map(r=>r.table+'_'+r.sysId);
    const captures=rows('sys_update_xml',`nameIN${names.join(',')}^sys_updated_on>=${report.started.slice(0,19).replace('T',' ')}`,'sys_id,name,application,update_set,action,sys_updated_on');
    assert.ok(captures.every(r=>names.includes(r.name)&&['global',COPY].includes(r.application)&&[COPY_A,COPY_B,GLOBAL_SET].includes(r.update_set)));
    checks.push({captures});
    const ids=ledger.map(r=>r.sysId);
    const deletes=rows('sys_metadata_delete',`sys_metadataIN${ids.join(',')}`,'sys_id,sys_metadata,sys_scope');
    assert.ok(deletes.every(r=>ids.includes(r.sys_metadata)&&['global',COPY].includes(r.sys_scope)));checks.push({deletes});
}
const sets=rows('sys_update_set',`sys_idIN${[COPY_A,COPY_B,GLOBAL_SET].join(',')}`,'sys_id,name,application,state');
assert.equal(sets.length,3);assert.ok(sets.every(r=>r.state==='in progress'&&r.application===(r.sys_id===GLOBAL_SET?'global':COPY)));
const result={alias:'dev206299',completed:new Date().toISOString(),preferencesUnchanged:comparison.unchanged,
    preferenceRowsReplaced:comparison.replaced,checks};
writeFileSync(join(root,'lifecycle-audit-safe.json'),JSON.stringify(result,null,2),{mode:0o600});
assert.equal(report.restored,true,'runtime_restoration');
assert.ok(comparison.unchanged||report.unrelated.length>0,'audit_restoration');
process.stderr.write('Read-only audit complete. Safe results saved.\n');
