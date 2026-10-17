import test from 'node:test';
import assert from 'node:assert/strict';
import {requireOwnedFixture,restoreState,requireBaselineDestination} from './controls.mjs';
const entry={table:'sys_script_include',sysId:'owned',scope:'copy',deleted:false,deleteAttempted:false};
const row={sys_id:'owned',sys_scope:'copy',name:'NSE14Example',active:'false'};
test('cleanup accepts only inactive ledger records in their exact scope',()=>{
    requireOwnedFixture({entry,row,prefix:'NSE14',protectedIds:new Set()});
    for(const bad of [{...row,sys_id:'other'},{...row,sys_scope:'global'},{...row,active:'true'},{...row,name:'User data'}])
        assert.throws(()=>requireOwnedFixture({entry,row:bad,prefix:'NSE14',protectedIds:new Set()}));
    for(const bad of [{...entry,deleted:true},{...entry,deleteAttempted:true},undefined])
        assert.throws(()=>requireOwnedFixture({entry:bad,row,prefix:'NSE14',protectedIds:new Set()}));
    assert.throws(()=>requireOwnedFixture({entry,row,prefix:'NSE14',protectedIds:new Set(['owned'])}));
});
test('restoration reads current state and does not transmit a completed Global set selection twice',async()=>{
    let current='global',active='copy-a',remembered={global:'global-probe',copy:'copy-a'};
    const transmitted=[],completed=new Set();
    const plan={copy:'copy',application:'global',currentSet:'global-default',remembered:{global:'global-default',copy:'copy-default'}};
    await restoreState({plan,globalReached:true,getCurrent:()=>current,
        selectApp:async id=>{current=id;active=remembered[id];transmitted.push(['app',id]);},
        selectSet:async id=>{
            if(active===id&&remembered[current]===id)return;
            assert.ok(!completed.has(id));completed.add(id);transmitted.push(['set',id]);active=id;remembered[current]=id;
        }});
    assert.deepEqual(transmitted,[['set','global-default'],['app','copy'],['set','copy-default'],['app','global']]);
});
test('Copy Code-only restoration never selects Global',async()=>{
    const calls=[];await restoreState({plan:{copy:'copy',application:'copy',currentSet:'default',remembered:{copy:'default'}},
        globalReached:false,getCurrent:()=> 'copy',selectApp:async id=>calls.push(id),selectSet:async id=>calls.push(id)});
    assert.ok(!calls.includes('global'));
});
test('baseline destinations reject excluded scopes and wrong sets',()=>{
    const good={application:'copy',currentSet:'default',remembered:'default',set:{sys_id:'default',application:'copy',state:'in progress'},scope:{scope:'x_copy',name:'Copy Code'}};
    requireBaselineDestination(good);
    for(const bad of [{...good,scope:{scope:'x_g_test'}},{...good,scope:{scope:'sn_apm_test'}},{...good,scope:{scope:'sn_other',name:'Enterprise Architecture'}},{...good,remembered:'other'},{...good,set:{...good.set,state:'complete'}}])assert.throws(()=>requireBaselineDestination(bad));
});
