import assert from 'node:assert/strict';
import {requireOwnedFixture,restoreState,requireBaselineDestination,ATF_SCRIPT} from './controls.mjs';
import {readFileSync,writeFileSync,mkdirSync,chmodSync,statSync,existsSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {initCredentialStore} from '../../../../dist/credentials/ensureShim.js';
import {ServiceNowInstance} from '../../../../dist/sn/ServiceNowInstance.js';
import {MetadataFormWriter} from '../../../../dist/sn/metadata/MetadataFormWriter.js';
import {SessionManager} from '../../../../dist/comm/http/SessionManager.js';
import {ScopeManager} from '../../../../dist/sn/scope/ScopeManager.js';
import {UpdateSetManager} from '../../../../dist/sn/updateset/UpdateSetManager.js';
import {parseFormHtml} from '../../../../dist/comm/http/FormHtmlParser.js';
import {configureLogging} from '../../../../dist/util/LogConfig.js';
import {MetadataReader} from '../../../../dist/sn/metadata/internal/MetadataReader.js';
import {comparePreferences} from '../../../../dist/sn/metadata/internal/MetadataPreferences.js';
import {READ_ONLY} from '../../../../dist/policy/PolicyTypes.js';

export const COPY='21021ccd53bfcf90b6d61901a0490e91', COPY_A='700e15085304d754b6d61901a0490ed0', COPY_B='380e15085304d754b6d61901a0490ed6', GLOBAL_SET='38b2a5445344d754b6d61901a0490e18';
const PROTECTED=new Set(['2dd18dcc538c9754b6d61901a0490e29','f853090c53cc9754b6d61901a0490ef6','5c2d67e053c89f54b6d61901a0490ebd']);
const ID=/^[a-f0-9]{32}$/i;
function privateRoot() {
    const root=resolve(process.env.METADATA_PRIVATE_DIR??'');
    assert.ok(process.env.METADATA_PRIVATE_DIR&&root!==process.cwd()&&!root.startsWith(process.cwd()+'/'),'private_directory_required');
    for(const key of ['PAPERCLIP_RUN_SCRATCH_DIR','PAPERCLIP_SCRATCH_DIR']) if(process.env[key]) assert.ok(!root.startsWith(resolve(process.env[key])+'/'),'persistent_storage_required');
    mkdirSync(root,{recursive:true,mode:0o700});chmodSync(root,0o700);return root;
}
function assertLock() {
    let pid=process.ppid,owner;
    for(let n=0;n<8&&pid>1;n++) {
        const args=readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0');
        if(args.some(a=>a.endsWith('/sn-access.mjs'))&&args.some((a,i)=>a==='--alias'&&args[i+1]==='dev206299')) {owner=pid;break;}
        pid=Number(readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ')[1]);
    }
    assert.ok(owner,'access_lock_ancestor_required');
    const locks=join(process.env.XDG_STATE_HOME||join(homedir(),'.local','state'),'sn-access');
    assert.equal(readdirSync(locks).filter(n=>n.endsWith('.lock')).filter(n=>JSON.parse(readFileSync(join(locks,n),'utf8')).pid===owner).length,1,'owned_alias_lock_required');
}
function value(rows,name) {const found=rows.filter(row=>row.name===name);assert.equal(found.length,1,'preference_destination_ambiguous');return found[0].value;}
export async function runLifecycle() {
    assert.equal(process.env.METADATA_LIVE_ALIAS,'dev206299');assertLock();
    const root=privateRoot(),marker=join(root,'lifecycle-attempt.json');assert.ok(!existsSync(marker),'lifecycle_already_attempted');
    configureLogging({file:false,console:false});
    assert.equal((await initCredentialStore()).active,true,'credential_store_required');
    const {getCredentials}=await import('@servicenow/sdk-cli/dist/auth/index.js');
    const instance=new ServiceNowInstance({alias:'dev206299',credential:await getCredentials('dev206299')});
    const req=await SessionManager.getInstance().getAuthenticatedRequest(instance);
    const reader=new MetadataReader(req),writer=new MetadataFormWriter(instance);
    const scopes=new ScopeManager(instance),sets=new UpdateSetManager(instance);
    // Setup managers have no injection API. Bind their private, unused request before authentication.
    scopes._req=req;sets._req=req;
    assert.equal(scopes._tableAPI.snInstance,instance);assert.equal(sets._tableAPI.snInstance,instance);
    const users=await reader.rows('sys_user','sys_id=javascript:gs.getUserID()','sys_id,user_name');
    assert.equal(users.length,1);assert.equal(users[0].user_name,'admin');
    const user=users[0].sys_id;assert.ok(ID.test(user));
    const report={alias:'dev206299',started:new Date().toISOString(),classification:'server/client library',stages:[],ledger:[],snapshots:[],requests:[],unrelated:[]};
    const persist=()=>writeFileSync(join(root,'lifecycle-safe.json'),JSON.stringify(report,null,2),{mode:0o600});
    let sequence=0,baseline,plan,current,globalReached=false,setupStarted=false;
    const touched=new Set(),mutations=new Set();
    const once=async(key,fn)=>{assert.ok(!mutations.has(key),'mutation_already_attempted');mutations.add(key);persist();return fn();};
    const preferences=async(label)=>{
        const rows=await reader.rows('sys_user_preference',`user=${user}`,'sys_id,user,name,value');
        assert.ok(rows.length&&rows.every(r=>r.user===user));
        const count=await req.get({path:'/api/now/stats/sys_user_preference',headers:null,body:null,query:{sysparm_query:`user=${user}`,sysparm_count:'true'},requires:READ_ONLY,sensitive:true});
        assert.equal(Number(count.bodyObject?.result?.stats?.count),rows.length,'preference_count');
        const file=`snapshot-${String(++sequence).padStart(3,'0')}.json`,raw=JSON.stringify(rows);
        writeFileSync(join(root,file),raw,{mode:0o600});
        assert.equal(statSync(join(root,file)).mode&0o777,0o600);
        report.snapshots.push({label,file,count:rows.length,sha256:createHash('sha256').update(raw).digest('hex')});persist();return rows;
    };
    const scope=async id=>{
        const row=await reader.exact('sys_scope',id,'scope,name');
        assert.ok(row&&!/^(x_g|sn_apm)/i.test(row.scope)&&!/enterprise architecture|bcbs/i.test(row.name),'excluded_scope');return row;
    };
    const set=async id=>{assert.ok(ID.test(id),'set_id');const row=await reader.exact('sys_update_set',id,'name,application,state');assert.ok(row&&row.state==='in progress');await scope(row.application);return row;};
    const ea=async expected=>{
        const r=await req.get({path:'/sys_script_include.do',query:{sys_id:'-1'},headers:null,body:null,requires:READ_ONLY,responseFormat:'text',sensitive:true,redirect:'manual'});
        assert.equal(r.status,200);assert.equal(parseFormHtml(r.data,'sys_script_include').fields['sys_script_include.sys_scope']?.value,expected,'effective_application');current=expected;
    };
    const selectApp=async(id,phase)=>once(`${phase}:application:${id}`,async()=>{
        await scope(id);touched.add('apps.current_app');touched.add('sys_update_set');touched.add(`updateSetForScope${id}`);
        const result=await scopes.setCurrentApplication(id);assert.ok(result.success,'application_selection_failed');current=id;await ea(id);
    });
    const selectSet=async(id,phase)=>{
        const row=await set(id);assert.equal(row.application,current,'set_application');
        const now=await preferences('before_set_selection');
        if(value(now,'sys_update_set')===id&&value(now,`updateSetForScope${current}`)===id)return;
        await once(`${phase}:set:${id}`,async()=>{
            touched.add('sys_update_set');touched.add(`updateSetForScope${current}`);
            await sets.setCurrentUpdateSet({sysId:id,name:row.name});
            const after=await preferences('after_set_selection');assert.equal(value(after,'sys_update_set'),id);assert.equal(value(after,`updateSetForScope${current}`),id);
        });
    };
    const changes=rows=>{
        const names=new Set([...baseline,...rows].filter(row=>!touched.has(row.name)).map(row=>row.name));
        return [...names].filter(name=>!comparePreferences(baseline.filter(r=>r.name===name),rows.filter(r=>r.name===name)).valid).sort();
    };
    const ownedEqual=rows=>comparePreferences(baseline.filter(r=>touched.has(r.name)),rows.filter(r=>touched.has(r.name))).valid;
    const originalGet=req.get.bind(req),originalPost=req.post.bind(req);
    req.get=async input=>{
        const result=await originalGet(input);
        if(input.path.endsWith('.do')&&typeof result.data==='string') {
            const file=`form-${report.requests.length}.html`;writeFileSync(join(root,file),result.data,{mode:0o600});
            report.requests.push({method:'GET',path:input.path,queryNames:Object.keys(input.query??{}),status:result.status,
                rawFile:file,sha256:createHash('sha256').update(result.data).digest('hex')});persist();
        }return result;
    };
    req.post=async input=>{
        if(input.path.endsWith('.do')) {
            const id=input.fields?.sys_uniqueValue;
            assert.ok(ID.test(id)&&!PROTECTED.has(id),'protected_record');
            if(input.fields.sys_row==='-1') {report.ledger.push({table:input.path.slice(1,-3),sysId:id,scope:input.fields.sysparm_transaction_scope,
                name:input.fields[`${input.path.slice(1,-3)}.name`]??'',deleteAttempted:false,deleted:false});persist();}
            report.requests.push({method:'POST',path:input.path,fieldNames:Object.keys(input.fields).sort()});persist();
        }
        const result=await originalPost(input);
        if(input.path.endsWith('.do')&&typeof result.data==='string') {
            const file=`post-${report.requests.length}.html`;writeFileSync(join(root,file),result.data,{mode:0o600});
            const location=result.headers?.location;
            const url=location?new URL(location,'https://dev206299.service-now.com'):null;
            report.requests.push({method:'POST_RESPONSE',path:input.path,status:result.status,rawFile:file,
                sha256:createHash('sha256').update(result.data).digest('hex'),locationPath:url?.pathname,locationParameters:url?[...url.searchParams.keys()]:[]});persist();
        }
        return result;
    };
    const saveResult=(stage,result)=>{report.stages.push({stage,status:'PASS',table:result.table,sysId:result.sysId,scope:result.scope,capture:result.capture});persist();return result;};
    const remove=async item=>{
        const entry=report.ledger.find(r=>r.table===item.table&&r.sysId===item.sysId);
        assert.ok(entry,'cleanup_ownership');
        const row=await reader.exact(entry.table,entry.sysId,entry.table==='sys_script_include'?'name,active,sys_scope':'sys_scope');
        requireOwnedFixture({entry,row,prefix,protectedIds:PROTECTED});
        entry.deleteAttempted=true;persist();
        const result=await writer.delete(entry.table,entry.sysId,{scope:entry.scope==='global'?'global':{sysId:entry.scope},confirm:{table:entry.table,sysId:entry.sysId}});
        assert.equal(await reader.exact(entry.table,entry.sysId,'sys_scope'),undefined);entry.deleted=true;persist();return result;
    };
    const prefix='NSE14'+new Date().toISOString().replace(/\D/g,'').slice(0,14);
    const fields=suffix=>({name:prefix+suffix,active:false,script:`var ${prefix+suffix} = Class.create(); ${prefix+suffix}.prototype = { initialize: function() {}, type: '${prefix+suffix}' };`});
    let failure;
    try {
        baseline=await preferences('L0_immutable_baseline');
        plan={copy:COPY,application:value(baseline,'apps.current_app'),currentSet:value(baseline,'sys_update_set'),remembered:{}};
        for(const id of new Set([plan.application,COPY,'global'])) {await scope(id);const remembered=value(baseline,`updateSetForScope${id}`);assert.equal((await set(remembered)).application,id);plan.remembered[id]=remembered;}
        requireBaselineDestination({application:plan.application,currentSet:plan.currentSet,remembered:plan.remembered[plan.application],set:await set(plan.currentSet),scope:await scope(plan.application)});
        for(const [id,app] of [[COPY_A,COPY],[COPY_B,COPY],[GLOBAL_SET,'global']])assert.equal((await set(id)).application,app);
        writeFileSync(marker,JSON.stringify({started:report.started}),{flag:'wx',mode:0o600});
        setupStarted=true;await selectApp(COPY,'setup');await selectSet(COPY_A,'setup');
        globalReached=true;await selectApp('global','setup');await selectSet(GLOBAL_SET,'setup');await ea('global');
        assert.equal(value(await preferences('L0_setup_complete'),`updateSetForScope${COPY}`),COPY_A);
        report.stages.push({stage:'L0',status:'PASS'});persist();
        const first=saveResult('L1',await writer.insert('sys_script_include',{scope:{sysId:COPY},fields:fields('One')}));
        assert.equal(first.capture.updateSetSysId,COPY_A);
        saveResult('L2_update',await writer.update(first.table,first.sysId,{scope:{sysId:COPY},fields:{script:fields('One').script+'\n// Updated'}}));
        const second=saveResult('L2_explicit_set',await writer.insert('sys_script_include',{scope:{sysId:COPY},updateSet:COPY_B,fields:fields('Two')}));
        assert.equal(second.capture.updateSetSysId,COPY_B);
        saveResult('L3_first',await remove(first));saveResult('L3_second',await remove(second));
        const measured=await preferences('L4');
        const setup=JSON.parse(readFileSync(join(root,report.snapshots.find(r=>r.label==='L0_setup_complete').file),'utf8'));
        assert.ok(comparePreferences(setup,measured,COPY_A).valid,'L4_preferences');report.stages.push({stage:'L4',status:'PASS'});
        const negative=saveResult('L5_setup',await writer.insert('sys_script_include',{scope:'global',fields:fields('Global')}));
        const postCount=report.requests.filter(r=>r.method==='POST').length;
        await assert.rejects(writer.update(negative.table,negative.sysId,{scope:{sysId:COPY},fields:{active:false}}),error=>error.code==='scope_mismatch');
        assert.equal(report.requests.filter(r=>r.method==='POST').length,postCount);report.stages.push({stage:'L5',status:'PASS'});await remove(negative);
        const atf=saveResult('L6_test',await writer.insert('sys_atf_test',{scope:{sysId:COPY},fields:{name:prefix+'ATF',active:false}}));
        const step=saveResult('L6_step',await writer.insert('sys_atf_step',{scope:{sysId:COPY},
            initialQuery:`test=${atf.sysId}^order=1^step_config=41de4a935332120028bc29cac2dc349a`,
            variables:{script:ATF_SCRIPT},variableField:'inputs'}));
        const variables=await reader.rows('sys_variable_value',`document_key=${step.sysId}`,'sys_id,document_key,variable,value');
        assert.ok(variables.length&&variables.every(r=>r.document_key===step.sysId),'L6_variable_rows');
        const definitions=await Promise.all(variables.map(r=>reader.exact('sys_dictionary',r.variable,'element')));
        assert.ok(definitions.some((r,i)=>r?.element==='script'&&variables[i].value===ATF_SCRIPT),'L6_script_variable');
        report.stages.push({stage:'L6_variable',status:'PASS',rows:variables.map(r=>({sysId:r.sys_id,variable:r.variable}))});
        await remove(step);await remove(atf);
        const remaining=await reader.rows('sys_variable_value',`document_key=${step.sysId}`,'sys_id,document_key,variable');
        report.stages.push({stage:'L6_cleanup',status:remaining.length?'INCOMPLETE':'PASS',remaining:remaining.map(r=>r.sys_id)});
        assert.equal(remaining.length,0,'L6_dependent_metadata_remaining');
        report.operationsComplete=true;
    } catch(error) {
        failure=error;report.status='INCOMPLETE';report.failure={name:error?.name??'Error',code:error?.code??'assertion_failed'};
        // No generic cleanup after a failed write. The ledger identifies retained records.
    } finally {
        report.restored=!setupStarted;
        if(setupStarted) {
            try {
                report.unrelated=changes(await preferences('before_restoration'));
                await restoreState({plan,globalReached,getCurrent:()=>current,selectApp,selectSet});
                let after=await preferences('after_restoration');
                if(!ownedEqual(after)) {
                    const own=after.filter(r=>touched.has(r.name)&&r.name!=='apps.current_app');
                    assert.ok(comparePreferences(baseline.filter(r=>touched.has(r.name)&&r.name!=='apps.current_app'),own).valid,'other_owned_restoration_difference');
                    const row=after.filter(r=>r.name==='apps.current_app');assert.equal(row.length,1);
                    const initial={...row[0]},start=performance.now();
                    while(performance.now()-start<300000)await new Promise(resolve=>setTimeout(resolve,Math.min(30000,300000-(performance.now()-start))));
                    after=await preferences('quiet_recheck');
                    if(!ownedEqual(after)) {
                        const exact=await reader.exact('sys_user_preference',initial.sys_id,'user,name,value');
                        assert.deepEqual(exact,initial,'application_recovery_guards');
                        await once('restoration:application_value_patch',()=>req._requestHandler.doRequest({method:'PATCH',path:`/api/now/table/sys_user_preference/${initial.sys_id}`,headers:null,body:null,json:{value:plan.application},sensitive:true}));
                        after=await preferences('application_value_restored');
                    }
                }
                assert.ok(ownedEqual(after),'owned_restoration');report.restored=true;
                report.unrelated=[...new Set([...report.unrelated,...changes(after)])];
                if(report.unrelated.length){report.status='INCOMPLETE';failure??=new Error('concurrent_preferences');}
            } catch(error) {report.restored=false;report.restorationFailure=error?.code??'restoration_incomplete';failure??=error;}
        }
        report.status=failure?'INCOMPLETE':'PASS';
        report.completed=new Date().toISOString();persist();
    }
    if(failure)throw new Error(`Lifecycle incomplete; inspect restricted safe report (${report.failure?.code??report.restorationFailure??'concurrent_preferences'})`);
}
