import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runLive,runHelper} from './run-live.mjs';

const base={accessHelper:'/test/sn-access.mjs',privateDir:'/test/private'};
test('native lifecycle invocation preserves environment and releases helper before audit',async()=>{
    const calls=[];let report=false;
    const previous=process.env.METADATA_LIVE_ALIAS;
    const result=await runLive({...base,hasReport:()=>report,run:async(helper,command)=>{
        assert.equal(helper,base.accessHelper);
        assert.equal(process.env.METADATA_LIVE_ALIAS,'dev206299');
        assert.equal(process.env.METADATA_PRIVATE_DIR,base.privateDir);
        calls.push(command);report=true;return {code:0,busy:false};
    }});
    assert.equal(result,0);
    assert.deepEqual(calls,[[process.execPath,'test/integration/sn/metadata/live-child.mjs'],
        [process.execPath,'test/integration/sn/metadata/audit.mjs','--auth','dev206299','--private-dir',base.privateDir]]);
    assert.equal(process.env.METADATA_LIVE_ALIAS,previous);
});
test('lifecycle failure stays failed even after a successful cleanup audit',async()=>{
    let report=false,calls=0;
    assert.equal(await runLive({...base,hasReport:()=>report,run:async()=>{
        calls++;report=true;return {code:calls===1?3:0,busy:false};
    }}),1);
    assert.equal(calls,2);
});
test('authentication failure before report does not start an audit or replay',async()=>{
    let calls=0;
    assert.equal(await runLive({...base,hasReport:()=>false,run:async()=>{calls++;return {code:1,busy:false};}}),1);
    assert.equal(calls,1);
});
test('audit failure propagates without retrying lifecycle or audit',async()=>{
    let report=false,calls=0;
    assert.equal(await runLive({...base,hasReport:()=>report,run:async()=>{
        calls++;report=true;return {code:calls===1?0:2,busy:false};
    }}),1);
    assert.equal(calls,2);
});
test('refuses stale evidence before any child invocation',async()=>{
    await assert.rejects(runLive({...base,hasReport:()=>true,run:async()=>assert.fail('no child')}),/fresh_private_directory_required/);
});
test('contention waits 900 seconds with injected time and rechecks only once',async()=>{
    let time=0,calls=0;const sleeps=[];
    assert.equal(await runLive({...base,hasReport:()=>false,now:()=>time,
        sleep:async ms=>{time+=ms;sleeps.push(ms);},run:async()=>{calls++;return {code:1,busy:true};}}),1);
    assert.equal(calls,2);assert.equal(time,900000);assert.ok(sleeps.every(ms=>ms<=30000));
});
test('real helper child forwards exact native command and propagates exit and signal failures',async()=>{
    const dir=mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR||tmpdir(),'metadata-runner-'));
    try {
        const helper=join(dir,'helper.mjs');
        writeFileSync(helper,`import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
assert.deepEqual(process.argv.slice(2,6),['run','--alias','dev206299','--']);
const child=spawn(process.argv[6],process.argv.slice(7),{stdio:'inherit'});
child.on('close',(code,signal)=>{if(signal)process.kill(process.pid,signal);else process.exitCode=code;});`);
        assert.equal((await runHelper(helper,[process.execPath,'-e','process.exit(0)'])).code,0);
        assert.equal((await runHelper(helper,[process.execPath,'-e','process.exit(7)'])).code,7);
        const signalled=await runHelper(helper,[process.execPath,'-e',"process.kill(process.pid,'SIGTERM')"]);
        assert.equal(signalled.code,1);assert.equal(signalled.signal,'SIGTERM');
        const missing=await runHelper(join(dir,'missing.mjs'),[]);assert.notEqual(missing.code,0);
    } finally {rmSync(dir,{recursive:true,force:true});}
});

test('a zero child exit without lifecycle evidence cannot pass',async()=>{
    assert.equal(await runLive({...base,hasReport:()=>false,run:async()=>({code:0,busy:false})}),1);
});
