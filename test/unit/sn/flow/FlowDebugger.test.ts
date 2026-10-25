/**
 * FlowDebugger against a fake Workflow Studio debugger.
 *
 * The fake reproduces what the NSE-21 research recorded on a live instance (dev206299,
 * glide-australia patch3): the payload shapes of the captured calls, a command that returns
 * before the step runs, any command name answered with success, breakpoints checked by line
 * only, cancel answering 201 whatever it did, and step into a subflow starting a child context
 * while the parent waits.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { FlowDebugger } from '../../../../src/sn/flow/FlowDebugger';
import { FlowDebugError } from '../../../../src/sn/flow/FlowDebugError';
import { FlowManager } from '../../../../src/sn/flow/FlowManager';
import { SessionManager } from '../../../../src/comm/http/SessionManager';
import { ServiceNowInstance } from '../../../../src/sn/ServiceNowInstance';
import { isPolicyRefusal, policyRefusal } from '../../../../src/policy/PolicyRefusal';

const FLOW = 'bfd1455b53001310b6d61901a0490e0c';
const NESTED = 'b8cb9ed753005310b6d61901a0490e00';
const ACTION = 'aaaa455b53001310b6d61901a0490e0c';
const APP = '921fd9af4c554457a73ad246c71a17f7';
const NOT_DEBUG = '82da5ed336005310f0aa285084663e4f';
// The fixture subflow's elements, as the context snapshot names them.
const UI = { create: 'ea4c2cd0-769f-47b9-9057-b94a79623f60', assign: '3056b449-5317-42ae-9b0c-c0291f966914',
    if: 'd7f7dea6-d069-42c4-8133-46936a71986b', wait: 'cb64044a-3061-4c62-9d66-f58c1adb47d4' };
const SNAP = { create: '6b74cd1353401310b6d61901a0490e8d', assign: '6b74cd1353401310b6d61901a0490e89',
    if: '6774cd1353401310b6d61901a0490e8b', wait: 'a374cd1353401310b6d61901a0490e8f' };

interface Ctx {
    id: string;
    state: string;
    paused: number[];
    debugMode: boolean;
    /** Lines in the order the run reaches them. */
    path: number[];
    at: number;
    allowed: Array<{ flowElementId: string; line: number }>;
    breakpoints: Array<{ flowElementId: string; line: number }>;
    flow: Record<string, unknown>;
    reports: Record<string, unknown>;
    runTime: number;
    /** Reads left before a sent command takes effect. */
    pending?: { command: string; reads: number };
    parent?: string;
    /** Lines at which STEP_INTO starts a child, with the child's lines. */
    subflowAt?: Record<number, number[]>;
    /** A line whose step fails. */
    failAt?: number;
    cancelIgnored?: boolean;
}

let contexts: Map<string, Ctx>;
let calls: Array<{ method: string; path: string; body?: unknown; query?: Record<string, string>; sensitive?: boolean }>;
let platform: { startReply?: Record<string, unknown>; startError?: Error; debugError?: Error; neverPause?: boolean;
    childDelayReads?: number; unverifiedLines?: number[]; dropBreakpointsOnRead?: boolean; flowType?: string; definitionFailure?: string };
let serial = 0;
let now = 0;
let dbg: TestDebugger;

class TestDebugger extends FlowDebugger {
    protected override sleep(ms: number): Promise<void> {
        now += ms;
        return Promise.resolve();
    }
}

const ctxId = () => `${++serial}`.padStart(32, 'c');
const fixtureFlow = (prefix = '') => ({
    id: 'snapshot',
    actionInstances: [
        { id: SNAP.create, uiUniqueIdentifier: prefix + UI.create, order: '1', name: 'Create Task', parent: '' },
        { id: SNAP.wait, uiUniqueIdentifier: prefix + UI.wait, order: '4', name: 'Wait For Condition', parent: UI.if },
    ],
    flowLogicInstances: [
        { id: SNAP.assign, uiUniqueIdentifier: prefix + UI.assign, order: '2', name: 'Assign Subflow Outputs: ', parent: '' },
        { id: SNAP.if, uiUniqueIdentifier: prefix + UI.if, order: '3', name: 'If: Wait for Completion', parent: '' },
    ],
    subFlowInstances: [],
});
const fixtureAllowed = () => [{ flowElementId: UI.assign, line: 4 }, { flowElementId: UI.create, line: 1 },
    { flowElementId: UI.if, line: 6 }, { flowElementId: UI.wait, line: 8 }];
const byLine: Record<number, string> = { 1: SNAP.create, 4: SNAP.assign, 6: SNAP.if, 8: SNAP.wait };

