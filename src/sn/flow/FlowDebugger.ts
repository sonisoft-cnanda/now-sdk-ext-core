import { SessionManager } from '../../comm/http/SessionManager';
import type { HTTPRequest } from '../../comm/http/HTTPRequest';
import type { ServiceNowRequest } from '../../comm/http/ServiceNowRequest';
import { PROCESSFLOW_API_BASE } from '../../constants/ServiceNow';
import { checkRequirement } from '../../policy/Policy';
import { isPolicyRefusal, policyRefusal } from '../../policy/PolicyRefusal';
import { Logger } from '../../util/Logger';
import type { ServiceNowInstance } from '../ServiceNowInstance';
import { FlowDebugError } from './FlowDebugError';
import type {
    FlowDebugBreakpoint, FlowDebugCancelResult, FlowDebugCommand, FlowDebugListOptions, FlowDebugLocation,
    FlowDebugRunToOptions, FlowDebugRunToResult, FlowDebugSession, FlowDebugSessionSummary, FlowDebugSnapshot,
    FlowDebugStartOptions, FlowDebugState, FlowDebugStepData, FlowDebugStepInfo, FlowDebugStepKind, FlowDebugStepRef,
    FlowDebugValue, FlowDebugWaitOptions,
} from './FlowDebugModels';
import { FlowManager } from './FlowManager';

const ID = /^[a-f0-9]{32}$/;
const SCOPED_NAME = /^([a-z0-9_]{1,100})\.([a-z0-9_]{1,200})$/i;
const USER_NAME = /^[a-z0-9_.@+-]{1,100}$/i;
/** An inner step of a custom action: `<step sys_id>-<action uiUniqueIdentifier>`. */
const ACTION_STEP = /^([a-f0-9]{32})-(.+)$/;
const COMMANDS: readonly FlowDebugCommand[] = ['STEP_INTO', 'STEP_OVER', 'STEP_OUT', 'RESUME', 'SKIP_ALL'];
const ENDED = new Set(['COMPLETE', 'CANCELLED', 'ERROR']);
const EXECUTING = new Set(['IN_PROGRESS', 'QUEUED', 'STARTING', 'RUNNING']);
/** Contexts a debug run can still be holding open. */
const OPEN = ['PAUSED_IN_DEBUG', 'WAITING', 'IN_PROGRESS', 'QUEUED', 'STARTING', 'RUNNING'];
const GLOBAL = { sysparm_transaction_scope: 'global' };
const HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };
const DEFAULT_TIMEOUT_MS = 60_000;
/** How deep a chain of step-into subflows is followed. */
const MAX_DEPTH = 10;

type Raw = Record<string, unknown>;

interface ContextRead {
    contextId: string;
    raw: Raw;
    flowContext: Raw;
    report: Raw;
    state: string;
}

interface Observation {
    snapshot: FlowDebugSnapshot;
    /** Changes whenever the run moves, including a loop pausing at the same line again. */
    fingerprint: string;
    debugMode: boolean;
}

const obj = (value: unknown): Raw => (value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
};

/**
 * Drives the Workflow Studio flow debugger (**Test ▸ Debug**) over REST.
 *
 * A debug run executes the flow or subflow for real, so its actions create and change records,
 * and it holds a flow context open while paused. Every run must be ended: by running it to the
 * end, or with {@link cancel}. {@link withSession}, and {@link runTo} by default, cancel the run
 * for you; `runTo` with `after: 'resume'` or `'stay'` leaves it running or paused.
 *
 * The APIs are Workflow Studio's own (`/api/now/processflow/debug/…`), not a published REST
 * contract. They work with the ordinary OAuth credential; no UI session is needed.
 *
 * Starting a run and sending a step command need execute permission under an installed policy;
 * breakpoint changes and cancel need write, so a run stays cancellable under `--deny-execute`.
 *
 * Every method takes the **root** context id that {@link start} returns. When step into enters a
 * subflow, the subflow runs in a child context of its own; commands, breakpoints and snapshots
 * then apply to that child, and the snapshot's `chain` shows the path to it.
 */
export class FlowDebugger {
    private readonly _logger = new Logger('FlowDebugger');
    private readonly _request: ServiceNowRequest;
    private readonly _flows: FlowManager;
    /** allowed-breakpoints never changes for a context, so it is read once. */
    private readonly _allowed = new Map<string, Array<{ flowElementId: string; line: number }>>();
    /**
     * Poll schedule while waiting for a run to settle. `waitingSettleMs`: right after step into a
     * subflow the parent is WAITING before its child context exists, so WAITING only counts as
     * settled once it has lasted this long.
     */
    protected _poll = { firstMs: 300, maxMs: 2000, factor: 1.5, waitingSettleMs: 5000 };

    public constructor(instance: ServiceNowInstance) {
        this._request = SessionManager.getInstance().getRequest(instance);
        this._flows = new FlowManager(instance);
    }

