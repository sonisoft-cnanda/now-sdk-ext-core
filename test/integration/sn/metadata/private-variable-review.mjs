// Offline check: publish equality and whole-file hashes, never variable values.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,writeFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {parseFormHtml} from '../../../../dist/comm/http/FormHtmlParser.js';
import {ATF_SCRIPT} from './controls.mjs';
const {values}=parseArgs({options:{'private-dir':{type:'string'},output:{type:'string'}}});
assert.ok(values['private-dir']&&values.output);
const root=values['private-dir'],report=JSON.parse(readFileSync(join(root,'lifecycle-safe.json'),'utf8'));
const step=report.ledger.filter(r=>r.table==='sys_atf_step');assert.equal(step.length,1);
const candidates=[];
for(const name of readdirSync(root).filter(n=>n.endsWith('.html'))) {
    const file=join(root,name);assert.equal(statSync(file).mode&0o777,0o600);
    const raw=readFileSync(file,'utf8');let form;
    try {form=parseFormHtml(raw,'sys_atf_step');}catch {continue;}
    if(form.sysId!==step[0].sysId||form.isNewRecord)continue;
    const script=Object.values(form.variables).filter(v=>v.element==='script');
    candidates.push({file:name,sha256:createHash('sha256').update(raw).digest('hex'),exactMatch:script.some(v=>v.value===ATF_SCRIPT)});
}
assert.ok(candidates.some(c=>c.exactMatch),'persisted_script_not_proven');
writeFileSync(values.output,JSON.stringify({table:'sys_atf_step',sysId:step[0].sysId,exactScriptMatch:true,candidates},null,2));
