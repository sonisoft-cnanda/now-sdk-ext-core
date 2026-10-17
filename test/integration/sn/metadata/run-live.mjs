import {spawn} from 'node:child_process';
import {parseArgs} from 'node:util';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
const {values}=parseArgs({options:{'access-helper':{type:'string'},'private-dir':{type:'string'}}});
if(!values['access-helper']||!values['private-dir'])throw Error('explicit_paths_required');
process.env.METADATA_PRIVATE_DIR=values['private-dir'];process.env.METADATA_LIVE_ALIAS='dev206299';
function helper(command) {
    return new Promise(resolve=>{
        let busy=false;
        const child=spawn(process.execPath,[values['access-helper'],'run','--alias','dev206299','--',...command],{stdio:['ignore','pipe','pipe']});
        for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{
            if(String(chunk).includes('ALIAS_BUSY'))busy=true;process.stderr.write(chunk);
        });
        child.on('error',()=>resolve({code:1,busy:false}));child.on('close',code=>resolve({code,busy}));
    });
}
const command=[process.execPath,'--experimental-vm-modules','node_modules/.bin/jest','--runInBand','--runTestsByPath','test/integration/sn/metadata/MetadataFormWriter_IT.test.ts','--coverage=false'];
let result=await helper(command);
if(result.busy) {
    const start=performance.now();
    while(performance.now()-start<900000) {
        process.stderr.write('Alias busy. Waiting for the one permitted recheck.\n');
        await new Promise(resolve=>setTimeout(resolve,Math.min(30000,900000-(performance.now()-start))));
    }
    result=await helper(command);
}
if(!result.busy&&existsSync(join(values['private-dir'],'lifecycle-safe.json'))) {
    const audit=await helper([process.execPath,'test/integration/sn/metadata/audit.mjs','--auth','dev206299','--private-dir',values['private-dir']]);
    if(audit.code!==0)process.stderr.write('Independent audit incomplete. No retry.\n');
    if(audit.code!==0)result.code=1;
}
process.exitCode=result.code??1;
