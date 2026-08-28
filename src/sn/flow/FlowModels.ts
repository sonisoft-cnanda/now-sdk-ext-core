/**
 * Models for Flow Designer execution operations.
 * Supports executing flows, subflows, and actions via BackgroundScriptExecutor
 * using the sn_fd.FlowAPI.getRunner() (ScriptableFlowRunner) API.
 */

// ============================================================
// Enums / Type Aliases
// ============================================================

/** Type of Flow Designer object to execute. */
export type FlowObjectType = 'flow' | 'subflow' | 'action';

/** Execution mode: synchronous (foreground) or asynchronous (background). */
export type FlowExecutionMode = 'foreground' | 'background';

// ============================================================
// Options Types
// ============================================================

/** Options for executing a Flow Designer object (flow, subflow, or action). */
export interface ExecuteFlowOptions {
    /** Scoped name of the flow/subflow/action, e.g. "global.my_flow" */
    scopedName: string;

    /** Type of object to execute */
    type: FlowObjectType;

    /** Input name-value pairs to pass to the flow/subflow/action */
    inputs?: Record<string, unknown>;

    /**
     * Execution mode: 'foreground' (sync) or 'background' (async).
     * Default: 'foreground'
     */
    mode?: FlowExecutionMode;

    /** Timeout in milliseconds (optional, SN default is 30s) */
    timeout?: number;

    /**
     * Quick mode: skip execution detail records for better performance.
     * Default: false
     */
    quick?: boolean;

    /**
     * Scope context for BackgroundScriptExecutor.
     * Can be a scope name ("global", "x_myapp_custom") or a 32-character sys_id.
     * Default: uses the FlowManager's default scope.
     */
    scope?: string;
}

/** Convenience options for executing a flow (type is implied). */
export interface ExecuteFlowByNameOptions extends Omit<ExecuteFlowOptions, 'type'> {}

/** Convenience options for executing a subflow (type is implied). */
export interface ExecuteSubflowOptions extends Omit<ExecuteFlowOptions, 'type'> {}

/** Convenience options for executing an action (type is implied). */
export interface ExecuteActionOptions extends Omit<ExecuteFlowOptions, 'type'> {}

// ============================================================
// Result Types
// ============================================================

/** Structured result from executing a flow/subflow/action. */
export interface FlowExecutionResult {
    /** Whether the execution completed without error */
    success: boolean;

    /** The scoped name of the executed flow object, e.g. "global.my_flow" */
    flowObjectName: string;

    /** Type of flow object that was executed */
    flowObjectType: FlowObjectType;

    /** sys_id of the execution context record (if not quick mode) */
    contextId?: string;

    /** Execution date/time as a string from the SN server */
    executionDate?: string;

    /** Domain sys_id (for domain-separated instances) */
    domainId?: string;

    /** Output name-value pairs returned by the flow/subflow/action */
    outputs?: Record<string, unknown>;

    /** Raw debug() output from ScriptableFlowRunnerResult */
    debugOutput?: string;

    /** Error message if execution failed */
    errorMessage?: string;

    /** The raw BackgroundScriptExecutionResult for advanced inspection */
    rawScriptResult?: unknown;
}

// ============================================================
// Internal Script Protocol
// ============================================================

/**
 * JSON envelope structure used for communication between
 * the generated SN server-side script and the FlowManager parser.
 * @internal
 */
export interface FlowScriptResultEnvelope {
    __flowResult: true;
    success: boolean;
    flowObjectName: string;
    flowObjectType: string;
    contextId: string | null;
    executionDate: string | null;
    domainId: string | null;
    outputs: Record<string, unknown> | null;
    debugOutput: string;
    errorMessage: string | null;
}

// ============================================================
// Flow Context Lifecycle Types
// ============================================================

/** Known states of a flow context record in sys_flow_context. */
export type FlowContextState = 'QUEUED' | 'IN_PROGRESS' | 'WAITING' | 'COMPLETE' | 'CANCELLED' | 'ERROR' | string;