function report(id: string, state: string, error = '', outputs: Record<string, unknown> = {}) {
    return { instanceReference: id, operationsCore: { error, order: '1', startTime: '2026-10-25 16:42:58', runTime: '5', state },
        operationsInput: { data: { task_table: { value: 'incident', displayValue: 'incident', inputUsed: false } } },
        operationsOutput: { data: outputs } };
}

function newContext(path: number[], extra: Partial<Ctx> = {}): Ctx {
    const ctx: Ctx = { id: ctxId(), state: 'PAUSED_IN_DEBUG', paused: [path[0]], debugMode: true, path, at: 0,
        allowed: fixtureAllowed(), breakpoints: [], flow: fixtureFlow(), reports: { [byLine[path[0]] ?? 'x']: report(byLine[path[0]] ?? 'x', 'NOT_READY') },
        runTime: 0, ...extra };
    if (platform.neverPause) { ctx.state = 'IN_PROGRESS'; ctx.paused = []; }
    contexts.set(ctx.id, ctx);
    return ctx;
}

/** Apply a command the way the engine does: on a later read, not when it is sent. */
function settle(ctx: Ctx) {
    if (!ctx.pending) return;
    if (ctx.pending.reads-- > 0) { ctx.state = 'IN_PROGRESS'; return; }
    const { command } = ctx.pending;
    delete ctx.pending;
    ctx.runTime += 300;
    const line = ctx.path[ctx.at];
    if (ctx.failAt === line) {
        ctx.reports[byLine[line]] = report(byLine[line], 'ERROR', 'Nonexistent table: nse21_not_a_table');
        ctx.state = 'ERROR'; ctx.paused = [];
        if (ctx.parent) { const p = contexts.get(ctx.parent)!; p.state = 'ERROR'; }
        return;
    }
    if (command === 'STEP_INTO' && ctx.subflowAt?.[line]) {
        const child = newContext(ctx.subflowAt[line], { parent: ctx.id, flow: fixtureFlow('child-'), allowed: [] });
        child.allowed = ctx.subflowAt[line].map(l => ({ flowElementId: 'child-' + UI.create, line: l }));
        if (platform.childDelayReads) {
            const delay = platform.childDelayReads;
            contexts.delete(child.id);
            (ctx as Ctx & { spawn?: { child: Ctx; reads: number } }).spawn = { child, reads: delay };
        }
        ctx.state = 'WAITING'; ctx.paused = [];
        return;
    }
    ctx.reports[byLine[line] ?? `r${line}`] = report(byLine[line] ?? `r${line}`, 'COMPLETE', 'Success',
        line === 1 ? { Record: { value: { table: 'incident' }, displayValue: 'e5a4015353401310b6d61901a0490e64' } } : {});
    let next = ctx.at + 1;
    if (command === 'RESUME') {
        while (next < ctx.path.length && !ctx.breakpoints.some(b => b.line === ctx.path[next])) next++;
    }
    if (command === 'SKIP_ALL' || command === 'STEP_OUT' || !['STEP_OVER', 'STEP_INTO', 'RESUME'].includes(command)) next = ctx.path.length;
    if (next >= ctx.path.length) {
        ctx.state = 'COMPLETE'; ctx.paused = [];
        if (ctx.parent) { const p = contexts.get(ctx.parent)!; p.state = 'COMPLETE'; }
        return;
    }
    ctx.at = next;
    ctx.state = 'PAUSED_IN_DEBUG';
    ctx.paused = [ctx.path[next]];
    ctx.reports[byLine[ctx.path[next]] ?? `r${ctx.path[next]}`] = report(byLine[ctx.path[next]] ?? `r${ctx.path[next]}`, 'NOT_READY');
}

const http = (status: number, body: unknown) => new Error(`Error during request. Status: ${status} Body: ${JSON.stringify(body)}`);
const debugReply = (command: string, body: unknown) => ({ bodyObject: { result: { success: true, command, message: '', body, type: 'response', request_seq: 0 } } });

