/**
 * Types for {@link FlowDebugger}: driving the Workflow Studio flow debugger over REST.
 *
 * The debugger is the one behind Workflow Studio's **Test ▸ Debug**. It runs the flow or subflow
 * for real, one step at a time, and exposes each step's runtime inputs and outputs while paused.
 */

/** The five commands the debugger accepts. Any other name runs the flow to the end, so none is sent. */
export type FlowDebugCommand = 'STEP_INTO' | 'STEP_OVER' | 'STEP_OUT' | 'RESUME' | 'SKIP_ALL';

/**
 * Where a debug run stands.
 *
 * - `PAUSED`: stopped at a location, waiting for a command (`PAUSED_IN_DEBUG`).
 * - `RUNNING`: executing a step (`IN_PROGRESS`, `QUEUED`), or still so when a wait timed out.
 * - `WAITING`: the flow is waiting on something other than the debugger, such as a timer or a
 *   Wait For Condition step. A parent whose child subflow is paused is reported as the child's state.
 * - `COMPLETE`, `CANCELLED`, `ERROR`: the run has ended.
 * - `UNKNOWN`: a state this library does not recognise; `rawState` holds it.
 */
export type FlowDebugState = 'PAUSED' | 'RUNNING' | 'WAITING' | 'COMPLETE' | 'CANCELLED' | 'ERROR' | 'UNKNOWN';

/** What kind of element a debug location is. */
export type FlowDebugStepKind = 'action' | 'flowLogic' | 'subflow' | 'actionStep';

/**
 * A step to break at: its number as Workflow Studio shows it (the `order`), or a location
 * exactly as `allowed-breakpoints` reports it.
 */
export type FlowDebugStepRef = number | { line: number } | { flowElementId: string };

/** One element of the flow, as numbered in Workflow Studio. */
export interface FlowDebugStepInfo {
    /** Step number shown in Workflow Studio. Absent for a custom action's inner step. */
    number?: number;
    /** Label, for example "Create Task" or "If: Wait for Completion". */
    label: string;
    kind: FlowDebugStepKind;
    /** `uiUniqueIdentifier` of the instance; for an inner action step, of its action. */
    uiUniqueIdentifier: string;
    /** sys_id of the instance in the run's flow snapshot. Report entries are keyed by it. */
    snapshotInstanceId?: string;
    /** For an inner action step: its step sys_id within the action. */
    actionStepId?: string;
    /** `uiUniqueIdentifier` of the enclosing flow logic (an If, a For Each), when nested. */
    parent?: string;
}

/** A place the debugger can stop. `line` is the debugger's own number, not the step number. */
export interface FlowDebugLocation {
    line: number;
    flowElementId: string;
    /** The element at that location, when the run's snapshot names it. */
    step?: FlowDebugStepInfo;
}

/** A breakpoint the debugger holds for one context. */
export interface FlowDebugBreakpoint extends FlowDebugLocation {
    verified: boolean;
    /** The debugger's reason when `verified` is false. */
    message?: string;
}

/** One runtime value of a step or the flow, as the operations view reports it. */
export interface FlowDebugValue {
    value: unknown;
    displayValue?: string;
}

/** Runtime data for one executed (or ready) element of the run. */
export interface FlowDebugStepData {
    /** Report key: the snapshot instance id, or `<id>.ForEach$` / `<id>.item$<n>` for loops. */
    reportKey: string;
    step?: FlowDebugStepInfo;
    /** Report state, for example NOT_READY, COMPLETE, ERROR. */
    state: string;
    /** The step's error text. The engine writes "Success" here for a step that completed. */
    error?: string;
    startTime?: string;
    runTimeMs?: number;
    inputs: Record<string, FlowDebugValue>;
    outputs: Record<string, FlowDebugValue>;
}

/** The run as one context sees it, at the moment it was read. */
export interface FlowDebugSnapshot {
    /** The root context: the one `start` returned, which commands and cancel take. */
    rootContextId: string;
    /**
     * The context this snapshot describes. It differs from the root while a child subflow,
     * entered with step into, is the one that is paused.
     */
    contextId: string;
    /** Context ids from the root down to `contextId`. */
    chain: string[];
    flowName: string;
    state: FlowDebugState;
    /** `flowContext.state` of `contextId`, as reported. */
    rawState: string;
    /** Debugger lines `contextId` is paused at. */
    pausedLines: number[];
    /** Where `contextId` is paused, when it is. */
    pausedAt?: FlowDebugLocation;
    /** Every element of `contextId` that has a report so far, in step order. */
    steps: FlowDebugStepData[];
    flowInputs: Record<string, FlowDebugValue>;
    flowOutputs: Record<string, FlowDebugValue>;
    /** The run's error, when it ended in ERROR. */
    error?: string;
    /** True when a wait gave up while the run was still executing. */
    timedOut?: boolean;
}

