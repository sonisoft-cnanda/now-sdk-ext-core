import {spawn} from 'node:child_process';
import {parseArgs} from 'node:util';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function runHelper(accessHelper, command) {
    return new Promise(resolveResult=>{
        let busy=false;
        const child=spawn(process.execPath,[accessHelper,'run','--alias','dev206299','--',...command],{stdio:['ignore','pipe','pipe']});
        for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{
            if(String(chunk).includes('ALIAS_BUSY'))busy=true;process.stderr.write(chunk);
        });
        child.on('error',()=>resolveResult({code:1,busy:false}));
        child.on('close',(code,signal)=>resolveResult({code:signal?1:code??1,busy,signal}));
    });
}
export async function runLive({accessHelper,privateDir,run=runHelper,
    sleep=ms=>new Promise(resolveSleep=>setTimeout(resolveSleep,ms)),now=()=>performance.now(),
    hasReport=()=>existsSync(join(privateDir,'lifecycle-safe.json'))}) {
    if(!accessHelper||!privateDir)throw Error('explicit_paths_required');
    if(hasReport())throw Error('fresh_private_directory_required');
    const envAlias=process.env.METADATA_LIVE_ALIAS,envDir=process.env.METADATA_PRIVATE_DIR;
    process.env.METADATA_PRIVATE_DIR=privateDir;process.env.METADATA_LIVE_ALIAS='dev206299';
    try {
        const command=[process.execPath,'test/integration/sn/metadata/live-child.mjs'];
        let result=await run(accessHelper,command);
        if(result.busy) {
            const start=now();
            while(now()-start<900000) {
                process.stderr.write('Alias busy. Waiting for the one permitted recheck.\n');
                await sleep(Math.min(30000,900000-(now()-start)));
            }
            result=await run(accessHelper,command);
        }
        // The first helper has exited and released its lock before this separate audit.
        if(!result.busy&&hasReport()) {
            const audit=await run(accessHelper,[process.execPath,'test/integration/sn/metadata/audit.mjs','--auth','dev206299','--private-dir',privateDir]);
            if(audit.code!==0) {
                process.stderr.write('Independent audit incomplete. No retry.\n');
                return 1;
            }
        }
        return result.code===0&&!result.busy&&hasReport()?0:1;
    } finally {
        if(envAlias===undefined)delete process.env.METADATA_LIVE_ALIAS;else process.env.METADATA_LIVE_ALIAS=envAlias;
        if(envDir===undefined)delete process.env.METADATA_PRIVATE_DIR;else process.env.METADATA_PRIVATE_DIR=envDir;
    }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
    const {values}=parseArgs({options:{'access-helper':{type:'string'},'private-dir':{type:'string'}}});
    process.exitCode=await runLive({accessHelper:values['access-helper'],privateDir:values['private-dir']});
}