    /**
     * Start a debug run and wait for it to first pause.
     *
     * The flow's current draft is what runs, as in Workflow Studio. Inputs are checked against a
     * subflow's declared inputs before anything is sent. If the run cannot be set up after it
     * started, it is cancelled again before the error is thrown, and the error carries its
     * `contextId` and whether the cancel worked.
     *
     * Under an installed policy, a run is only started when a cancel would also be permitted:
     * starting needs execute, and breakpoints and cancel need write.
     *
     * A run normally pauses before its first step. One that fails or finishes first is returned
     * as it ended; check `snapshot.state`.
     */
    public async start(options: FlowDebugStartOptions): Promise<FlowDebugSession> {
        const opts = obj(options) as unknown as FlowDebugStartOptions;
        const timeoutMs = this.timeout(opts.timeoutMs);
        if (opts.inputs !== undefined && (typeof opts.inputs !== 'object' || opts.inputs === null || Array.isArray(opts.inputs))) {
            throw new FlowDebugError('invalid_input');
        }
        const breakpointRefs = opts.breakpoints === undefined ? [] : this.refs(opts.breakpoints);
        const sysId = await this.resolveFlow(opts.flow);
        const { definition, type } = await this.definition(sysId);
        const outputMap = this.outputMap(definition, type, opts.inputs ?? {});
        const scope = str(definition.scope);
        // Never start a run this session could not cancel again.
        const permitted = checkRequirement({ verbs: ['execute', 'write'], target: 'instance' });
        if (!permitted.allowed) throw policyRefusal(permitted);

        let response: Raw;
        try {
            response = await this.call('post', 'debug/start/flow-object', {
                flow: { ...definition, deletedActions: [], deletedTriggers: [] },
                outputMap,
                runOnThread: true,
                tracingEnabled: true,
            }, { query: { sysparm_transaction_scope: ID.test(scope) ? scope : 'global' }, sensitive: true });
        } catch (error) {
            throw await this.startFailure(error);
        }
        const result = obj(response.result);
        const contextId = str(result.body);
        if (result.success !== true || result.command !== 'launch' || !ID.test(contextId)) {
            throw new FlowDebugError('start_failed', { serverMessage: str(result.message) });
        }
        this._logger.info('Flow debug run started', { flow: sysId, contextId });

        try {
            const first = await this.waitFor(contextId, null, timeoutMs);
            const locations = await this.locationsOf(contextId);
            let breakpoints: FlowDebugBreakpoint[] = [];
            if (breakpointRefs.length && first.snapshot.state === 'PAUSED') {
                breakpoints = await this.setBreakpoints(contextId, breakpointRefs);
            }
            return {
                contextId,
                flow: { sysId, name: str(definition.name), type, scope: str(definition.scopeName) || scope },
                locations,
                breakpoints,
                snapshot: first.snapshot,
            };
        } catch (error) {
            // Whatever failed, the caller gets the context id and whether the run was ended.
            const cancelled = await this.cancel(contextId).then(r => r.cancelled || r.alreadyEnded, () => false);
            const code = error instanceof FlowDebugError ? error.code : 'start_failed';
            const detail = error instanceof FlowDebugError ? error.detail : undefined;
            throw new FlowDebugError(code, { ...detail, contextId, cancelled }, error instanceof FlowDebugError ? undefined : error);
        }
    }

    /**
     * Classify a failed start call. Its request is marked sensitive, so only the status survives;
     * a 400 or 404 is checked against a harmless debugger read to tell an instance without the
     * debugger from a start it refused.
     */
    private async startFailure(error: unknown): Promise<unknown> {
        const translated = this.translate(error, undefined, 'start_failed');
        if (!(translated instanceof FlowDebugError) || translated.code !== 'context_not_found' && translated.detail?.status !== 400) {
            return translated;
        }
        const status = translated.detail?.status;
        try {
            await this.call('get', `debug/allowed-breakpoints/${'0'.repeat(32)}`);
        } catch (probe) {
            const answer = this.translate(probe, undefined, 'unexpected_response');
            if (answer instanceof FlowDebugError && answer.code === 'release_unsupported') return new FlowDebugError('release_unsupported', { status });
        }
        return new FlowDebugError('start_failed', { status });
    }

    /** The run as it is now, without moving it. */
    public async inspect(contextId: string): Promise<FlowDebugSnapshot> {
        return (await this.observe(this.id(contextId))).snapshot;
    }

    /** Where the active context (the root, or the child subflow it is paused in) can stop. */
    public async locations(contextId: string): Promise<FlowDebugLocation[]> {
        const observed = await this.observe(this.id(contextId));
        return this.locationsOf(observed.snapshot.contextId);
    }

    /** Breakpoints the active context holds. */
    public async getBreakpoints(contextId: string): Promise<FlowDebugBreakpoint[]> {
        const observed = await this.observe(this.id(contextId));
        return this.readBreakpoints(observed.snapshot.contextId);
    }