/** Result from querying a flow context's status. */
export interface FlowContextStatusResult {
    success: boolean;
    contextId: string;
    found: boolean;
    state?: FlowContextState;
    name?: string;
    started?: string;
    ended?: string;
    errorMessage?: string;
    rawScriptResult?: unknown;
}

/** Result from retrieving outputs of a completed flow context. */
export interface FlowOutputsResult {
    success: boolean;
    contextId: string;
    outputs?: Record<string, unknown>;
    errorMessage?: string;
    rawScriptResult?: unknown;
}

/** Result from retrieving error messages of a flow context. */
export interface FlowErrorResult {
    success: boolean;
    contextId: string;
    flowErrorMessage?: string;
    errorMessage?: string;
    rawScriptResult?: unknown;
}

/** Result from cancelling a flow context. */
export interface FlowCancelResult {
    success: boolean;
    contextId: string;
    errorMessage?: string;
    rawScriptResult?: unknown;
}

/** Result from sending a message to a paused flow. */
export interface FlowSendMessageResult {
    success: boolean;
    contextId: string;
    errorMessage?: string;
    rawScriptResult?: unknown;
}

// ============================================================
// Publish Types
// ============================================================

/** Result from publishing a flow. */
export interface FlowPublishResult {
    /** Whether the publish operation completed without error */
    success: boolean;

    /** Display name or scoped name of the flow */
    flowName: string;

    /** sys_id of the published flow */
    flowSysId: string;

    /** Error message if publish failed */
    errorMessage?: string;

    /** The raw BackgroundScriptExecutionResult for advanced inspection */
    rawScriptResult?: unknown;
}

/**
 * Resolved flow identifier containing both sys_id and name.
 * @internal Used by FlowManager._resolveFlowIdentifier()
 */
export interface ResolvedFlowIdentifier {
    sysId: string;
    name: string;
}

// ============================================================
// Internal Script Protocol - Lifecycle Operations
// ============================================================

/**
 * JSON envelope for lifecycle operations (status, outputs, errors, cancel, message).
 * @internal
 */
export interface FlowLifecycleEnvelope {
    __flowResult: true;
    success: boolean;
    contextId: string;
    errorMessage: string | null;
    found?: boolean;
    state?: string | null;
    name?: string | null;
    started?: string | null;
    ended?: string | null;
    outputs?: Record<string, unknown> | null;
    flowErrorMessage?: string | null;
}

/**
 * JSON envelope emitted by the publish script.
 * Uses flowSysId (not contextId) since publish operates on a flow record, not an execution context.
 * @internal
 */
export interface FlowPublishEnvelope {
    __flowResult: true;
    success: boolean;
    flowSysId: string;
    errorMessage: string | null;
}

// ============================================================
// Test Flow Types (ProcessFlow REST API)
// ============================================================

/**
 * Options for testing a flow via the ProcessFlow REST API.
 * This tests the flow as if from Flow Designer, without requiring it to be published.
 */
export interface TestFlowOptions {
    /** Flow identifier: either a 32-char hex sys_id or a scoped name (e.g. "x_myapp.my_flow") */
    flowId: string;

    /**
     * Maps trigger output variable names to concrete test values.
     * For record-triggered flows, typically: `{ current: "<record_sys_id>", table_name: "<table>" }`
     */
    outputMap: Record<string, string>;

    /**
     * Scope sys_id for the transaction scope query parameter.
     * If omitted, the scope is read from the fetched flow definition.
     */
    scope?: string;

    /**
     * Whether to run the test synchronously on the current thread.
     * Default: true
     */
    runOnThread?: boolean;
}

/** Result from testing a flow via the ProcessFlow REST API. */
export interface FlowTestResult {
    /** Whether the test request completed successfully */
    success: boolean;

    /** sys_id of the test execution context (returned by the API as result.data) */
    contextId?: string;

    /** Error message from the API or from local processing */
    errorMessage?: string;

    /** Numeric error code from the API (0 = no error) */
    errorCode?: number;

    /** The raw API response for advanced inspection */
    rawResponse?: unknown;
}