function contextRead(id: string) {
    const ctx = contexts.get(id);
    if (!ctx) throw http(404, { error: { message: 'Flow context does not exist. It may have been cleaned.', detail: `id: ${id}` }, status: 'failure' });
    settle(ctx);
    const spawn = (ctx as Ctx & { spawn?: { child: Ctx; reads: number } }).spawn;
    if (spawn && spawn.reads-- <= 0) { contexts.set(spawn.child.id, spawn.child); delete (ctx as { spawn?: unknown }).spawn; }
    return { bodyObject: { result: {
        flowContext: { name: 'NSE21 Debug Copy - Create Task', state: ctx.state, debugMode: ctx.debugMode, pausedInDebugLocations: ctx.paused,
            isTestRun: true, runTime: String(ctx.runTime), executionSource: { callingSource: ctx.parent ? 'DYNAMIC_FLOW' : 'DEBUG_BUTTON' } },
        flowReport: { operationsCore: { state: ctx.state === 'ERROR' ? 'ERROR' : 'NOT_READY', error: '' },
            operationsInput: { data: { table: { value: 'incident', displayValue: 'incident', inputUsed: false } } },
            operationsOutput: { data: {} }, actionOperationsReports: ctx.reports, subflowOperationsReports: {}, iterationOperationsReports: {} },
        flow: ctx.flow,
    } } };
}

function table(path: string, query: Record<string, string>) {
    const name = path.split('/').at(-1);
    const q = query.sysparm_query;
    if (name === 'sys_hub_flow') {
        return { bodyObject: { result: q === 'sys_scope.scope=x_2115789_flowdbg^internal_name=nse21_debug_copy__create_task' ? [{ sys_id: FLOW }] : [] } };
    }
    if (name === 'sys_hub_action_type_definition') return { bodyObject: { result: q === `sys_id=${ACTION}` ? [{ sys_id: ACTION }] : [] } };
    if (name === 'sys_flow_context') {
        const parent = /source_record=([a-f0-9]{32})/.exec(q)?.[1];
        if (parent) {
            const kids = [...contexts.values()].filter(c => c.parent === parent && ['PAUSED_IN_DEBUG', 'WAITING', 'IN_PROGRESS', 'QUEUED'].includes(c.state));
            return { bodyObject: { result: kids.map(c => ({ sys_id: c.id })) } };
        }
        const open = [...contexts.values()].filter(c => !c.parent && ['PAUSED_IN_DEBUG', 'WAITING', 'IN_PROGRESS', 'QUEUED'].includes(c.state));
        return { bodyObject: { result: open.map(c => ({ sys_id: c.id, name: 'NSE21 Debug Copy - Create Task', flow: FLOW, state: c.state,
            sys_created_by: 'admin', sys_created_on: '2026-10-25 23:00:09' })) } };
    }
    return { bodyObject: { result: [] } };
}

function processflow(method: string, path: string, body: unknown) {
    const rest = path.replace('/api/now/processflow/', '');
    let m: RegExpExecArray | null;
    if (method === 'post' && rest === 'debug/start/flow-object') {
        if (platform.startError) throw platform.startError;
        if (platform.startReply) return { bodyObject: { result: platform.startReply } };
        const outputMap = (body as { outputMap: Record<string, unknown> }).outputMap;
        const ctx = outputMap.update_set_ids !== undefined
            ? newContext([5, 8, 17], { subflowAt: { 8: [3, 6] } })
            : newContext([1, 4, 6], { failAt: outputMap.table === 'nse21_not_a_table' ? 1 : undefined });
        return debugReply('launch', ctx.id);
    }
    if (platform.debugError && rest.startsWith('debug/')) throw platform.debugError;
    if ((m = /^debug\/allowed-breakpoints\/(\w+)$/.exec(rest))) {
        const ctx = contexts.get(m[1]);
        if (!ctx) throw http(500, { result: { success: false, command: 'breakpointLocations', message: `invalid sys_id id = ${m[1]}` } });
        return debugReply('breakpointLocations', ctx.allowed);
    }
    if ((m = /^debug\/breakpoints\/(\w+)$/.exec(rest))) {
        const ctx = contexts.get(m[1])!;
        if (method === 'post') {
            ctx.breakpoints = body as Ctx['breakpoints'];
            return debugReply('setBreakpoints', ctx.breakpoints.map(b => ({ id: b.line, line: b.line, flowElementId: b.flowElementId,
                verified: !platform.unverifiedLines?.includes(b.line),
                ...(platform.unverifiedLines?.includes(b.line) ? { message: 'Flow Engine cannot debug this instruction id' } : {}) })));
        }
        const held = platform.dropBreakpointsOnRead ? [] : ctx.breakpoints;
        return debugReply('getBreakpoints', held.map(b => ({ id: b.line, verified: true, line: b.line, flowElementId: b.flowElementId })));
    }
    if ((m = /^debug\/command\/(\w+)\/(\w+)$/.exec(rest))) {
        const ctx = contexts.get(m[1])!;
        if (ctx.state !== 'PAUSED_IN_DEBUG') {
            throw http(500, { result: { success: false, command: m[2], message: `Cannot perform debug command on the context '${ctx.id}' because it is not in 'PAUSED IN DEBUG' state.` } });
        }
        ctx.pending = { command: m[2], reads: 1 };
        return { bodyObject: { result: { success: true, command: m[2], type: 'response', request_seq: 0 } } };
    }
    if ((m = /^operations\/flow\/context\/(\w+)\/cancel$/.exec(rest))) {
        const ctx = contexts.get(m[1]);
        if (ctx && !ctx.cancelIgnored && !['COMPLETE', 'ERROR', 'CANCELLED'].includes(ctx.state)) {
            ctx.state = 'CANCELLED'; ctx.paused = []; delete ctx.pending;
            for (const child of contexts.values()) if (child.parent === ctx.id) child.state = 'CANCELLED';
        }
        return { status: 201, bodyObject: { result: 'cancelled flow' } };
    }
    if ((m = /^operations\/flow\/context\/(\w+)$/.exec(rest))) return contextRead(m[1]);
    throw http(400, { error: { message: 'Requested URI does not represent any resource', detail: null }, status: 'failure' });
}

