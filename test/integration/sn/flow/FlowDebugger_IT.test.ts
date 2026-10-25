// This suite runs as real ESM (jest is invoked with --experimental-vm-modules),
// where the `jest` object is not injected as a global.
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { ServiceNowInstance } from '../../../../src/sn/ServiceNowInstance';
import { SN_INSTANCE_ALIAS } from '../../../test_utils/test_config';
import { initCredentialStore } from '../../../../src/credentials/ensureShim';
import { FlowDebugger } from '../../../../src/sn/flow/FlowDebugger';
import { FlowManager } from '../../../../src/sn/flow/FlowManager';
import { ServiceNowRequest } from '../../../../src/comm/http/ServiceNowRequest';

/**
 * Live FlowDebugger runs (NSE-21). A debug run executes the flow, so this suite runs only on
 * dev206299, against scratch copies in the scratch app x_2115789_flowdbg:
 *
 * - "NSE21 Debug Copy - Create Task" (a copy of OOB global create_task_1): creates an incident.
 * - "NSE21 Debug Nested - Retrieve Update Sets" (a copy of the sn_cicd_spoke subflow): a For Each
 *   calling a child subflow. Its first action would fail on the `.invalid` host; the test cancels
 *   before it runs.
 *
 * Every incident a run creates carries MARK and is deleted afterwards, and every debug context the
 * suite started is cancelled.
 */
const SECONDS = 1000;
const FIXTURE = 'bfd1455b53001310b6d61901a0490e0c';
const FIXTURE_NAME = 'x_2115789_flowdbg.nse21_debug_copy__create_task';
const NESTED = 'b8cb9ed753005310b6d61901a0490e00';
const MARK = 'NSE-21 FlowDebugger_IT (test, delete me)';
const inputs = { table: 'incident', field_values: `short_description=${MARK}`, wait: false };

const onDev = SN_INSTANCE_ALIAS === 'dev206299';
const suite = onDev ? describe : describe.skip;