/** Result from fetching a flow definition via the ProcessFlow REST API. */
export interface FlowDefinitionResult {
    /** Whether the fetch completed successfully */
    success: boolean;

    /** The raw flow definition object as returned by the processflow API */
    definition?: Record<string, unknown>;

    /** Error message if the fetch failed */
    errorMessage?: string;

    /** The raw API response for advanced inspection */
    rawResponse?: unknown;
}

/** Result from fetching a flow action (action type) via the ProcessFlow REST API. */
export interface FlowActionResult {
    /** Whether the fetch completed successfully */
    success: boolean;

    /**
     * The raw action data as returned by the processflow API.
     * May be a single action type object or an array, depending on the endpoint.
     */
    action?: Record<string, unknown> | unknown[];

    /** Error message if the fetch failed */
    errorMessage?: string;

    /** The raw API response for advanced inspection */
    rawResponse?: unknown;
}

/**
 * Shape of the processflow API response wrapper.
 * @internal
 */
export interface ProcessFlowApiResponse {
    result: {
        data: unknown;
        /** Some processflow endpoints (e.g. action/action_types) return their payload under `outputs` instead of `data`. */
        steps?: unknown;
        errorMessage: string;
        errorCode: number;
        integrationsPluginActive: boolean;
    };
}

/**
 * Payload sent to the processflow test endpoint.
 * @internal
 */
export interface ProcessFlowTestPayload {
    flow: Record<string, unknown>;
    outputMap: Record<string, string>;
    runOnThread: boolean;
}

// ============================================================
// Design-Time Definition Types (ProcessFlow REST API, read-only)
// ============================================================

/**
 * Artifact types whose design-time definition can be retrieved.
 *
 * Flows and subflows are served by the same endpoint and are distinguished by
 * the `type` field ServiceNow reports in the payload; actions are served by the
 * action-type endpoints.
 */
export type FlowDesignArtifactType = 'flow' | 'subflow';

/**
 * Stable, machine-readable reason for a definition retrieval failure.
 *
 * The ProcessFlow design-time routes are observed Workflow Studio APIs rather
 * than a documented public REST contract, so callers should branch on this
 * rather than on message text.
 */
export type FlowDefinitionFailureReason =
    /** The supplied identifier was blank or was not a 32-character hex sys_id. */
    | 'invalid_identifier'
    /** The artifact exists but is not the type the called operation retrieves. */
    | 'type_mismatch'
    /** ServiceNow reported no such artifact (or returned an empty payload for it). */
    | 'not_found'
    /** The session is not permitted to read the artifact. */
    | 'permission_denied'
    /** ServiceNow answered, but its response carried an error code/message. */
    | 'api_error'
    /** ServiceNow answered with a body that did not match the expected wrapper. */
    | 'malformed_response'
    /** The request itself failed (transport error, or an unclassified HTTP status). */
    | 'request_failed';

/** Options common to every design-time definition retrieval. */
export interface FlowDefinitionOptions {
    /**
     * Scope sys_id or scope name sent as `sysparm_transaction_scope`.
     * Optional; ServiceNow resolves the artifact's own scope when omitted.
     */
    scope?: string;
}

/**
 * Light, stable projection of a flow/subflow definition.
 *
 * Deliberately small: the full payload stays available and untouched on
 * `definition`, because ServiceNow evolves that schema between families and
 * normalising it here would make family upgrades breaking.
 */
export interface FlowArtifactSummary {
    /** sys_id of the flow or subflow */
    sysId: string;

    /** Display name */
    name: string;

    /** Internal (scriptable) name */
    internalName: string;

    /** Description text, empty string when unset */
    description: string;

    /** Scope sys_id */
    scope: string;

    /** Scope name, e.g. "global" */
    scopeName: string;

    /** Publication status, e.g. "published", "draft" */
    status: string;

    /** Whether the artifact is active */
    active: boolean;

    /** Number of trigger instances (always 0 for a subflow) */
    triggerCount: number;

    /** Number of action instances */
    actionCount: number;

    /** Number of nested subflow instances */
    subflowCount: number;