async function handle(method: string, r: { path: string; query?: Record<string, string>; json?: unknown; sensitive?: boolean }) {
    calls.push({ method, path: r.path, body: r.json, query: r.query, sensitive: r.sensitive });
    if (r.path.startsWith('/api/now/table/')) return table(r.path, r.query ?? {});
    return processflow(method, r.path, r.json);
}

const inputs = { table: 'incident', field_values: 'short_description=NSE-21 unit', wait: false };
const posts = (fragment: string) => calls.filter(c => c.method === 'post' && c.path.includes(fragment));

beforeEach(() => {
    contexts = new Map();
    calls = [];
    platform = {};
    serial = 0;
    now = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    jest.spyOn(SessionManager.getInstance(), 'getRequest').mockReturnValue({
        get: jest.fn((r: any) => handle('get', r)),
        post: jest.fn((r: any) => handle('post', r)),
    } as any);
    jest.spyOn(FlowManager.prototype, 'getFlowArtifactDefinition').mockImplementation(async (sysId: string) => {
        if (platform.definitionFailure) return { success: false, sysId, failureReason: platform.definitionFailure as any };
        if (sysId !== FLOW && sysId !== NESTED) return { success: false, sysId, failureReason: 'not_found' };
        const definition = sysId === FLOW
            ? { id: FLOW, name: 'NSE21 Debug Copy - Create Task', type: 'subflow', scope: APP, scopeName: 'x_2115789_flowdbg',
                inputs: [{ name: 'table', type: 'table_name', mandatory: true, children: [] },
                    { name: 'field_values', type: 'template_value', mandatory: false, children: [] },
                    { name: 'wait', type: 'boolean', mandatory: false, children: [] }] }
            : { id: NESTED, name: 'NSE21 Debug Nested', type: 'subflow', scope: APP, scopeName: 'x_2115789_flowdbg',
                inputs: [{ name: 'update_set_ids', type: 'array.string', mandatory: true, children: [{ name: 'FD3ccb9ed73a0053102dd240bc2f9df328', type: 'array.string' }] }] };
        const type = platform.flowType ?? 'subflow';
        return { success: true, sysId, artifactType: type === 'flow' || type === 'subflow' ? type : undefined, reportedType: type, definition } as any;
    });
    dbg = new TestDebugger(new ServiceNowInstance({ alias: 'dev', host: 'dev.service-now.com' }));
});

afterEach(() => jest.restoreAllMocks());