suite('FlowDebugger - Integration Tests (dev206299 only)', () => {
    let instance: ServiceNowInstance;
    let dbg: FlowDebugger;
    let request: ServiceNowRequest;
    const started: string[] = [];

    beforeAll(async () => {
        await initCredentialStore();
        const { resolveSessionCredentials } = await import('../../../../src/auth/CredentialProvider');
        const credential = await resolveSessionCredentials(SN_INSTANCE_ALIAS);
        instance = new ServiceNowInstance({ alias: SN_INSTANCE_ALIAS, credential, credentialProvider: () => resolveSessionCredentials(SN_INSTANCE_ALIAS) });
        dbg = new FlowDebugger(instance);
        request = new ServiceNowRequest(instance);
    }, 60 * SECONDS);

    afterEach(async () => {
        for (const id of started.splice(0)) await dbg.cancel(id).catch(() => undefined);
        // A call that threw after its run started (runTo, say) never handed back the id: find it.
        for (const open of await dbg.listSessions().catch(() => [])) {
            if (open.flowSysId === FIXTURE || open.flowSysId === NESTED) await dbg.cancel(open.contextId).catch(() => undefined);
        }
        const found = await request.get<{ result: Array<{ sys_id: string }> }>({ path: '/api/now/table/incident', headers: null, body: null,
            query: { sysparm_query: `short_description=${MARK}`, sysparm_fields: 'sys_id', sysparm_limit: '20' } });
        for (const row of found.bodyObject?.result ?? []) {
            await request.delete({ path: `/api/now/table/incident/${row.sys_id}`, headers: null, query: null, body: null });
        }
    }, 120 * SECONDS);

    afterAll(async () => {
        const open = await dbg.listSessions().catch(() => []);
        expect(open.filter(s => s.flowSysId === FIXTURE || s.flowSysId === NESTED)).toEqual([]);
    }, 60 * SECONDS);

    it('pauses at a breakpoint mid-flow, shows the step data, steps, and finishes like a normal run', async () => {
        const session = await dbg.start({ flow: FIXTURE_NAME, inputs, breakpoints: [3] });
        started.push(session.contextId);
        expect(session.snapshot).toMatchObject({ state: 'PAUSED', pausedLines: [1] });
        expect(session.locations.map(l => l.step?.number)).toEqual([1, 2, 3, 4]);
        expect(session.breakpoints.map(b => [b.step?.number, b.verified])).toEqual([[3, true]]);

        const atThree = await dbg.resume(session.contextId);
        expect(atThree).toMatchObject({ state: 'PAUSED' });
        expect(atThree.pausedAt?.step).toMatchObject({ number: 3, kind: 'flowLogic' });
        const created = atThree.steps.find(s => s.step?.number === 1);
        expect(created).toMatchObject({ state: 'COMPLETE' });
        const record = created!.outputs.Record;
        expect(record?.displayValue).toMatch(/^[a-f0-9]{32}$/);

        const end = await dbg.stepOver(session.contextId);
        expect(end.state).toBe('COMPLETE');
        expect(end.flowOutputs.record?.displayValue).toBe(record!.displayValue);

        // The same inputs through a normal Test run give the same kind of output.
        const test = await new FlowManager(instance).testFlow({ flowId: FIXTURE, outputMap: inputs });
        expect(test.success).toBe(true);
        let details;
        for (let i = 0; i < 20; i++) {
            details = await new FlowManager(instance).getFlowContextDetails(test.contextId!);
            if (details.flowContext?.state === 'COMPLETE') break;
            await new Promise(r => setTimeout(r, 1000));
        }
        expect(details!.flowContext?.state).toBe('COMPLETE');
        expect(Object.keys(details!.flowReport!.operationsOutput.data)).toEqual(Object.keys(end.flowOutputs));
    }, 240 * SECONDS);

    it('cancels a paused run, and the cancel reads back', async () => {
        const session = await dbg.start({ flow: FIXTURE, inputs });
        started.push(session.contextId);
        const cancelled = await dbg.cancel(session.contextId);
        expect(cancelled).toMatchObject({ before: 'PAUSED_IN_DEBUG', after: 'CANCELLED', cancelled: true });
        expect((await dbg.cancel(session.contextId)).alreadyEnded).toBe(true);
        await expect(dbg.stepOver(session.contextId)).rejects.toMatchObject({ code: 'not_paused' });
    }, 120 * SECONDS);

    it('runTo stops at the step and leaves nothing open', async () => {
        const result = await dbg.runTo({ flow: FIXTURE, inputs, breakpoints: [2] });
        expect(result.snapshot.pausedAt?.step?.number).toBe(2);
        expect(result.cancel).toMatchObject({ after: 'CANCELLED' });
    }, 120 * SECONDS);

    it('follows step into a subflow call into its child context, and cancelling the root ends both', async () => {
        const session = await dbg.start({ flow: NESTED, inputs: { instance_id: 'nse21', update_set_ids: ['nse21-a', 'nse21-b'],
            instance_url: 'https://nse21-probe.invalid', credential_alias: '', api_version: '' } });
        started.push(session.contextId);
        expect(session.snapshot.pausedAt?.step).toMatchObject({ number: 1, kind: 'flowLogic' });
        const atCall = await dbg.stepInto(session.contextId);
        expect(atCall.pausedAt?.step).toMatchObject({ number: 2, kind: 'subflow' });
        const inChild = await dbg.stepInto(session.contextId);
        expect(inChild.state).toBe('PAUSED');
        expect(inChild.chain).toHaveLength(2);
        expect(inChild.contextId).not.toBe(session.contextId);
        const cancelled = await dbg.cancel(session.contextId);
        expect(cancelled.after).toBe('CANCELLED');
        const child = await new FlowManager(instance).getFlowContextDetails(inChild.contextId);
        expect(child.flowContext?.state).toBe('CANCELLED');
    }, 180 * SECONDS);

    it('refuses bad input before anything runs', async () => {
        await expect(dbg.start({ flow: FIXTURE, inputs: { nope: 1 } })).rejects.toMatchObject({ code: 'unknown_input' });
        await expect(dbg.start({ flow: FIXTURE, inputs: {} })).rejects.toMatchObject({ code: 'missing_input' });
    }, 60 * SECONDS);
});