    /** Number of flow logic instances (if/else, for-each, etc.) */
    flowLogicCount: number;

    /** Number of declared inputs */
    inputCount: number;

    /** Number of declared outputs */
    outputCount: number;
}

/** Result of retrieving a flow or subflow design-time definition. */
export interface FlowArtifactDefinitionResult {
    /** Whether the definition was retrieved */
    success: boolean;

    /** The sys_id that was requested (trimmed) */
    sysId: string;

    /**
     * Artifact type as reported by ServiceNow, when it is one this library
     * recognises. Never inferred from the operation that was called.
     */
    artifactType?: FlowDesignArtifactType;

    /**
     * Raw `type` value ServiceNow reported. Populated whenever the response
     * carried one, including values this library does not recognise.
     */
    reportedType?: string;

    /**
     * The complete, JSON-serializable definition payload exactly as ServiceNow
     * returned it. Pass straight to `JSON.stringify`.
     */
    definition?: Record<string, unknown>;

    /** Convenience projection of the most commonly used definition fields */
    summary?: FlowArtifactSummary;

    /** Actionable failure description; never contains a response body */
    errorMessage?: string;

    /** Machine-readable failure classification */
    failureReason?: FlowDefinitionFailureReason;

    /** Numeric error code reported by the processflow API, when present */
    errorCode?: number;
}

/** Light projection of one step instance within an action definition. */
export interface ActionStepSummary {
    /** sys_id of the step instance */
    stepId: string;

    /** Execution order as reported by ServiceNow */
    order: number;

    /** Step label, e.g. "Script step" */
    label: string;

    /** Step type name, e.g. "Script" */
    stepTypeName: string;

    /** sys_id of the step type */
    stepTypeId: string;
}

/** Light, stable projection of an action definition. */
export interface ActionDefinitionSummary {
    /** sys_id of the action type */
    sysId: string;

    /** Display name */
    name: string;

    /** Internal (scriptable) name */
    internalName: string;

    /** Description text, empty string when unset */
    description: string;

    /** Scope sys_id */
    scope: string;

    /** Scope name, e.g. "global" */
    scopeName: string;

    /** Publication state, e.g. "published", "draft" */
    state: string;

    /** Whether the action is active */
    active: boolean;

    /** Number of declared inputs */
    inputCount: number;

    /** Number of declared outputs */
    outputCount: number;

    /** Number of step instances */
    stepCount: number;

    /** Ordered step projections, ascending by `order` */
    steps: ActionStepSummary[];
}

/**
 * Result of retrieving a complete action design-time definition.
 *
 * A complete action needs two reads — metadata and step instances — so both are
 * returned through this one contract. `success` is true only when both parts
 * were retrieved.
 */
export interface ActionDefinitionResult {
    /** Whether the complete definition was retrieved */
    success: boolean;

    /** The sys_id that was requested (trimmed) */
    sysId: string;

    /** Always 'action' on success; absent on failure */
    artifactType?: 'action';

    /**
     * Raw action-type metadata exactly as ServiceNow returned it
     * (`GET /api/now/processflow/action/action_types/{id}`).
     */
    metadata?: Record<string, unknown>;

    /**
     * Raw step instances exactly as ServiceNow returned them
     * (`GET .../step_instances`), sorted ascending by `order`.
     */
    steps?: Array<Record<string, unknown>>;

    /** Convenience projection of metadata plus ordered steps */
    summary?: ActionDefinitionSummary;

    /** Actionable failure description; never contains a response body */
    errorMessage?: string;

    /** Machine-readable failure classification */
    failureReason?: FlowDefinitionFailureReason;

    /** Numeric error code reported by the processflow API, when present */
    errorCode?: number;
}

// ============================================================
// Copy Flow Types (ProcessFlow REST API)
// ============================================================

/**
 * Options for copying a flow into a target scoped application via the ProcessFlow REST API.
 */
export interface CopyFlowOptions {
    /** Source flow identifier: either a 32-char hex sys_id or a scoped name (e.g. "global.change__standard") */
    sourceFlowId: string;