describe('start', () => {
    it('resolves a scoped name, sends the draft and the inputs, and returns the first pause', async () => {
        const session = await dbg.start({ flow: 'x_2115789_flowdbg.nse21_debug_copy__create_task', inputs });
        const start = posts('debug/start/flow-object')[0];
        expect(start.sensitive).toBe(true);
        expect(start.query).toEqual({ sysparm_transaction_scope: APP });
        expect(start.body).toMatchObject({ flow: { id: FLOW, deletedActions: [], deletedTriggers: [] }, outputMap: inputs, runOnThread: true, tracingEnabled: true });
        expect(session.flow).toEqual({ sysId: FLOW, name: 'NSE21 Debug Copy - Create Task', type: 'subflow', scope: 'x_2115789_flowdbg' });
        expect(session.snapshot).toMatchObject({ state: 'PAUSED', rawState: 'PAUSED_IN_DEBUG', pausedLines: [1], chain: [session.contextId] });
        expect(session.snapshot.pausedAt?.step).toMatchObject({ number: 1, label: 'Create Task', kind: 'action', snapshotInstanceId: SNAP.create });
    });

    it('maps the debugger lines to Workflow Studio step numbers', async () => {
        const session = await dbg.start({ flow: FLOW, inputs });
        expect(session.locations.map(l => [l.line, l.step?.number, l.step?.label, l.step?.kind])).toEqual([
            [1, 1, 'Create Task', 'action'],
            [4, 2, 'Assign Subflow Outputs', 'flowLogic'],
            [6, 3, 'If: Wait for Completion', 'flowLogic'],
            [8, 4, 'Wait For Condition', 'action'],
        ]);
        expect(session.locations[3].step?.parent).toBe(UI.if);
    });

    it('sets the requested breakpoints once the run has paused', async () => {
        const session = await dbg.start({ flow: FLOW, inputs, breakpoints: [3] });
        expect(posts('debug/breakpoints/')[0].body).toEqual([{ flowElementId: UI.if, line: 6 }]);
        expect(session.breakpoints).toEqual([expect.objectContaining({ line: 6, verified: true, step: expect.objectContaining({ number: 3 }) })]);
    });

    it.each([
        [{ nope: 1, ...inputs }, 'unknown_input', ['nope']],
        [{ field_values: 'x' }, 'missing_input', ['table']],
        [{ table: null }, 'missing_input', ['table']],
    ])('refuses bad inputs before anything is sent: %j', async (given, code, names) => {
        await expect(dbg.start({ flow: FLOW, inputs: given as Record<string, unknown> })).rejects.toMatchObject({ code, detail: { inputs: names } });
        expect(posts('debug/start')).toHaveLength(0);
    });

    it('sends an array input in the shape Workflow Studio uses', async () => {
        await dbg.start({ flow: NESTED, inputs: { update_set_ids: ['a', 'b'] } });
        expect((posts('debug/start')[0].body as { outputMap: unknown }).outputMap).toEqual({
            update_set_ids: { children: [{ name: 'FD3ccb9ed73a0053102dd240bc2f9df328', value: 'a' }, { name: 'FD3ccb9ed73a0053102dd240bc2f9df328', value: 'b' }] },
        });
    });

    it('passes a flow trigger map through without checking names', async () => {
        platform.flowType = 'flow';
        await dbg.start({ flow: FLOW, inputs: { current: 'e5a4015353401310b6d61901a0490e64', table_name: 'incident' } });
        expect((posts('debug/start')[0].body as { outputMap: unknown }).outputMap).toEqual({ current: 'e5a4015353401310b6d61901a0490e64', table_name: 'incident' });
    });

    it.each([
        ['not hex', 'nope', 'invalid_input'],
        ['an unknown scoped name', 'x_2115789_flowdbg.nothing', 'flow_not_found'],
        ['an unknown sys_id', '0123456789abcdef0123456789abcdef', 'flow_not_found'],
        ['an action', ACTION, 'not_debuggable'],
    ])('refuses %s', async (_label, flow, code) => {
        await expect(dbg.start({ flow, inputs })).rejects.toMatchObject({ code });
        expect(posts('debug/start')).toHaveLength(0);
    });

    it('refuses a definition it cannot read', async () => {
        platform.definitionFailure = 'permission_denied';
        await expect(dbg.start({ flow: FLOW, inputs })).rejects.toMatchObject({ code: 'permission_denied' });
    });

    it.each([
        [{ success: false, command: 'launch', message: 'no', body: '' }],
        [{ success: true, command: 'launch', message: '', body: 'not-a-sys-id' }],
        [{ success: true, command: 'other', message: '', body: 'c'.repeat(32) }],
    ])('reports start_failed for a launch reply it cannot trust: %j', async (reply) => {
        platform.startReply = reply;
        await expect(dbg.start({ flow: FLOW, inputs })).rejects.toMatchObject({ code: 'start_failed' });
    });

    it('reports an instance without the debugger as release_unsupported', async () => {
        platform.startError = http(400, { error: { message: 'Requested URI does not represent any resource' } });
        await expect(dbg.start({ flow: FLOW, inputs })).rejects.toMatchObject({ code: 'release_unsupported', detail: { status: 400 } });
    });

    it('lets a policy refusal through untouched', async () => {
        const refusal = policyRefusal({ allowed: false, verbs: ['execute', 'write'], decidingLayer: 'deny-execute' } as any);
        platform.startError = refusal;
        await expect(dbg.start({ flow: FLOW, inputs })).rejects.toBe(refusal);
    });

    it('cancels the run again when setting it up fails after it started', async () => {
        await expect(dbg.start({ flow: FLOW, inputs, breakpoints: [9] })).rejects.toMatchObject({
            code: 'unknown_breakpoint', detail: { cancelled: true, validSteps: [1, 2, 3, 4] } });
        expect(posts('/cancel')).toHaveLength(1);
        expect([...contexts.values()][0].state).toBe('CANCELLED');
    });

    it('returns a run that ended before it paused, as it ended', async () => {
        platform.startReply = undefined;
        const session = await dbg.start({ flow: FLOW, inputs: { ...inputs, table: 'nse21_not_a_table' } });
        const failed = await dbg.stepOver(session.contextId);
        expect(failed).toMatchObject({ state: 'ERROR', error: 'Nonexistent table: nse21_not_a_table' });
    });

    it('reports a run that never pauses as still running when the wait times out', async () => {
        platform.neverPause = true;
        const session = await dbg.start({ flow: FLOW, inputs, timeoutMs: 5000 });
        expect(session.snapshot).toMatchObject({ state: 'RUNNING', timedOut: true });
    });
});