    /**
     * Replace the active context's breakpoints with these steps, and read them back.
     *
     * Steps are resolved against the debugger's own list of locations, never sent as given: the
     * debugger accepts any element id on a valid line, so a guessed pair would be "verified" and
     * stop somewhere else.
     */
    public async setBreakpoints(contextId: string, steps: FlowDebugStepRef[]): Promise<FlowDebugBreakpoint[]> {
        const refs = this.refs(steps);
        const observed = await this.observe(this.id(contextId));
        this.requireOpen(observed);
        const target = observed.snapshot.contextId;
        const locations = await this.locationsOf(target);
        const chosen = new Map<number, FlowDebugLocation>();
        for (const ref of refs) {
            const location = this.match(locations, ref);
            if (!location) {
                const validSteps = [...new Set(locations.map(l => l.step?.number).filter((n): n is number => n !== undefined))].sort((a, b) => a - b);
                throw new FlowDebugError('unknown_breakpoint', { contextId: target, validSteps });
            }
            chosen.set(location.line, location);
        }
        const wanted = [...chosen.values()].map(l => ({ flowElementId: l.flowElementId, line: l.line }));
        const reply = await this.debugCall('post', `breakpoints/${target}`, target, wanted);
        const accepted = arr(obj(reply.result).body).map(obj);
        const refused = accepted.find(b => b.verified !== true);
        if (refused) throw new FlowDebugError('breakpoint_not_verified', { contextId: target, serverMessage: str(refused.message) });
        const readBack = await this.readBreakpoints(target);
        const same = readBack.length === wanted.length && wanted.every(w => readBack.some(b => b.line === w.line && b.flowElementId === w.flowElementId));
        if (!same) throw new FlowDebugError('unexpected_response', { contextId: target });
        this._logger.info('Flow debug breakpoints set', { contextId: target, lines: wanted.map(w => w.line) });
        return readBack;
    }

    /** Remove every breakpoint from the active context. */
    public async clearBreakpoints(contextId: string): Promise<void> {
        const observed = await this.observe(this.id(contextId));
        this.requireOpen(observed);
        const target = observed.snapshot.contextId;
        await this.debugCall('post', `breakpoints/${target}`, target, []);
        if ((await this.readBreakpoints(target)).length) throw new FlowDebugError('unexpected_response', { contextId: target });
    }

    /** Run the paused step; stop at the next one. */
    public stepOver(contextId: string, options?: FlowDebugWaitOptions): Promise<FlowDebugSnapshot> {
        return this.command(contextId, 'STEP_OVER', options);
    }

    /** Like step over, but a subflow call is entered and paused in, in a child context. */
    public stepInto(contextId: string, options?: FlowDebugWaitOptions): Promise<FlowDebugSnapshot> {
        return this.command(contextId, 'STEP_INTO', options);
    }

    /** Run the rest of the active context; at the top level, that is the rest of the run. */
    public stepOut(contextId: string, options?: FlowDebugWaitOptions): Promise<FlowDebugSnapshot> {
        return this.command(contextId, 'STEP_OUT', options);
    }

    /** Run to the next breakpoint, or to the end. */
    public resume(contextId: string, options?: FlowDebugWaitOptions): Promise<FlowDebugSnapshot> {
        return this.command(contextId, 'RESUME', options);
    }

    /** Run to the end, ignoring breakpoints. */
    public skipAll(contextId: string, options?: FlowDebugWaitOptions): Promise<FlowDebugSnapshot> {
        return this.command(contextId, 'SKIP_ALL', options);
    }

    /**
     * Send one debugger command to the paused context and wait for the run to settle: paused
     * again, ended, waiting, or still executing when the wait times out (`timedOut`).
     */
    public async command(contextId: string, command: FlowDebugCommand, options?: FlowDebugWaitOptions): Promise<FlowDebugSnapshot> {
        // The debugger answers success to any name and then runs the flow to the end.
        if (!COMMANDS.includes(command)) throw new FlowDebugError('invalid_input');
        const root = this.id(contextId);
        const timeoutMs = this.timeout(options?.timeoutMs);
        const before = await this.observe(root);
        this.requireDebug(before, root);
        if (before.snapshot.state !== 'PAUSED') {
            throw new FlowDebugError('not_paused', { contextId: before.snapshot.contextId, state: before.snapshot.rawState });
        }
        const target = before.snapshot.contextId;
        const reply = obj((await this.debugCall('post', `command/${target}/${command}`, target, {})).result);
        if (reply.success !== true || reply.command !== command) {
            throw new FlowDebugError('unexpected_response', { contextId: target, serverMessage: str(reply.message) });
        }
        this._logger.info('Flow debug command sent', { contextId: target, command });
        return (await this.waitFor(root, before.fingerprint, timeoutMs)).snapshot;
    }