    /** Display name for the new copied flow */
    name: string;

    /** Target scope sys_id to copy the flow into */
    targetScope: string;
}

/** Result from copying a flow via the ProcessFlow REST API. */
export interface FlowCopyResult {
    /** Whether the copy operation completed successfully */
    success: boolean;

    /** sys_id of the newly created flow copy */
    newFlowSysId?: string;

    /** Error message from the API or from local processing */
    errorMessage?: string;

    /** Numeric error code from the API (0 = no error) */
    errorCode?: number;

    /** The raw API response for advanced inspection */
    rawResponse?: unknown;
}

// ============================================================
// Flow Context Details Types (ProcessFlow Operations API)
// ============================================================

/**
 * Core execution timing and state for a flow or action operation.
 * Common shape returned within flowReport at both flow and action level.
 */
export interface FlowOperationsCore {
    /** Error message if the operation failed (empty string if no error) */
    error: string;

    /** Execution state: COMPLETE, IN_PROGRESS, WAITING, ERROR, CANCELLED, etc. */
    state: string;

    /** Start time as a date-time string from the SN server */
    startTime: string;

    /** Execution order within the flow */
    order: string;

    /** Runtime in milliseconds */
    runTime: string;

    /** Flow context sys_id (present at the top-level operationsCore) */
    context?: string;
}

/**
 * Input or output data for a flow operation.
 * Keys are variable names; values contain the raw value, display value, and metadata.
 */
export interface FlowOperationsData {
    data: Record<string, {
        value: unknown;
        displayValue: string;
        inputUsed?: boolean;
    }>;
}

/** Per-action execution report within the flow execution report. */
export interface FlowActionReport {
    /** Number of steps executed in this action */
    fStepCount: string;

    /** Action instance name/identifier (raw sys_id from the API) */
    actionName: string;

    /** Reference to the action instance */
    instanceReference: string;

    /**
     * Human-readable step label resolved from the flow definition.
     * Combines the action type name and comment, e.g. "Update Record (Approve Change)".
     * Only populated when the flow definition is available in the response.
     */
    stepLabel?: string;

    /**
     * Action type name from the flow definition, e.g. "Update Record", "Look Up Record".
     * Only populated when the flow definition is available in the response.
     */
    actionTypeName?: string;

    /**
     * Step comment from the flow definition, e.g. "Approve Change".
     * Only populated when the flow definition is available in the response.
     */
    stepComment?: string;

    /** Core execution timing and state */
    operationsCore: FlowOperationsCore;

    /** Links to detailed action operation reports */
    relatedLinks: Record<string, string>;

    /** Output data from the action */
    operationsOutput: FlowOperationsData;

    /** Input data fed to the action */
    operationsInput: FlowOperationsData;

    /** Report record sys_id */
    reportId: string;
}

/** Full execution report for a flow context. */
export interface FlowExecutionReport {
    /** Flow snapshot sys_id */
    flowId: string;

    /** Whether domain separation is enabled on the instance */
    domainSeparationEnabled: boolean;

    /** Domain in which the flow executed */
    executionDomain: string;

    /** Per-action execution reports, keyed by action instance sys_id */
    actionOperationsReports: Record<string, FlowActionReport>;

    /** Per-subflow execution reports, keyed by subflow instance sys_id */
    subflowOperationsReports: Record<string, FlowActionReport>;

    /** Per-iteration execution reports (for loops) */
    iterationOperationsReports: Record<string, unknown>;

    /** Reference to the flow instance */
    instanceReference: string;

    /** Top-level execution timing and state */
    operationsCore: FlowOperationsCore;

    /** Links to related resources */
    relatedLinks: Record<string, string>;

    /** Flow-level output data */
    operationsOutput: FlowOperationsData;

    /** Flow-level input data (trigger inputs) */
    operationsInput: FlowOperationsData;

    /** Report record sys_id */
    reportId: string;
}

/** Execution source information from the flow context. */
export interface FlowExecutionSource {
    /** How the flow was triggered (e.g. "TEST_BUTTON", "RECORD_TRIGGER") */
    callingSource: string;