describe('commands', () => {
    it('steps from step to step, waiting out the moment the step is still running', async () => {
        const { contextId } = await dbg.start({ flow: FLOW, inputs });
        const second = await dbg.stepOver(contextId);
        expect(second).toMatchObject({ state: 'PAUSED', pausedLines: [4] });
        expect(second.pausedAt?.step?.number).toBe(2);
        const record = second.steps.find(s => s.step?.number === 1);
        expect(record).toMatchObject({ state: 'COMPLETE', error: 'Success', outputs: { Record: { displayValue: 'e5a4015353401310b6d61901a0490e64' } } });
        expect((await dbg.stepInto(contextId)).pausedLines).toEqual([6]);
        expect((await dbg.stepOver(contextId)).state).toBe('COMPLETE');
    });

    it('resumes to the next breakpoint, and skip all runs to the end', async () => {
        const { contextId } = await dbg.start({ flow: FLOW, inputs, breakpoints: [3] });
        expect((await dbg.resume(contextId)).pausedAt?.step?.number).toBe(3);
        expect((await dbg.skipAll(contextId)).state).toBe('COMPLETE');
    });

    it.each(['JUMP', 'step_over', '', 'RESUME '])('never sends a command name outside the five: %j', async (name) => {
        const { contextId } = await dbg.start({ flow: FLOW, inputs });
        await expect(dbg.command(contextId, name as any)).rejects.toMatchObject({ code: 'invalid_input' });
        expect(posts('debug/command')).toHaveLength(0);
    });

    it('refuses a command when the run is not paused, without sending it', async () => {
        const { contextId } = await dbg.start({ flow: FLOW, inputs });
        await dbg.skipAll(contextId);
        await expect(dbg.stepOver(contextId)).rejects.toMatchObject({ code: 'not_paused', detail: { state: 'COMPLETE' } });
        expect(posts('debug/command')).toHaveLength(1);
    });

    it('refuses a context that was not started by the debugger', async () => {
        contexts.set(NOT_DEBUG, { ...newContext([1]), id: NOT_DEBUG, debugMode: false });
        await expect(dbg.stepOver(NOT_DEBUG)).rejects.toMatchObject({ code: 'not_a_debug_session' });
    });

    it('translates the debugger’s own refusal when the run moved on between read and send', async () => {
        const { contextId } = await dbg.start({ flow: FLOW, inputs });
        platform.debugError = http(500, { result: { success: false, command: 'STEP_OVER',
            message: `Cannot perform debug command on the context '${contextId}' because it is not in 'PAUSED IN DEBUG' state.` } });
        await expect(dbg.stepOver(contextId)).rejects.toMatchObject({ code: 'not_paused', detail: { status: 500 } });
    });

    it('reports an unknown context as context_not_found', async () => {
        await expect(dbg.inspect('0123456789abcdef0123456789abcdef')).rejects.toMatchObject({ code: 'context_not_found', detail: { status: 404 } });
    });

    it.each(['', 'nope', 'ABC', null])('refuses a malformed context id: %j', async (id) => {
        await expect(dbg.inspect(id as any)).rejects.toMatchObject({ code: 'invalid_input' });
        expect(calls).toHaveLength(0);
    });
});

