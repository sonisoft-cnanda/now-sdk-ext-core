import assert from 'node:assert/strict';
export function requireOwnedFixture({entry,row,prefix,protectedIds}) {
    assert.ok(entry&&!entry.deleteAttempted&&!entry.deleted&&!protectedIds.has(entry.sysId),'cleanup_ownership');
    assert.ok(row&&row.sys_id===entry.sysId&&row.sys_scope===entry.scope,'cleanup_scope');
    if(entry.table==='sys_script_include')assert.ok(row.active==='false'&&row.name.startsWith(prefix),'cleanup_inactive_prefix');
}
export async function restoreState({plan,globalReached,getCurrent,selectApp,selectSet}) {
    if(globalReached)await selectSet(plan.remembered.global,'restoration');
    if(getCurrent()!==plan.copy)await selectApp(plan.copy,'restoration');
    await selectSet(plan.remembered[plan.copy],'restoration');
    if(getCurrent()!==plan.application)await selectApp(plan.application,'restoration');
    await selectSet(plan.currentSet,'restoration');
}
export function requireBaselineDestination({application,currentSet,remembered,set,scope}) {
    assert.ok(scope&&!/^(x_g|sn_apm)/i.test(scope.scope)&&!/enterprise architecture|bcbs/i.test(scope.name),'excluded_scope');
    assert.ok(set&&set.sys_id===currentSet&&set.application===application&&set.state==='in progress'&&remembered===currentSet,'baseline_current_set_destination');
}

export const ATF_SCRIPT='(function(outputs, steps, stepResult, assertEqual) { assertEqual({name: "sanity", shouldbe: true, value: true}); })(outputs, steps, stepResult, assertEqual);';