    /** Source table that triggered the flow (if record-triggered) */
    executionSourceTable: string;

    /** Source record sys_id */
    executionSourceRecord: string;

    /** Display value of the source record */
    executionSourceRecordDisplay: string;
}

/** High-level flow context metadata from the operations API. */
export interface FlowContextInfo {
    /** Parent flow sys_id */
    flowId: string;

    /** Flow name */
    name: string;

    /** Execution state: COMPLETE, IN_PROGRESS, WAITING, ERROR, CANCELLED, etc. */
    state: FlowContextState;

    /** Total runtime in milliseconds */
    runTime: string;

    /** Whether this was a test execution */
    isTestRun: boolean;

    /** User who executed the flow */
    executedAs: string;

    /** User who initiated the flow */
    flowInitiatedBy: string;

    /** Reporting level (e.g. "TRACE", "NONE") */
    reporting: string;

    /** Whether debug mode was enabled */
    debugMode: boolean;

    /** How the flow was triggered */
    executionSource: FlowExecutionSource;

    /** Whether operations view expansion is enabled */
    enableOpsViewExpansion: boolean;

    /** Flow retention policy candidate flag */
    flowRetentionPolicyCandidate: boolean;
}

/** Availability details for the flow execution report. */
export interface FlowReportAvailabilityDetails {
    /** Message about report availability (may be an error) */
    errorMessage: string;

    /** Severity level (e.g. "notification-danger", "notification-info") */
    errorLevel: string;

    /** Link text for the context record */
    linkMessage: string;

    /** URL to the context record */
    linkURL: string;
}

/** Result from getting detailed flow context via the operations API. */
export interface FlowContextDetailsResult {
    /** Whether the API call completed successfully */
    success: boolean;

    /** The context sys_id that was queried */
    contextId: string;

    /** High-level execution metadata */
    flowContext?: FlowContextInfo;

    /** Detailed execution report with per-action timing, inputs, outputs */
    flowReport?: FlowExecutionReport;

    /** Availability details for the execution report */
    flowReportAvailabilityDetails?: FlowReportAvailabilityDetails;

    /** Full flow definition snapshot (only if requested) */
    flowDefinition?: Record<string, unknown>;

    /** Error message if the API call failed */
    errorMessage?: string;

    /** The raw API response for advanced inspection */
    rawResponse?: unknown;
}

// ============================================================
// Flow Log Types (sys_flow_log Table API)
// ============================================================

/** Options for querying flow execution logs. */
export interface FlowLogOptions {
    /** Maximum number of log entries to return (default: 100) */
    limit?: number;

    /** Order direction: 'asc' or 'desc' (default: 'asc' by order) */
    orderDirection?: 'asc' | 'desc';
}

/** Individual flow log entry from sys_flow_log. */
export interface FlowLogEntry {
    /** Log entry sys_id */
    sysId: string;

    /** Log level (numeric string, e.g. "2" for info, "-1" for error) */
    level: string;

    /** Log message text */
    message: string;

    /** Dot-path reference to the flow action that generated the log */
    action: string;

    /** Operation type */
    operation: string;

    /** Execution order */
    order: string;

    /** When the log entry was created */
    createdOn: string;

    /** Who created the log entry */
    createdBy: string;
}

/** Result from querying flow execution logs. */
export interface FlowLogResult {
    /** Whether the query completed successfully */
    success: boolean;

    /** The context sys_id that was queried */
    contextId: string;

    /** Array of log entries */
    entries: FlowLogEntry[];

    /** Error message if the query failed */
    errorMessage?: string;

    /** The raw API response for advanced inspection */
    rawResponse?: unknown;
}

/**
 * JSON envelope structure returned by the ProcessFlow operations API
 * for flow context details.
 * @internal
 */
export interface FlowContextOperationsResponse {
    result: {
        flowContext: Record<string, unknown>;
        flow: Record<string, unknown>;
        flowReportAvailabilityDetails: FlowReportAvailabilityDetails;
        flowReport: Record<string, unknown>;
    };
}