describe('breakpoints', () => {
    it('replaces the set with pairs taken from the debugger’s own list, and reads it back', async () => {
        const { contextId } = await dbg.start({ flow: FLOW, inputs });
        const set = await dbg.setBreakpoints(contextId, [2, { line: 8 }, { flowElementId: UI.if }, 2]);
        expect(posts('debug/breakpoints/').at(-1)!.body).toEqual([
            { flowElementId: UI.assign, line: 4 }, { flowElementId: UI.wait, line: 8 }, { flowElementId: UI.if, line: 6 }]);
        expect(set.map(b => b.step?.number)).toEqual([2, 3, 4]);
        await dbg.clearBreakpoints(contextId);
        expect(posts('debug/breakpoints/').at(-1)!.body).toEqual([]);
        expect(await dbg.getBreakpoints(contextId)).toEqual([]);
    });

    it('refuses a step the run cannot stop at, listing the ones it can', async () => {
        const { contextId } = await dbg.start({ flow: FLOW, inputs });
        await expect(dbg.setBreakpoints(contextId, [7])).rejects.toMatchObject({ code: 'unknown_breakpoint', detail: { validSteps: [1, 2, 3, 4] } });
        await expect(dbg.setBreakpoints(contextId, [{ flowElementId: 'nope' }])).rejects.toMatchObject({ code: 'unknown_breakpoint' });
        expect(posts('debug/breakpoints/')).toHaveLength(0);
    });

    it('reports a breakpoint the debugger did not verify', async () => {
        const { contextId } = await dbg.start({ flow: FLOW, inputs });
        platform.unverifiedLines = [6];
        await expect(dbg.setBreakpoints(contextId, [3])).rejects.toMatchObject({ code: 'breakpoint_not_verified',
            detail: { serverMessage: 'Flow Engine cannot debug this instruction id' } });
    });

    it('notices when the read-back does not match', async () => {
        const { contextId } = await dbg.start({ flow: FLOW, inputs });
        platform.dropBreakpointsOnRead = true;
        await expect(dbg.setBreakpoints(contextId, [3])).rejects.toMatchObject({ code: 'unexpected_response' });
    });

    it.each([[[0]], [[1.5]], [['2']], [[{ line: -1 }]], [[{ flowElementId: 'a b' }]], ['3']])('refuses a malformed step reference: %j', async (refs) => {
        await expect(dbg.setBreakpoints('c'.repeat(32), refs as any)).rejects.toMatchObject({ code: 'invalid_input' });
    });

    it('refuses to change breakpoints on a run that ended', async () => {
        const { contextId } = await dbg.start({ flow: FLOW, inputs });
        await dbg.skipAll(contextId);
        await expect(dbg.setBreakpoints(contextId, [3])).rejects.toMatchObject({ code: 'not_paused' });
    });
});

describe('step into a subflow', () => {
    it('follows the run into the child context, and sends the next command there', async () => {
        const { contextId } = await dbg.start({ flow: NESTED, inputs: { update_set_ids: ['a'] } });
        expect((await dbg.stepInto(contextId)).pausedLines).toEqual([8]);
        const inChild = await dbg.stepInto(contextId);
        expect(inChild).toMatchObject({ state: 'PAUSED', pausedLines: [3], rootContextId: contextId });
        expect(inChild.chain).toHaveLength(2);
        expect(inChild.contextId).toBe(inChild.chain[1]);
        await dbg.stepOver(contextId);
        expect(posts('debug/command').at(-1)!.path).toContain(`/command/${inChild.contextId}/STEP_OVER`);
    });

    it('waits for the child context to appear rather than reporting the parent as waiting', async () => {
        platform.childDelayReads = 3;
        const { contextId } = await dbg.start({ flow: NESTED, inputs: { update_set_ids: ['a'] } });
        await dbg.stepInto(contextId);
        const inChild = await dbg.stepInto(contextId);
        expect(inChild).toMatchObject({ state: 'PAUSED', pausedLines: [3] });
        expect(inChild.chain).toHaveLength(2);
    });

    it('cancelling the root ends the child too', async () => {
        const { contextId } = await dbg.start({ flow: NESTED, inputs: { update_set_ids: ['a'] } });
        await dbg.stepInto(contextId);
        const inChild = await dbg.stepInto(contextId);
        const result = await dbg.cancel(contextId);
        expect(result).toMatchObject({ before: 'WAITING', after: 'CANCELLED', cancelled: true });
        expect(contexts.get(inChild.contextId)!.state).toBe('CANCELLED');
    });
});