    /**
     * End the run. Cancelling the root also ends any child subflow context. The state is read
     * back, because the debugger answers "cancelled flow" whatever it did. Safe to repeat.
     *
     * @throws FlowDebugError `not_a_debug_session` for a context the debugger did not start, so
     *   this can never cancel someone's real flow run.
     */
    public async cancel(contextId: string): Promise<FlowDebugCancelResult> {
        const root = await this.rootOf(this.id(contextId));
        const first = await this.read(root);
        if (obj(first.flowContext).debugMode !== true) throw new FlowDebugError('not_a_debug_session', { contextId: root, state: first.state });
        // Collected before the cancel: once the root's cancel ends a middle context, a walk from the
        // root no longer reaches the contexts below it.
        const openBefore = await this.openDescendants(root);
        if (ENDED.has(first.state) && openBefore.length === 0) {
            return { contextId: root, before: first.state, after: first.state, cancelled: false, alreadyEnded: true };
        }
        let endedHere = false;
        if (!ENDED.has(first.state)) await this.postCancel(root);
        let after = ENDED.has(first.state) ? first.state : await this.settleCancel(root);
        // Cancelling the root has ended its subflow contexts every time it was tried; one left open
        // would still hold a worker, so each is read back, and cancelled itself if needed.
        const descendants = [...new Set([...openBefore, ...await this.openDescendants(root)])];
        for (const child of descendants) {
            const state = (await this.read(child)).state;
            if (ENDED.has(state)) {
                endedHere = endedHere || state === 'CANCELLED';
                continue;
            }
            await this.postCancel(child);
            const settled = await this.settleCancel(child);
            if (!ENDED.has(settled)) throw new FlowDebugError('cancel_failed', { contextId: child, state: settled });
            endedHere = true;
        }
        if (!ENDED.has(after)) {
            await this.postCancel(root);
            after = await this.settleCancel(root);
        }
        if (!ENDED.has(after)) throw new FlowDebugError('cancel_failed', { contextId: root, state: after });
        this._logger.info('Flow debug run cancelled', { contextId: root, before: first.state, after });
        const cancelled = (!ENDED.has(first.state) && after === 'CANCELLED') || endedHere;
        return { contextId: root, before: first.state, after, cancelled, alreadyEnded: false };
    }

    /**
     * Start, run to the first of the breakpoints, and report the run there. By default the run is
     * then cancelled, so one call leaves nothing open.
     */
    public async runTo(options: FlowDebugRunToOptions): Promise<FlowDebugRunToResult> {
        const after = options?.after ?? 'cancel';
        if (!['cancel', 'resume', 'stay'].includes(after)) throw new FlowDebugError('invalid_input');
        if (!Array.isArray(options?.breakpoints) || options.breakpoints.length === 0) throw new FlowDebugError('invalid_input');
        const session = await this.start(options);
        const root = session.contextId;
        try {
            let snapshot = session.snapshot;
            const lines = new Set(session.breakpoints.map(b => b.line));
            const atBreakpoint = snapshot.state === 'PAUSED' && snapshot.pausedLines.some(l => lines.has(l)) && snapshot.contextId === root;
            if (snapshot.state === 'PAUSED' && !atBreakpoint) snapshot = await this.resume(root, { timeoutMs: options.timeoutMs });
            const result: FlowDebugRunToResult = { session, snapshot };
            if (after === 'resume') {
                // final is the run as last seen. Not paused means it is already running on (or ended):
                // a run that has not ended by then is left running, and final says so.
                result.final = snapshot.state === 'PAUSED' ? await this.skipAll(root, { timeoutMs: options.timeoutMs }) : snapshot;
            }
            if (after === 'cancel') result.cancel = await this.cancel(root);
            return result;
        } catch (error) {
            await this.cancel(root).catch(() => undefined);
            throw error;
        }
    }

    /**
     * Start a run, hand it to `work`, and cancel it afterwards unless it has ended.
     *
     * If `work` throws, the run is cancelled and `work`'s error is rethrown. If `work` succeeds but
     * the final cancel fails, the cancel's error is thrown instead of the result: a run that may
     * still be open matters more than the result.
     */
    public async withSession<T>(options: FlowDebugStartOptions, work: (session: FlowDebugSession) => Promise<T>): Promise<T> {
        const session = await this.start(options);
        let result: T;
        try {
            result = await work(session);
        } catch (error) {
            await this.cancel(session.contextId).catch(() => undefined);
            throw error;
        }
        await this.cancel(session.contextId);
        return result;
    }

    /** Debug runs that are still open (paused, waiting or executing), newest first. */
    public async listSessions(options: FlowDebugListOptions = {}): Promise<FlowDebugSessionSummary[]> {
        const limit = options.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new FlowDebugError('invalid_input');
        if (options.createdBy !== undefined && !USER_NAME.test(options.createdBy)) throw new FlowDebugError('invalid_input');
        let query = `calling_source=DEBUG_BUTTON^stateIN${OPEN.join(',')}`;
        if (options.createdBy) query += `^sys_created_by=${options.createdBy}`;
        const rows = await this.table('sys_flow_context', `${query}^ORDERBYDESCsys_created_on`, 'sys_id,name,flow,state,sys_created_by,sys_created_on', limit);
        return rows.map(row => ({
            contextId: str(row.sys_id),
            flowName: str(row.name),
            flowSysId: str(obj(row.flow).value ?? row.flow),
            state: str(row.state),
            createdBy: str(row.sys_created_by),
            createdOn: str(row.sys_created_on),
        }));
    }

    // ----------------------------------------------------------------
    // Resolution and inputs
    // ----------------------------------------------------------------

    private async resolveFlow(flow: unknown): Promise<string> {
        const identifier = str(flow).trim();
        if (ID.test(identifier.toLowerCase())) return identifier.toLowerCase();
        const scoped = SCOPED_NAME.exec(identifier);
        if (!scoped) throw new FlowDebugError('invalid_input');
        const rows = await this.table('sys_hub_flow', `sys_scope.scope=${scoped[1]}^internal_name=${scoped[2]}`, 'sys_id', 2);
        if (rows.length === 0) throw new FlowDebugError('flow_not_found');
        if (rows.length > 1) throw new FlowDebugError('invalid_input');
        return str(rows[0].sys_id);
    }