/** Options for {@link FlowDebugger.start}. */
export interface FlowDebugStartOptions {
    /** sys_id of the flow or subflow, or `scope.internal_name`. Actions cannot be debugged. */
    flow: string;
    /**
     * Inputs by name: a subflow's inputs, or a flow's trigger outputs (`current`, `table_name`, …)
     * the same way {@link FlowManager.testFlow} takes them. A JavaScript array for an `array.*`
     * input is sent in the shape Workflow Studio uses.
     */
    inputs?: Record<string, unknown>;
    /** Steps to break at, set once the run first pauses. */
    breakpoints?: FlowDebugStepRef[];
    /** How long to wait for the run to first pause. Defaults to 60 seconds. */
    timeoutMs?: number;
}

/** A debug run that has started. */
export interface FlowDebugSession {
    /** The root context id: pass it to every other call. */
    contextId: string;
    flow: { sysId: string; name: string; type: 'flow' | 'subflow'; scope: string };
    /** Places the root context can stop. */
    locations: FlowDebugLocation[];
    /** Breakpoints set from `breakpoints`. */
    breakpoints: FlowDebugBreakpoint[];
    snapshot: FlowDebugSnapshot;
}

/** Options for commands that wait for the run to settle. */
export interface FlowDebugWaitOptions {
    /** How long to wait for the next pause or the end. Defaults to 60 seconds. */
    timeoutMs?: number;
}

/** What {@link FlowDebugger.cancel} found and did. */
export interface FlowDebugCancelResult {
    contextId: string;
    /** State before the cancel. */
    before: string;
    /** State read back afterwards. */
    after: string;
    /** True when this call ended the run, or one of its subflow contexts. */
    cancelled: boolean;
    /** True when the run had already ended, so nothing was sent. */
    alreadyEnded: boolean;
}

/** Options for {@link FlowDebugger.runTo}. */
export interface FlowDebugRunToOptions extends FlowDebugStartOptions {
    breakpoints: FlowDebugStepRef[];
    /**
     * What to do once paused at the breakpoint (or ended): `cancel` (the default) ends the run,
     * `resume` lets it finish, `stay` leaves it paused for further commands. Not named `then`,
     * which would make the options object look like a promise.
     */
    after?: 'cancel' | 'resume' | 'stay';
}

/** The result of {@link FlowDebugger.runTo}. */
export interface FlowDebugRunToResult {
    session: FlowDebugSession;
    /** The run as it was at the breakpoint, or at its end if it never reached one. */
    snapshot: FlowDebugSnapshot;
    /**
     * Set when `after` was `resume`: the run as last seen. If its state is not COMPLETE, ERROR or
     * CANCELLED, it was left running (`timedOut`, or WAITING).
     */
    final?: FlowDebugSnapshot;
    /** Set when `after` was `cancel`. */
    cancel?: FlowDebugCancelResult;
}

/** An open debug run found on the instance. */
export interface FlowDebugSessionSummary {
    contextId: string;
    flowName: string;
    flowSysId: string;
    state: string;
    createdBy: string;
    createdOn: string;
}

/** Options for {@link FlowDebugger.listSessions}. */
export interface FlowDebugListOptions {
    /** Only runs started by this user name. */
    createdBy?: string;
    /** At most this many, newest first. Defaults to 50. */
    limit?: number;
}

/** Stable codes for {@link FlowDebugError}. */
export type FlowDebugErrorCode =
    /** An argument was missing or malformed. */
    | 'invalid_input'
    /** No flow or subflow matches the identifier. */
    | 'flow_not_found'
    /** The identifier names something the debugger cannot run, such as an action. */
    | 'not_debuggable'
    /** An input name the flow does not declare. */
    | 'unknown_input'
    /** A mandatory input with no value. */
    | 'missing_input'
    /** The debugger did not start a run. */
    | 'start_failed'
    /** A command needs the run to be paused, and it is not. */
    | 'not_paused'
    /** A breakpoint names a step the run cannot stop at. */
    | 'unknown_breakpoint'
    /** The debugger did not accept a breakpoint. */
    | 'breakpoint_not_verified'
    /** No context has that id. */
    | 'context_not_found'
    /** The context was not started by the debugger. */
    | 'not_a_debug_session'
    /** The session cannot use the debugger. */
    | 'permission_denied'
    /** The instance has no Workflow Studio debugger. */
    | 'release_unsupported'
    /** The debugger answered in a way this library does not understand. */
    | 'unexpected_response'
    /** A cancel was sent but the run did not end. */
    | 'cancel_failed';

/** Facts that explain a {@link FlowDebugError}. Never holds input values or step data. */
export interface FlowDebugErrorDetail {
    contextId?: string;
    /** The run's state when the error was raised. */
    state?: string;
    /** HTTP status of the failed call. */
    status?: number;
    /** The debugger's own message, which names ids and states only. */
    serverMessage?: string;
    /** Input names, for unknown_input and missing_input. */
    inputs?: string[];
    /** Valid step numbers, for unknown_breakpoint. */
    validSteps?: number[];
    /** For start_failed after a run began: whether it was cancelled again. */
    cancelled?: boolean;
}