describe('cancel', () => {
    it('cancels a paused run and reads it back', async () => {
        const { contextId } = await dbg.start({ flow: FLOW, inputs });
        expect(await dbg.cancel(contextId)).toEqual({ contextId, before: 'PAUSED_IN_DEBUG', after: 'CANCELLED', cancelled: true, alreadyEnded: false });
    });

    it('is safe to repeat, and sends nothing for a run that has ended', async () => {
        const { contextId } = await dbg.start({ flow: FLOW, inputs });
        await dbg.cancel(contextId);
        expect(await dbg.cancel(contextId)).toMatchObject({ alreadyEnded: true, cancelled: false, after: 'CANCELLED' });
        expect(posts('/cancel')).toHaveLength(1);
    });

    it('never cancels a flow run the debugger did not start', async () => {
        contexts.set(NOT_DEBUG, { ...newContext([1]), id: NOT_DEBUG, debugMode: false });
        await expect(dbg.cancel(NOT_DEBUG)).rejects.toMatchObject({ code: 'not_a_debug_session' });
        expect(posts('/cancel')).toHaveLength(0);
    });

    it('does not trust the 201: a run that stays open is cancel_failed', async () => {
        const { contextId } = await dbg.start({ flow: FLOW, inputs });
        contexts.get(contextId)!.cancelIgnored = true;
        await expect(dbg.cancel(contextId)).rejects.toMatchObject({ code: 'cancel_failed', detail: { state: 'PAUSED_IN_DEBUG' } });
        expect(posts('/cancel').length).toBeGreaterThanOrEqual(2);
    });
});

describe('runTo and withSession', () => {
    it('runs to the breakpoint, reports the run there, and cancels it', async () => {
        const result = await dbg.runTo({ flow: FLOW, inputs, breakpoints: [3] });
        expect(result.snapshot.pausedAt?.step?.number).toBe(3);
        expect(result.cancel).toMatchObject({ cancelled: true });
        expect(contexts.get(result.session.contextId)!.state).toBe('CANCELLED');
    });

    it('does not resume past a breakpoint on the first step', async () => {
        const result = await dbg.runTo({ flow: FLOW, inputs, breakpoints: [1], then: 'stay' });
        expect(result.snapshot.pausedLines).toEqual([1]);
        expect(posts('debug/command')).toHaveLength(0);
        expect(contexts.get(result.session.contextId)!.state).toBe('PAUSED_IN_DEBUG');
    });

    it('can let the run finish instead', async () => {
        const result = await dbg.runTo({ flow: FLOW, inputs, breakpoints: [2], then: 'resume' });
        expect(result.final?.state).toBe('COMPLETE');
        expect(result.cancel).toBeUndefined();
    });

    it.each([[{ breakpoints: [] }], [{ breakpoints: [3], then: 'later' }]])('refuses %j', async (extra) => {
        await expect(dbg.runTo({ flow: FLOW, inputs, ...extra } as any)).rejects.toMatchObject({ code: 'invalid_input' });
    });

    it('withSession cancels when the work throws, and rethrows its error', async () => {
        const boom = new Error('boom');
        let id = '';
        await expect(dbg.withSession({ flow: FLOW, inputs }, async (s) => { id = s.contextId; throw boom; })).rejects.toBe(boom);
        expect(contexts.get(id)!.state).toBe('CANCELLED');
    });

    it('withSession cancels after the work too', async () => {
        const id = await dbg.withSession({ flow: FLOW, inputs }, async (s) => s.contextId);
        expect(contexts.get(id)!.state).toBe('CANCELLED');
    });
});

describe('listSessions', () => {
    it('lists open root debug runs', async () => {
        const { contextId } = await dbg.start({ flow: FLOW, inputs });
        const listed = await dbg.listSessions({ createdBy: 'admin' });
        expect(listed).toEqual([expect.objectContaining({ contextId, state: 'PAUSED_IN_DEBUG', flowSysId: FLOW })]);
        const query = calls.find(c => c.path === '/api/now/table/sys_flow_context' && !c.query?.sysparm_query.includes('source_record'))!.query!.sysparm_query;
        expect(query).toBe('calling_source=DEBUG_BUTTON^stateINPAUSED_IN_DEBUG,WAITING,IN_PROGRESS,QUEUED^sys_created_by=admin^ORDERBYDESCsys_created_on');
    });

    it.each([[{ createdBy: 'a^b' }], [{ limit: 0 }], [{ limit: 1.5 }]])('refuses %j', async (opts) => {
        await expect(dbg.listSessions(opts)).rejects.toMatchObject({ code: 'invalid_input' });
    });
});

describe('FlowDebugError', () => {
    it('keeps only safe detail', () => {
        const error = new FlowDebugError('unknown_input', { inputs: ['ok', 'bad name;'], contextId: 'nope', state: 'not a state', status: 500 });
        expect(error.detail).toEqual({ inputs: ['ok'], status: 500 });
        expect(error.message).toBe('Flow debugger: unknown_input');
        expect(isPolicyRefusal(error)).toBe(false);
    });
});