    private async definition(sysId: string): Promise<{ definition: Raw; type: 'flow' | 'subflow' }> {
        const result = await this._flows.getFlowArtifactDefinition(sysId, { scope: 'global' });
        if (result.success && result.definition && (result.artifactType === 'flow' || result.artifactType === 'subflow')) {
            return { definition: result.definition, type: result.artifactType };
        }
        if (result.success) throw new FlowDebugError('not_debuggable');
        if (result.failureReason === 'permission_denied') throw new FlowDebugError('permission_denied');
        if (result.failureReason === 'not_found' || result.failureReason === 'invalid_identifier') {
            // Action Designer has Test, not Debug: there is no start endpoint for an action.
            const actions = await this.table('sys_hub_action_type_definition', `sys_id=${sysId}`, 'sys_id', 1);
            throw new FlowDebugError(actions.length ? 'not_debuggable' : 'flow_not_found');
        }
        throw new FlowDebugError('unexpected_response');
    }

    /**
     * The `outputMap` the start call takes. For a subflow, names are checked against its declared
     * inputs, and a JavaScript array for an `array.*` input becomes `{children: [...]}`, the shape
     * Workflow Studio sends; a plain array reaches the flow as an empty list.
     */
    private outputMap(definition: Raw, type: 'flow' | 'subflow', inputs: Record<string, unknown>): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        if (type === 'flow') {
            // A flow's inputs are its trigger's outputs, which have no declared list to check.
            for (const [name, value] of Object.entries(inputs)) out[name] = value;
            return out;
        }
        const declared = new Map(arr(definition.inputs).map(obj).map(input => [str(input.name), input]));
        const unknown = Object.keys(inputs).filter(name => !declared.has(name));
        if (unknown.length) throw new FlowDebugError('unknown_input', { inputs: unknown });
        const missing = [...declared.values()]
            .filter(input => input.mandatory === true && (inputs[str(input.name)] === undefined || inputs[str(input.name)] === null))
            .map(input => str(input.name));
        if (missing.length) throw new FlowDebugError('missing_input', { inputs: missing });
        for (const [name, value] of Object.entries(inputs)) {
            const input = declared.get(name) ?? {};
            if (str(input.type).startsWith('array.') && Array.isArray(value)) {
                const child = str(obj(arr(input.children)[0]).name) || `${name}_child0`;
                out[name] = { children: (value as unknown[]).map(item => ({ name: child, value: item })) };
            } else {
                out[name] = value;
            }
        }
        return out;
    }

    // ----------------------------------------------------------------
    // Observing the run
    // ----------------------------------------------------------------

    /** Read the root and follow it into the child subflow context a step into left paused. */
    private async observe(root: string): Promise<Observation> {
        const rootRead = await this.read(root);
        const chain = [root];
        let current = rootRead;
        while (current.state === 'WAITING' && chain.length <= MAX_DEPTH) {
            const child = (await this.openChildren(current.contextId))[0];
            if (!child || chain.includes(child)) break;
            current = await this.read(child);
            chain.push(child);
        }
        const locations = await this.locationsOf(current.contextId, current.raw).catch(() => [] as FlowDebugLocation[]);
        const snapshot = this.snapshot(root, chain, current, locations);
        // The engine numbers every instruction it executes (operationsCore.order), so a loop that
        // pauses at the same line again still changes the fingerprint.
        const orders = ['actionOperationsReports', 'subflowOperationsReports', 'iterationOperationsReports']
            .flatMap(bucket => Object.entries(obj(current.report[bucket])).map(([key, entry]) => `${key}:${str(obj(obj(entry).operationsCore).order)}`));
        const fingerprint = JSON.stringify([chain, current.state, snapshot.pausedLines, str(current.flowContext.runTime),
            snapshot.steps.map(s => `${s.reportKey}:${s.state}`), orders, str(obj(current.report.operationsCore).order)]);
        return { snapshot, fingerprint, debugMode: obj(rootRead.flowContext).debugMode === true };
    }

    /** Poll until the run differs from `previous` and is no longer executing, or the time runs out. */
    private async waitFor(root: string, previous: string | null, timeoutMs: number): Promise<Observation> {
        const deadline = Date.now() + timeoutMs;
        let delay = this._poll.firstMs;
        let waitingSince: number | undefined;
        for (;;) {
            await this.sleep(delay);
            const observed = await this.observe(root);
            const moved = previous === null || observed.fingerprint !== previous;
            const waiting = observed.snapshot.rawState === 'WAITING';
            waitingSince = waiting ? waitingSince ?? Date.now() : undefined;
            const settled = !EXECUTING.has(observed.snapshot.rawState)
                && (!waiting || Date.now() - (waitingSince ?? 0) >= this._poll.waitingSettleMs);
            if (moved && settled) return observed;
            if (Date.now() + delay > deadline) {
                observed.snapshot.timedOut = true;
                return observed;
            }
            delay = Math.min(this._poll.maxMs, Math.round(delay * this._poll.factor));
        }
    }

    private snapshot(root: string, chain: string[], read: ContextRead, locations: FlowDebugLocation[]): FlowDebugSnapshot {
        const flowContext = read.flowContext;
        const report = read.report;
        const instances = this.instances(obj(read.raw.flow));
        const pausedLines = arr(flowContext.pausedInDebugLocations).map(Number).filter(Number.isFinite);
        const steps: FlowDebugStepData[] = [];
        for (const bucket of ['actionOperationsReports', 'subflowOperationsReports', 'iterationOperationsReports']) {
            for (const [key, value] of Object.entries(obj(report[bucket]))) {
                const entry = obj(value);
                const core = obj(entry.operationsCore);
                const step = instances.byId.get(key.split('.')[0]);
                const error = str(core.error);
                const runTime = Number(core.runTime);
                steps.push({
                    reportKey: key,
                    step,
                    state: str(core.state),
                    ...(error ? { error } : {}),
                    ...(core.startTime ? { startTime: str(core.startTime) } : {}),
                    ...(Number.isFinite(runTime) && core.runTime !== undefined ? { runTimeMs: runTime } : {}),
                    inputs: this.values(obj(entry.operationsInput).data),
                    outputs: this.values(obj(entry.operationsOutput).data),
                });
            }
        }
        steps.sort((a, b) => (a.step?.number ?? Number.MAX_SAFE_INTEGER) - (b.step?.number ?? Number.MAX_SAFE_INTEGER)
            || a.reportKey.localeCompare(b.reportKey));
        const state = this.state(read.state);
        const pausedAt = state === 'PAUSED' ? locations.find(l => pausedLines.includes(l.line)) : undefined;
        const snapshot: FlowDebugSnapshot = {
            rootContextId: root,
            contextId: read.contextId,
            chain,
            flowName: str(flowContext.name),
            state,
            rawState: read.state,
            pausedLines,
            ...(pausedAt ? { pausedAt } : {}),
            steps,
            flowInputs: this.values(obj(report.operationsInput).data),
            flowOutputs: this.values(obj(report.operationsOutput).data),
        };
        if (state === 'ERROR') {
            const failed = steps.find(s => s.state === 'ERROR' && s.error && s.error !== 'Success');
            const error = failed?.error ?? str(obj(report.operationsCore).error);
            if (error) snapshot.error = error;
        }
        return snapshot;
    }

    private state(raw: string): FlowDebugState {
        if (raw === 'PAUSED_IN_DEBUG') return 'PAUSED';
        if (EXECUTING.has(raw)) return 'RUNNING';
        if (raw === 'WAITING' || raw === 'COMPLETE' || raw === 'CANCELLED' || raw === 'ERROR') return raw;
        return 'UNKNOWN';
    }

    private values(data: unknown): Record<string, FlowDebugValue> {
        const out: Record<string, FlowDebugValue> = {};
        for (const [name, value] of Object.entries(obj(data))) {
            const item = obj(value);
            out[name] = { value: 'value' in item ? item.value : value, ...(item.displayValue !== undefined ? { displayValue: str(item.displayValue) } : {}) };
        }
        return out;
    }

    /** The run's flow snapshot, indexed by instance id and by uiUniqueIdentifier. */
    private instances(flow: Raw): { byId: Map<string, FlowDebugStepInfo>; byUi: Map<string, FlowDebugStepInfo> } {
        const byId = new Map<string, FlowDebugStepInfo>();
        const byUi = new Map<string, FlowDebugStepInfo>();
        const kinds: Array<[string, FlowDebugStepKind]> = [['actionInstances', 'action'], ['flowLogicInstances', 'flowLogic'], ['subFlowInstances', 'subflow']];
        for (const [bucket, kind] of kinds) {
            for (const item of arr(flow[bucket]).map(obj)) {
                const order = Number(item.order);
                const ui = str(item.uiUniqueIdentifier);
                const label = (str(item.name) || str(item.displayText) || str(obj(item.subFlow).name) || str(obj(item.actionType).name) || kind)
                    .trim().replace(/:\s*$/, '');
                const info: FlowDebugStepInfo = {
                    ...(Number.isFinite(order) && str(item.order) !== '' ? { number: order } : {}),
                    label,
                    kind,
                    uiUniqueIdentifier: ui,
                    ...(item.id ? { snapshotInstanceId: str(item.id) } : {}),
                    ...(str(item.parent) ? { parent: str(item.parent) } : {}),
                };
                if (item.id) byId.set(str(item.id), info);
                if (ui) byUi.set(ui, info);
            }
        }
        return { byId, byUi };
    }

    private async locationsOf(contextId: string, raw?: Raw): Promise<FlowDebugLocation[]> {
        let allowed = this._allowed.get(contextId);
        if (!allowed) {
            const reply = await this.debugCall('get', `allowed-breakpoints/${contextId}`, contextId);
            allowed = arr(obj(reply.result).body).map(obj)
                .map(b => ({ flowElementId: str(b.flowElementId), line: Number(b.line) }))
                .filter(b => b.flowElementId && Number.isInteger(b.line));
            this._allowed.set(contextId, allowed);
        }
        const flow = obj((raw ?? (await this.read(contextId)).raw).flow);
        const { byUi } = this.instances(flow);
        return allowed.map(({ flowElementId, line }) => {
            const direct = byUi.get(flowElementId);
            if (direct) return { line, flowElementId, step: direct };
            const inner = ACTION_STEP.exec(flowElementId);
            const action = inner ? byUi.get(inner[2]) : undefined;
            if (inner && action) {
                return { line, flowElementId, step: { label: `${action.label} (inner step)`, kind: 'actionStep' as const,
                    uiUniqueIdentifier: inner[2], actionStepId: inner[1],
                    ...(action.snapshotInstanceId ? { snapshotInstanceId: action.snapshotInstanceId } : {}) } };
            }
            return { line, flowElementId };
        }).sort((a, b) => a.line - b.line);
    }

    private async readBreakpoints(contextId: string): Promise<FlowDebugBreakpoint[]> {
        const reply = await this.debugCall('get', `breakpoints/${contextId}`, contextId);
        const locations = await this.locationsOf(contextId);
        return arr(obj(reply.result).body).map(obj).map(b => {
            const line = Number(b.line);
            const location = locations.find(l => l.line === line);
            return {
                line,
                flowElementId: str(b.flowElementId),
                ...(location?.step ? { step: location.step } : {}),
                verified: b.verified === true,
                ...(b.message ? { message: str(b.message) } : {}),
            };
        }).sort((a, b) => a.line - b.line);
    }

    private match(locations: FlowDebugLocation[], ref: FlowDebugStepRef): FlowDebugLocation | undefined {
        if (typeof ref === 'number') return locations.find(l => l.step?.number === ref && l.step.kind !== 'actionStep');
        if ('line' in ref) return locations.find(l => l.line === ref.line);
        return locations.find(l => l.flowElementId === ref.flowElementId);
    }

    private requireDebug(observed: Observation, root: string): void {
        if (!observed.debugMode) throw new FlowDebugError('not_a_debug_session', { contextId: root, state: observed.snapshot.rawState });
    }

    private requireOpen(observed: Observation): void {
        this.requireDebug(observed, observed.snapshot.rootContextId);
        if (ENDED.has(observed.snapshot.rawState)) {
            throw new FlowDebugError('not_paused', { contextId: observed.snapshot.contextId, state: observed.snapshot.rawState });
        }
    }

    // ----------------------------------------------------------------
    // Cancel
    // ----------------------------------------------------------------

    private async postCancel(contextId: string): Promise<void> {
        try {
            await this.call('post', `operations/flow/context/${contextId}/cancel`, {});
        } catch (error) {
            throw this.translate(error, contextId, 'cancel_failed');
        }
    }

    /** Wait (about 10 seconds at most) for a cancelled context to reach an end state. */
    private async settleCancel(contextId: string): Promise<string> {
        let state = '';
        for (let attempt = 0; attempt < 12; attempt++) {
            await this.sleep(attempt === 0 ? this._poll.firstMs : Math.min(this._poll.maxMs, this._poll.firstMs * (attempt + 1)));
            state = (await this.read(contextId)).state;
            if (ENDED.has(state)) return state;
        }
        return state;
    }

    /** Child subflow contexts of `parent` that are still open: a paused one first, then newest first. */
    private async openChildren(parent: string): Promise<string[]> {
        const rows = await this.table('sys_flow_context',
            `source_table=sys_flow_context^source_record=${parent}^stateIN${OPEN.join(',')}^ORDERBYDESCsys_created_on`, 'sys_id,state', 100);
        const open = rows.filter(row => ID.test(str(row.sys_id)));
        const paused = open.filter(row => str(row.state) === 'PAUSED_IN_DEBUG');
        return [...paused, ...open.filter(row => !paused.includes(row))].map(row => str(row.sys_id));
    }

    /**
     * Every open context below `root`, at any depth up to MAX_DEPTH. Ended contexts are walked
     * through too: a cancel can end a middle context and leave the one below it paused.
     */
    private async openDescendants(root: string): Promise<string[]> {
        const found: string[] = [];
        const seen = new Set([root]);
        let level = [root];
        for (let depth = 0; depth < MAX_DEPTH && level.length; depth++) {
            const next: string[] = [];
            for (const parent of level) {
                const rows = await this.table('sys_flow_context',
                    `source_table=sys_flow_context^source_record=${parent}^ORDERBYDESCsys_created_on`, 'sys_id,state', 100);
                for (const row of rows) {
                    const child = str(row.sys_id);
                    if (!ID.test(child) || seen.has(child)) continue;
                    seen.add(child);
                    next.push(child);
                    if (OPEN.includes(str(row.state))) found.push(child);
                }
            }
            level = next;
        }
        return found;
    }

    /** The root of a subflow context's chain; a root is its own. */
    private async rootOf(contextId: string): Promise<string> {
        let current = contextId;
        for (let depth = 0; depth < MAX_DEPTH; depth++) {
            const row = (await this.table('sys_flow_context', `sys_id=${current}`, 'source_table,source_record', 1))[0];
            const parent = str(row?.source_record);
            if (!row || str(row.source_table) !== 'sys_flow_context' || !ID.test(parent)) return current;
            current = parent;
        }
        return current;
    }

    // ----------------------------------------------------------------
    // HTTP
    // ----------------------------------------------------------------

    private async read(contextId: string): Promise<ContextRead> {
        let reply: Raw;
        try {
            // Sensitive: the reply holds the run's data, which must not reach a debug log.
            reply = await this.call('get', `operations/flow/context/${contextId}`, undefined, { sensitive: true });
        } catch (error) {
            throw this.translate(error, contextId, 'unexpected_response');
        }
        const raw = obj(reply.result);
        const flowContext = obj(raw.flowContext);
        if (!raw.flowContext) throw new FlowDebugError('unexpected_response', { contextId });
        return { contextId, raw, flowContext, report: obj(raw.flowReport), state: str(flowContext.state) };
    }

    private async debugCall(method: 'get' | 'post', path: string, contextId: string, body?: unknown): Promise<Raw> {
        try {
            return await this.call(method, `debug/${path}`, body);
        } catch (error) {
            throw this.translate(error, contextId, 'unexpected_response');
        }
    }

    private async call(method: 'get' | 'post', path: string, body?: unknown,
        options: { query?: Record<string, string>; sensitive?: boolean } = {}): Promise<Raw> {
        const request: HTTPRequest = {
            path: `${PROCESSFLOW_API_BASE}/${path}`,
            method,
            headers: HEADERS,
            query: options.query ?? GLOBAL,
            body: null,
            ...(method === 'post' ? { json: (body ?? {}) as object } : {}),
            ...(options.sensitive ? { sensitive: true } : {}),
        };
        const response = method === 'get' ? await this._request.get<Raw>(request) : await this._request.post<Raw>(request);
        return obj((response as { bodyObject?: unknown }).bodyObject ?? (response as { data?: unknown }).data);
    }

    private async table(table: string, query: string, fields: string, limit: number): Promise<Raw[]> {
        const response = await this._request.get<Raw>({ path: `/api/now/table/${table}`, method: 'get', headers: null, body: null,
            query: { sysparm_query: query, sysparm_fields: fields, sysparm_limit: String(limit), sysparm_exclude_reference_link: 'true' } });
        return arr(obj((response as { bodyObject?: unknown }).bodyObject ?? (response as { data?: unknown }).data).result).map(obj);
    }

    /**
     * Turn a failed call into a FlowDebugError. Policy refusals, session errors and anything that
     * is not an HTTP failure pass through untouched.
     */
    private translate(error: unknown, contextId: string | undefined, fallback: 'start_failed' | 'cancel_failed' | 'unexpected_response'): unknown {
        if (isPolicyRefusal(error) || error instanceof FlowDebugError || !(error instanceof Error)) return error;
        const match = /Status: (\d{3}) Body: ([\s\S]*)$/.exec(error.message) ?? /status (\d{3})/i.exec(error.message);
        if (!match) return error;
        const status = Number(match[1]);
        let serverMessage = '';
        try {
            const parsed = obj(JSON.parse(match[2] ?? ''));
            serverMessage = str(obj(parsed.result).message) || str(obj(parsed.error).message);
        } catch {
            serverMessage = '';
        }
        const detail = { contextId, status, ...(serverMessage ? { serverMessage } : {}) };
        if (/not in 'PAUSED IN DEBUG' state/i.test(serverMessage)) return new FlowDebugError('not_paused', detail);
        if (/not started in debug mode/i.test(serverMessage)) return new FlowDebugError('not_a_debug_session', detail);
        if (/invalid sys_id/i.test(serverMessage) || /does not exist/i.test(serverMessage) || status === 404) {
            return new FlowDebugError('context_not_found', detail);
        }
        if (status === 400 && /does not represent any resource/i.test(serverMessage)) return new FlowDebugError('release_unsupported', detail);
        if (status === 401 || status === 403) return new FlowDebugError('permission_denied', detail);
        return new FlowDebugError(fallback, detail);
    }

    // ----------------------------------------------------------------
    // Arguments
    // ----------------------------------------------------------------

    private id(contextId: unknown): string {
        const id = str(contextId).trim().toLowerCase();
        if (!ID.test(id)) throw new FlowDebugError('invalid_input');
        return id;
    }

    private refs(steps: unknown): FlowDebugStepRef[] {
        if (!Array.isArray(steps)) throw new FlowDebugError('invalid_input');
        return steps.map(step => {
            if (typeof step === 'number' && Number.isInteger(step) && step > 0) return step;
            const ref = obj(step);
            if (typeof ref.line === 'number' && Number.isInteger(ref.line) && ref.line > 0) return { line: ref.line };
            if (typeof ref.flowElementId === 'string' && /^[a-z0-9-]{1,120}$/i.test(ref.flowElementId)) return { flowElementId: ref.flowElementId };
            throw new FlowDebugError('invalid_input');
        });
    }

    private timeout(value: unknown): number {
        if (value === undefined) return DEFAULT_TIMEOUT_MS;
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 3_600_000) throw new FlowDebugError('invalid_input');
        return value;
    }

    /** Overridable in tests. */
    protected sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
