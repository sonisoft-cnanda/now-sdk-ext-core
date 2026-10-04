/**
 * Live Workflow Editor–parity lifecycle: create → publish → check out → add, wire, edit and
 * remove activities → validate → publish → check out again → discard → delete.
 *
 * Safety: only touches workflows this suite creates (named NEX_IT_<timestamp>), and runs
 * inside a scratch update set so publishes are not captured in the user's current one.
 * The user's current update set is restored, and every created workflow and its captured
 * update records are deleted afterwards.
 *
 *   SN_INSTANCE_ALIAS=<alias> npm run test:integration -- WorkflowLifecycle
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getCredentials } from '@servicenow/sdk-cli/dist/auth/index.js';
import { ServiceNowInstance, ServiceNowSettingsInstance } from '../../../../src/sn/ServiceNowInstance';
import { WorkflowManager } from '../../../../src/sn/workflow/WorkflowManager';
import { UpdateSetManager } from '../../../../src/sn/updateset/UpdateSetManager';
import { ServiceNowRequest } from '../../../../src/comm/http/ServiceNowRequest';
import { WorkflowValidationError } from '../../../../src/exception/WorkflowValidationError';
import { initCredentialStore } from '../../../../src/credentials/ensureShim';
import { SN_INSTANCE_ALIAS } from '../../../test_utils/test_config';

const SECONDS = 1000;
const SCRATCH_UPDATE_SET = 'NEX workflow integration tests';

describe('WorkflowManager - Workflow Editor parity lifecycle (live)', () => {
    let instance: ServiceNowInstance;
    let wm: WorkflowManager;
    let updateSets: UpdateSetManager;
    let snReq: ServiceNowRequest;
    let previousUpdateSet: { sys_id: string; name: string } | null = null;
    let scratchUpdateSetSysId = '';
    const createdWorkflows: string[] = [];
    const name = `NEX_IT_${Date.now()}`;

    beforeAll(async () => {
        await initCredentialStore();
        const credential = await getCredentials(SN_INSTANCE_ALIAS);
        if (!credential) throw new Error('Could not get credentials.');
        instance = new ServiceNowInstance({ alias: SN_INSTANCE_ALIAS, credential } as ServiceNowSettingsInstance);
        wm = new WorkflowManager(instance);
        updateSets = new UpdateSetManager(instance);
        snReq = new ServiceNowRequest(instance);

        previousUpdateSet = await updateSets.getCurrentUpdateSet();
        const existing = await updateSets.listUpdateSets({ encodedQuery: `name=${SCRATCH_UPDATE_SET}^state=in progress`, limit: 1 });
        const scratch = existing[0] ?? await updateSets.createUpdateSet({
            name: SCRATCH_UPDATE_SET, description: 'Scratch set for now-sdk-ext-core workflow integration tests. Safe to delete.',
        });
        scratchUpdateSetSysId = scratch.sys_id;
        await updateSets.setCurrentUpdateSet({ name: SCRATCH_UPDATE_SET, sysId: scratch.sys_id });
    }, 60 * SECONDS);

    afterAll(async () => {
        for (const workflowSysId of createdWorkflows) {
            try {
                await wm.deleteWorkflow(workflowSysId);
            } catch (e) {
                console.warn(`Warning: failed to delete workflow ${workflowSysId}:`, (e as Error).message);
            }
            try {
                const captured = await snReq.get<{ result: Array<{ sys_id: string }> }>({
                    path: '/api/now/table/sys_update_xml', headers: { Accept: 'application/json' }, body: null,
                    query: { sysparm_query: `name=wf_workflow_${workflowSysId}^update_set=${scratchUpdateSetSysId}`, sysparm_fields: 'sys_id' },
                });
                for (const row of captured.bodyObject?.result ?? []) {
                    await snReq.delete({ path: `/api/now/table/sys_update_xml/${row.sys_id}`, headers: { Accept: 'application/json' }, query: null, body: null });
                }
            } catch (e) {
                console.warn(`Warning: failed to clean update records for ${workflowSysId}:`, (e as Error).message);
            }
        }
        if (previousUpdateSet) {
            await updateSets.setCurrentUpdateSet({ name: previousUpdateSet.name.replace(/ \[[^\]]+\]$/, ''), sysId: previousUpdateSet.sys_id });
        }
    }, 120 * SECONDS);

    it('creates, checks out, edits and publishes a workflow like the editor', async () => {
        // Create and publish v1 (Begin → End)
        const created = await wm.newWorkflow({ name, table: 'incident', description: 'now-sdk-ext-core integration test (safe to delete)' });
        createdWorkflows.push(created.workflowSysId);
        expect(created.versionSysId).toMatch(/^[0-9a-f]{32}$/);
        await wm.publish(created.versionSysId);

        // Check out (twice: the second returns the same draft)
        const checkout = await wm.checkout(name);
        expect(checkout.alreadyCheckedOut).toBe(false);
        expect(checkout.versionSysId).not.toBe(created.versionSysId);
        expect((await wm.checkout(created.workflowSysId)).versionSysId).toBe(checkout.versionSysId);
        const draft = checkout.versionSysId;

        let definition = await wm.getWorkflowDefinition(draft);
        expect(definition.status).toMatchObject({ readOnly: false, canPublish: true });
        const end = definition.activities.find(a => a.definitionName === 'End');
        expect(definition.transitions).toHaveLength(1);

        // Drop a Timer onto Begin → End
        const timer = await wm.addActivity(draft, {
            definition: 'Timer', name: 'Wait', insertOn: definition.transitions[0].sysId,
            variables: { timer_type: 'script', script: 'answer = 10;' },
        });
        expect(timer.conditions.map(c => c.name)).toEqual(['Always']);

        // An If after the Timer (re-point Timer → End at it), Yes → End, plus No → End
        const decide = await wm.addActivity(draft, {
            definition: 'If', name: 'Decide', connectTo: end.sysId, exitCondition: 'Yes',
            variables: { advanced: true, script: "answer = 'yes';" },
        });
        expect(decide.conditions.map(c => c.name)).toEqual(['Yes', 'No']);
        await wm.retargetTransition(timer.transitionSysIds[1], decide.activitySysId);
        await wm.addTransition({ from: decide.activitySysId, to: end.sysId, condition: 'No' });

        // Edit: variables and a duration, rename, move
        await wm.updateActivity(timer.activitySysId, { name: 'Wait a bit', variables: { timer_type: '', duration: { minutes: 5 } }, x: 250, y: 90 });

        // A throwaway activity in a line, then removed with reconnect
        const temp = await wm.addActivity(draft, {
            definition: 'Log Message', name: 'Temp', connectFrom: { activity: decide.activitySysId, condition: 'No' }, connectTo: end.sysId,
            variables: { message: 'temporary' },
        });
        await wm.removeActivity(temp.activitySysId, { reconnect: true });

        definition = await wm.getWorkflowDefinition(draft);
        const byName = Object.fromEntries(definition.activities.map(a => [a.name, a]));
        expect(Object.keys(byName).sort()).toEqual(['Begin', 'Decide', 'End', 'Wait a bit']);
        expect(byName['Wait a bit']).toMatchObject({ x: 250, y: 90 });
        expect(byName['Wait a bit'].variables).toMatchObject({ timer_type: '', duration: '1970-01-01 00:05:00', script: 'answer = 10;' });
        expect(byName['Decide'].variables).toMatchObject({ advanced: '1', script: "answer = 'yes';" });
        const label = (t: { from: string; condition: string; to: string }) => {
            const from = definition.activities.find(a => a.sysId === t.from);
            const exit = from.conditions.find(c => c.sysId === t.condition);
            return `${from.name} -[${exit.name}]-> ${definition.activities.find(a => a.sysId === t.to).name}`;
        };
        expect(definition.transitions.map(label).sort()).toEqual([
            'Begin -[Always]-> Wait a bit',
            'Decide -[No]-> End',
            'Decide -[Yes]-> End',
            'Wait a bit -[Always]-> Decide',
        ]);

        // An orphan makes validation warn; strict publish refuses, allowWarnings publishes
        await wm.addActivity(draft, { definition: 'Run Script', name: 'Orphan', x: 700, y: 40, variables: { script: 'gs.info("x");' } });
        expect((await wm.validateWorkflow(draft)).valid).toBe(false);
        const refused = await wm.publish(draft).catch(e => e);
        expect(refused).toBeInstanceOf(WorkflowValidationError);
        expect(refused.level).toBe('warning');
        expect(refused.items.map((i: { type: string }) => i.type)).toContain('ValidateTransitionIn');
        const published = await wm.publish(draft, { allowWarnings: true });
        expect(published.fullSequences).toContain(byName['Decide'].sysId);

        const versions = await wm.getWorkflowVersions(created.workflowSysId);
        expect(versions.filter(v => v.published).map(v => v.sysId)).toEqual([draft]);

        // The publish was captured in the scratch update set
        const captured = await snReq.get<{ result: Array<{ sys_id: string }> }>({
            path: '/api/now/table/sys_update_xml', headers: { Accept: 'application/json' }, body: null,
            query: { sysparm_query: `name=wf_workflow_${created.workflowSysId}^update_set=${scratchUpdateSetSysId}`, sysparm_fields: 'sys_id' },
        });
        expect(captured.bodyObject?.result?.length).toBe(1);

        // A new checkout copies the edited version; discarding it keeps the published one
        const again = await wm.checkout(name);
        const copy = await wm.getWorkflowDefinition(again.versionSysId, { includeStatus: false });
        expect(copy.activities.find(a => a.name === 'Wait a bit')?.variables?.duration).toBe('1970-01-01 00:05:00');
        await wm.discardCheckout(again.versionSysId);
        const summary = await wm.resolveWorkflow(name);
        expect(summary.publishedVersionSysId).toBe(draft);
        expect(summary.checkedOutVersion).toBeUndefined();
    }, 240 * SECONDS);
});
