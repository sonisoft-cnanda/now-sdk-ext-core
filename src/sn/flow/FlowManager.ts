import { ServiceNowInstance } from "../ServiceNowInstance";
import { BackgroundScriptExecutor, BackgroundScriptExecutionResult } from "../BackgroundScriptExecutor";
import { Logger } from "../../util/Logger";
import {
    ExecuteFlowOptions,
    ExecuteFlowByNameOptions,
    ExecuteSubflowOptions,
    ExecuteActionOptions,
    FlowExecutionResult,
    FlowObjectType,
    FlowScriptResultEnvelope,
    FlowContextStatusResult,
    FlowOutputsResult,
    FlowErrorResult,
    FlowCancelResult,
    FlowSendMessageResult,
    FlowLifecycleEnvelope,
    FlowPublishResult,
    FlowPublishEnvelope,
    ResolvedFlowIdentifier,
    TestFlowOptions,
    FlowTestResult,
    FlowDefinitionResult,
    FlowActionResult,
    ProcessFlowApiResponse,
    ProcessFlowTestPayload,
    CopyFlowOptions,
    FlowCopyResult,
    FlowContextDetailsResult,
    FlowContextInfo,
    FlowExecutionReport,
    FlowReportAvailabilityDetails,
    FlowContextOperationsResponse,
    FlowLogOptions,
    FlowLogResult,
    FlowLogEntry,
    FlowOperationsCore,
    FlowOperationsData,
    FlowActionReport,
    FlowExecutionSource,
    FlowDefinitionOptions,
    FlowDesignArtifactType,
    FlowDefinitionFailureReason,
    FlowArtifactDefinitionResult,
    FlowArtifactSummary,
    ActionDefinitionResult,
    ActionDefinitionSummary,
    ActionStepSummary
} from './FlowModels';
import { TableAPIRequest } from '../../comm/http/TableAPIRequest';
import { ProcessFlowRequest } from '../../comm/http/ProcessFlowRequest';
import { IHttpResponse } from '../../comm/http/IHttpResponse';

const RESULT_MARKER = '___FLOW_EXEC_RESULT___';
const VALID_TYPES: FlowObjectType[] = ['flow', 'subflow', 'action'];

/** A ServiceNow sys_id: exactly 32 hex characters. */
const SYS_ID_PATTERN = /^[0-9a-f]{32}$/i;

/** Longest identifier echoed back in a validation message. */
const MAX_ECHOED_ID_LENGTH = 64;

/** The failure half of a definition result, shared by both result contracts. */
interface DefinitionFailure {
    errorMessage: string;
    failureReason: FlowDefinitionFailureReason;
    errorCode?: number;
}

/** Shape of a sys_flow_log record as returned by the Table API. */
interface FlowLogRecord {
    sys_id: string;
    level: string;
    message: string;
    action: string;
    operation: string;
    order: string;
    sys_created_on: string;
    sys_created_by: string;
}

/**
 * Provides operations for executing ServiceNow Flow Designer flows,
 * subflows, and actions remotely via BackgroundScriptExecutor.
 *
 * Uses the sn_fd.FlowAPI.getRunner() (ScriptableFlowRunner) API
 * on the server side to execute and capture results.
 */
export class FlowManager {
    private _logger: Logger = new Logger("FlowManager");
    private _bgExecutor: BackgroundScriptExecutor;
    private _instance: ServiceNowInstance;
    private _defaultScope: string;

    /**
     * @param instance ServiceNow instance connection
     * @param scope Default scope for script execution (default: "global")
     */
    public constructor(instance: ServiceNowInstance, scope: string = 'global') {
        this._instance = instance;
        this._defaultScope = scope;
        this._bgExecutor = new BackgroundScriptExecutor(instance, scope);
    }

    // ================================================================
    // Public API
    // ================================================================

    /** Execute any flow object (flow, subflow, or action). */
    public async execute(options: ExecuteFlowOptions): Promise<FlowExecutionResult> {
        if (!options.scopedName || options.scopedName.trim().length === 0) {
            throw new Error('Flow scoped name is required (e.g. "global.my_flow")');
        }
        if (!options.type) {
            throw new Error('Flow object type is required ("flow", "subflow", or "action")');
        }
        if (!VALID_TYPES.includes(options.type)) {
            throw new Error(`Invalid flow object type "${options.type}". Must be one of: ${VALID_TYPES.join(', ')}`);
        }

        this._logger.info(`Executing ${options.type}: ${options.scopedName}`);

        const script = this._buildFlowScript(options);
        const scope = options.scope || this._defaultScope;

        try {
            const bgResult = await this._bgExecutor.executeScript(script, scope, this._instance);
            const flowResult = this._parseFlowResult(bgResult, options);

            this._logger.info(`${options.type} execution complete: ${flowResult.success ? 'SUCCESS' : 'FAILED'}`);
            return flowResult;
        } catch (error) {
            const err = error as Error;
            this._logger.error(`Error executing ${options.type} "${options.scopedName}": ${err.message}`);
            return {
                success: false,
                flowObjectName: options.scopedName,
                flowObjectType: options.type,
                errorMessage: `Script execution error: ${err.message}`,
                rawScriptResult: null
            };
        }
    }

    /** Execute a flow by scoped name. */
    public async executeFlow(options: ExecuteFlowByNameOptions): Promise<FlowExecutionResult> {
        return this.execute({ ...options, type: 'flow' });
    }

    /** Execute a subflow by scoped name. */
    public async executeSubflow(options: ExecuteSubflowOptions): Promise<FlowExecutionResult> {
        return this.execute({ ...options, type: 'subflow' });
    }

    /** Execute an action by scoped name. */
    public async executeAction(options: ExecuteActionOptions): Promise<FlowExecutionResult> {
        return this.execute({ ...options, type: 'action' });
    }

    // ================================================================
    // Flow Context Lifecycle API
    // ================================================================

    /** Query the status of a flow context by its sys_id. */
    public async getFlowContextStatus(contextId: string): Promise<FlowContextStatusResult> {
        this._validateContextId(contextId);
        this._logger.info(`Getting context status: ${contextId}`);

        const script = this._buildContextStatusScript(contextId);
        try {
            const bgResult = await this._bgExecutor.executeScript(script, this._defaultScope, this._instance);
            const envelope = this._extractResultEnvelope(bgResult) as unknown as FlowLifecycleEnvelope | null;

            if (envelope) {
                return {
                    success: envelope.success,
                    contextId,
                    found: envelope.found ?? false,
                    state: envelope.state ?? undefined,
                    name: envelope.name ?? undefined,
                    started: envelope.started ?? undefined,
                    ended: envelope.ended ?? undefined,
                    errorMessage: envelope.errorMessage ?? undefined,
                    rawScriptResult: bgResult
                };
            }

            return {
                success: false, contextId, found: false,
                errorMessage: 'Could not parse context status result from script output.',
                rawScriptResult: bgResult
            };
        } catch (error) {
            const err = error as Error;
            return {
                success: false, contextId, found: false,
                errorMessage: `Script execution error: ${err.message}`,
                rawScriptResult: null
            };
        }
    }

    /** Retrieve outputs from a completed flow/subflow/action by context ID. */
    public async getFlowOutputs(contextId: string): Promise<FlowOutputsResult> {
        this._validateContextId(contextId);
        this._logger.info(`Getting outputs for context: ${contextId}`);

        const script = this._buildGetOutputsScript(contextId);
        try {
            const bgResult = await this._bgExecutor.executeScript(script, this._defaultScope, this._instance);
            const envelope = this._extractResultEnvelope(bgResult) as unknown as FlowLifecycleEnvelope | null;

            if (envelope) {
                return {
                    success: envelope.success,
                    contextId,
                    outputs: envelope.outputs ?? undefined,
                    errorMessage: envelope.errorMessage ?? undefined,
                    rawScriptResult: bgResult
                };
            }

            return {
                success: false, contextId,
                errorMessage: 'Could not parse outputs result from script output.',
                rawScriptResult: bgResult
            };
        } catch (error) {
            const err = error as Error;
            return {
                success: false, contextId,
                errorMessage: `Script execution error: ${err.message}`,
                rawScriptResult: null
            };
        }
    }

    /** Retrieve error messages from a flow/subflow/action by context ID. */
    public async getFlowError(contextId: string): Promise<FlowErrorResult> {
        this._validateContextId(contextId);
        this._logger.info(`Getting error for context: ${contextId}`);

        const script = this._buildGetErrorScript(contextId);
        try {
            const bgResult = await this._bgExecutor.executeScript(script, this._defaultScope, this._instance);
            const envelope = this._extractResultEnvelope(bgResult) as unknown as FlowLifecycleEnvelope | null;

            if (envelope) {
                return {
                    success: envelope.success,
                    contextId,
                    flowErrorMessage: envelope.flowErrorMessage ?? undefined,
                    errorMessage: envelope.errorMessage ?? undefined,
                    rawScriptResult: bgResult
                };
            }

            return {
                success: false, contextId,
                errorMessage: 'Could not parse error result from script output.',
                rawScriptResult: bgResult
            };
        } catch (error) {
            const err = error as Error;
            return {
                success: false, contextId,
                errorMessage: `Script execution error: ${err.message}`,
                rawScriptResult: null
            };
        }
    }

    /** Cancel a running or paused flow/subflow/action. */
    public async cancelFlow(contextId: string, reason?: string): Promise<FlowCancelResult> {
        this._validateContextId(contextId);
        this._logger.info(`Cancelling context: ${contextId}`);

        const script = this._buildCancelScript(contextId, reason || 'Cancelled via FlowManager');
        try {
            const bgResult = await this._bgExecutor.executeScript(script, this._defaultScope, this._instance);
            const envelope = this._extractResultEnvelope(bgResult) as unknown as FlowLifecycleEnvelope | null;

            if (envelope) {
                return {
                    success: envelope.success,
                    contextId,
                    errorMessage: envelope.errorMessage ?? undefined,
                    rawScriptResult: bgResult
                };
            }

            return {
                success: false, contextId,
                errorMessage: 'Could not parse cancel result from script output.',
                rawScriptResult: bgResult
            };
        } catch (error) {
            const err = error as Error;
            return {
                success: false, contextId,
                errorMessage: `Script execution error: ${err.message}`,
                rawScriptResult: null
            };
        }
    }

    /** Send a message to a paused flow to resume it (for Wait for Message actions). */
    public async sendFlowMessage(contextId: string, message: string, payload?: string): Promise<FlowSendMessageResult> {
        this._validateContextId(contextId);
        if (!message || message.trim().length === 0) {
            throw new Error('Message is required');
        }
        this._logger.info(`Sending message to context: ${contextId}`);

        const script = this._buildSendMessageScript(contextId, message, payload || '');
        try {
            const bgResult = await this._bgExecutor.executeScript(script, this._defaultScope, this._instance);
            const envelope = this._extractResultEnvelope(bgResult) as unknown as FlowLifecycleEnvelope | null;

            if (envelope) {
                return {
                    success: envelope.success,
                    contextId,
                    errorMessage: envelope.errorMessage ?? undefined,
                    rawScriptResult: bgResult
                };
            }

            return {
                success: false, contextId,
                errorMessage: 'Could not parse send message result from script output.',
                rawScriptResult: bgResult
            };
        } catch (error) {
            const err = error as Error;
            return {
                success: false, contextId,
                errorMessage: `Script execution error: ${err.message}`,
                rawScriptResult: null
            };
        }
    }

    // ================================================================
    // Flow Publishing API
    // ================================================================

    /**
     * Publish a flow so it can be executed.
     * Flows deployed via the ServiceNow SDK land in an unpublished/draft state
     * and must be published before they can be run.
     *
     * @param flowIdentifier Either a sys_id (32-char hex) or scoped_name (e.g. "x_myapp.my_flow")
     * @param scope Optional scope context for BackgroundScriptExecutor
     * @returns FlowPublishResult with success/failure status
     */
    public async publishFlow(flowIdentifier: string, scope?: string): Promise<FlowPublishResult> {
        if (!flowIdentifier || flowIdentifier.trim().length === 0) {
            throw new Error('Flow identifier is required (sys_id or scoped_name)');
        }

        this._logger.info(`Publishing flow: ${flowIdentifier}`);

        let resolved: ResolvedFlowIdentifier;
        try {
            resolved = await this._resolveFlowIdentifier(flowIdentifier);
        } catch (error) {
            const err = error as Error;
            return {
                success: false,
                flowName: flowIdentifier,
                flowSysId: '',
                errorMessage: err.message
            };
        }

        const script = this._buildPublishScript(resolved.sysId);
        const execScope = scope || this._defaultScope;

        try {
            const bgResult = await this._bgExecutor.executeScript(script, execScope, this._instance);
            const envelope = this._extractResultEnvelope(bgResult) as unknown as FlowPublishEnvelope | null;

            if (envelope) {
                return {
                    success: envelope.success,
                    flowName: resolved.name,
                    flowSysId: resolved.sysId,
                    errorMessage: envelope.errorMessage ?? undefined,
                    rawScriptResult: bgResult
                };
            }

            return {
                success: false,
                flowName: resolved.name,
                flowSysId: resolved.sysId,
                errorMessage: 'Could not parse publish result from script output.',
                rawScriptResult: bgResult
            };
        } catch (error) {
            const err = error as Error;
            return {
                success: false,
                flowName: resolved.name,
                flowSysId: resolved.sysId,
                errorMessage: `Script execution error: ${err.message}`
            };
        }
    }

    /**
     * Resolve a flow identifier (sys_id or scoped_name) to both sys_id and name
     * by querying the sys_hub_flow table.
     */
    private async _resolveFlowIdentifier(identifier: string): Promise<ResolvedFlowIdentifier> {
        const trimmed = identifier.trim();
        const isSysId = /^[0-9a-f]{32}$/i.test(trimmed);

        // Validate scoped name format to prevent query injection via ^ or other GlideRecord operators
        if (!isSysId && !/^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$/.test(trimmed)) {
            throw new Error(`Invalid flow identifier format: "${trimmed}". Expected a 32-char hex sys_id or scoped name (e.g. "global.my_flow").`);
        }

        interface FlowRecord { sys_id: string; internal_name: string; name: string }

        const tableRequest = new TableAPIRequest(this._instance);
        const queryField = isSysId ? 'sys_id' : 'internal_name';

        const response = await tableRequest.get<{ result: FlowRecord[] }>('sys_hub_flow', {
            sysparm_query: `${queryField}=${trimmed}`,
            sysparm_fields: 'sys_id,internal_name,name',
            sysparm_limit: '1'
        });

        // TableAPIRequest may return the result array under data.result (Axios-style)
        // or bodyObject.result (RequestHandler-style) depending on the HTTP layer used.
        const records = (response as any)?.data?.result ?? (response as any)?.bodyObject?.result;
        if (!records || records.length === 0) {
            throw new Error(`Flow not found: no sys_hub_flow record matches ${queryField}="${trimmed}"`);
        }

        const record = records[0];
        return {
            sysId: record.sys_id,
            name: record.internal_name || record.name || trimmed
        };
    }

    // ================================================================
    // Test Flow API (ProcessFlow REST)
    // ================================================================

    /**
     * Fetch a flow definition from the ProcessFlow REST API.
     *
     * Retained unchanged for existing callers. It reports neither the artifact
     * type nor a machine-readable failure reason, and it throws (rather than
     * returning a failure) for a blank sys_id.
     *
     * @see getFlowArtifactDefinition for the typed, non-throwing replacement.
     *
     * @param flowSysId The sys_id of the flow to fetch
     * @param scope Optional scope sys_id for the transaction scope query parameter
     * @returns FlowDefinitionResult containing the raw flow definition object
     */
    public async getFlowDefinition(flowSysId: string, scope?: string): Promise<FlowDefinitionResult> {
        if (!flowSysId || flowSysId.trim().length === 0) {
            throw new Error('Flow sys_id is required');
        }

        this._logger.info(`Fetching flow definition: ${flowSysId}`);

        const pfr = new ProcessFlowRequest(this._instance);
        const query = scope ? { sysparm_transaction_scope: scope } : undefined;

        try {
            const response = await pfr.get<ProcessFlowApiResponse>(
                'flow/{flow_sys_id}',
                { flow_sys_id: flowSysId },
                query
            );

            const apiResult = this._extractProcessFlowResult(response);

            if ((apiResult.errorCode != null && apiResult.errorCode !== 0) || (apiResult.errorCode == null && apiResult.errorMessage)) {
                return {
                    success: false,
                    errorMessage: apiResult.errorMessage || 'Unknown error from processflow API',
                    rawResponse: apiResult
                };
            }

            const definition = apiResult.data as Record<string, unknown>;
            if (!definition || typeof definition !== 'object') {
                return {
                    success: false,
                    errorMessage: 'ProcessFlow API returned no flow definition data',
                    rawResponse: apiResult
                };
            }

            this._logger.info(`Flow definition fetched: ${String(definition['name'] ?? flowSysId)}`);
            return {
                success: true,
                definition,
                rawResponse: apiResult
            };
        } catch (error) {
            const err = error as Error;
            this._logger.error(`Error fetching flow definition "${flowSysId}": ${err.message}`);
            return {
                success: false,
                errorMessage: `Failed to fetch flow definition: ${err.message}`
            };
        }
    }

    /**
     * Fetch an action's step instances from the ProcessFlow REST API.
     *
     * Calls `GET /api/now/processflow/action/action_types/{action_sys_id}/step_instances`.
     * Despite the name this returns only the ordered steps — never the action's
     * own metadata — so it cannot describe an action on its own.
     *
     * @deprecated Use {@link getActionDefinition}, which returns action metadata
     * and step instances through one contract. This method keeps working and its
     * signature is unchanged; it will be removed no earlier than the next major.
     *
     * @param actionSysId The sys_id of the action (action type) to fetch
     * @param scope Optional scope sys_id for the transaction scope query parameter
     * @returns FlowActionResult containing the raw step instance data
     */
    public async getFlowActions(actionSysId: string, scope?: string): Promise<FlowActionResult> {
        if (!actionSysId || actionSysId.trim().length === 0) {
            throw new Error('Action sys_id is required');
        }

        this._logger.info(`Fetching flow action: ${actionSysId}`);

        const pfr = new ProcessFlowRequest(this._instance);
        const query = scope ? { sysparm_transaction_scope: scope } : undefined;

        try {
            const response = await pfr.get<ProcessFlowApiResponse>(
                'action/action_types/{action_sys_id}/step_instances',
                { action_sys_id: actionSysId },
                query
            );

            const apiResult = this._extractProcessFlowResult(response);

            if ((apiResult.errorCode != null && apiResult.errorCode !== 0) || (apiResult.errorCode == null && apiResult.errorMessage)) {
                return {
                    success: false,
                    errorMessage: apiResult.errorMessage || 'Unknown error from processflow API',
                    rawResponse: apiResult
                };
            }

            const action = apiResult.steps as Record<string, unknown> | unknown[];
            if (action == null || (typeof action !== 'object')) {
                return {
                    success: false,
                    errorMessage: 'ProcessFlow API returned no action data',
                    rawResponse: apiResult
                };
            }

            this._logger.info(`Flow action fetched: ${actionSysId}`);
            return {
                success: true,
                action,
                rawResponse: apiResult
            };
        } catch (error) {
            const err = error as Error;
            this._logger.error(`Error fetching flow action "${actionSysId}": ${err.message}`);
            return {
                success: false,
                errorMessage: `Failed to fetch flow action: ${err.message}`
            };
        }
    }

    // ================================================================
    // Design-Time Definition API (ProcessFlow REST, read-only)
    //
    // These operations only ever issue GETs to the ProcessFlow definition
    // routes. They do not execute, test, copy, publish or otherwise mutate an
    // artifact, they never touch BackgroundScriptExecutor, and they neither
    // accept nor create a flow context.
    // ================================================================

    /**
     * Retrieve the design-time definition of a flow **or** a subflow.
     *
     * Both are served by `GET /api/now/processflow/flow/{sys_id}` and are told
     * apart by the `type` ServiceNow reports, which is echoed back verbatim on
     * `reportedType` — the type is never inferred from the call site.
     *
     * The returned `definition` is the untouched payload and is safe to pass
     * straight to `JSON.stringify`.
     *
     * @param sysId sys_id of the flow or subflow
     * @param options Optional scope for the transaction scope query parameter
     */
    public getFlowArtifactDefinition(sysId: string, options?: FlowDefinitionOptions): Promise<FlowArtifactDefinitionResult> {
        return this._fetchFlowArtifactDefinition(sysId, options);
    }

    /**
     * Retrieve the design-time definition of a flow.
     *
     * Fails with `failureReason: 'type_mismatch'` when the sys_id belongs to a
     * subflow (or anything else) rather than silently relabelling it.
     *
     * @param flowSysId sys_id of the flow
     * @param options Optional scope for the transaction scope query parameter
     */
    public getFlowDesignDefinition(flowSysId: string, options?: FlowDefinitionOptions): Promise<FlowArtifactDefinitionResult> {
        return this._fetchFlowArtifactDefinition(flowSysId, options, 'flow');
    }

    /**
     * Retrieve the design-time definition of a subflow, including its inputs,
     * outputs, actions, nested subflows and flow logic.
     *
     * Fails with `failureReason: 'type_mismatch'` when the sys_id belongs to a
     * flow rather than silently relabelling it.
     *
     * @param subflowSysId sys_id of the subflow
     * @param options Optional scope for the transaction scope query parameter
     */
    public getSubflowDefinition(subflowSysId: string, options?: FlowDefinitionOptions): Promise<FlowArtifactDefinitionResult> {
        return this._fetchFlowArtifactDefinition(subflowSysId, options, 'subflow');
    }

    /**
     * Retrieve a complete action definition: metadata plus ordered steps.
     *
     * A complete action needs two reads — `action/action_types/{id}` for the
     * metadata and `action/action_types/{id}/step_instances` for the steps —
     * which are composed into one result. `success` is true only when both
     * parts were retrieved; a partial read is reported as a failure rather than
     * as an action with no steps.
     *
     * `metadata` and `steps` are the untouched payloads and are safe to pass
     * straight to `JSON.stringify`.
     *
     * @param actionSysId sys_id of the action type
     * @param options Optional scope for the transaction scope query parameter
     */
    public async getActionDefinition(actionSysId: string, options?: FlowDefinitionOptions): Promise<ActionDefinitionResult> {
        const sysId = this._normalizeDefinitionSysId(actionSysId);

        const invalid = this._validateDefinitionSysId(sysId, 'action');
        if (invalid) {
            return { success: false, sysId, ...invalid };
        }

        this._logger.info(`Fetching action definition: ${sysId}`);

        const pfr = new ProcessFlowRequest(this._instance);
        const query = options?.scope ? { sysparm_transaction_scope: options.scope } : undefined;

        let metadataResult: Record<string, unknown> | undefined;
        try {
            const response = await pfr.get<unknown>(
                'action/action_types/{action_sys_id}',
                { action_sys_id: sysId },
                query
            );
            metadataResult = this._readProcessFlowResult(response);
        } catch (error) {
            return { success: false, sysId, ...this._classifyRequestFailure(error, 'action definition') };
        }

        if (!metadataResult) {
            return { success: false, sysId, ...this._malformedResponse('action definition', sysId, 'did not contain a result object') };
        }

        const metadataError = this._readApiError(metadataResult);
        if (metadataError) {
            return { success: false, sysId, ...metadataError };
        }

        // The action-type route returns the record directly under `result`;
        // other processflow routes wrap their payload in `result.data`. Accept
        // either so a family upgrade that starts wrapping does not break this.
        const metadata = this._asRecord(metadataResult['data']) ?? metadataResult;

        if (Object.keys(metadata).length === 0) {
            return {
                success: false,
                sysId,
                failureReason: 'not_found',
                errorMessage: `No action definition found for sys_id "${sysId}".`
            };
        }

        // Guard against an action operation quietly describing a flow artifact.
        const reportedType = this._stringField(metadata, 'type').trim();
        if (reportedType === 'flow' || reportedType === 'subflow') {
            return {
                success: false,
                sysId,
                failureReason: 'type_mismatch',
                errorMessage: `Expected sys_id "${sysId}" to be an action, but ServiceNow reports it as "${reportedType}".`
            };
        }

        let stepsResult: Record<string, unknown> | undefined;
        try {
            const response = await pfr.get<unknown>(
                'action/action_types/{action_sys_id}/step_instances',
                { action_sys_id: sysId },
                query
            );
            stepsResult = this._readProcessFlowResult(response);
        } catch (error) {
            return { success: false, sysId, ...this._classifyRequestFailure(error, 'action step instances') };
        }

        if (!stepsResult) {
            return { success: false, sysId, ...this._malformedResponse('action step instances', sysId, 'did not contain a result object') };
        }

        const stepsError = this._readApiError(stepsResult);
        if (stepsError) {
            return { success: false, sysId, ...stepsError };
        }

        const rawSteps = stepsResult['steps'];
        if (!Array.isArray(rawSteps)) {
            return { success: false, sysId, ...this._malformedResponse('action step instances', sysId, 'did not contain a steps array') };
        }

        const steps = this._sortActionSteps(
            rawSteps
                .map((step) => this._asRecord(step))
                .filter((step): step is Record<string, unknown> => step !== undefined)
        );

        this._logger.info(`Action definition fetched: ${sysId} (${steps.length} steps)`);

        return {
            success: true,
            sysId,
            artifactType: 'action',
            metadata,
            steps,
            summary: this._buildActionSummary(sysId, metadata, steps)
        };
    }

    /**
     * Shared retrieval for flow and subflow definitions.
     *
     * @param sysId sys_id of the artifact
     * @param options Optional scope
     * @param expectedType When set, the reported type must match it exactly
     * @internal
     */
    private async _fetchFlowArtifactDefinition(
        sysId: string,
        options?: FlowDefinitionOptions,
        expectedType?: FlowDesignArtifactType
    ): Promise<FlowArtifactDefinitionResult> {
        const trimmed = this._normalizeDefinitionSysId(sysId);
        const label = expectedType ?? 'flow or subflow';

        const invalid = this._validateDefinitionSysId(trimmed, label);
        if (invalid) {
            return { success: false, sysId: trimmed, ...invalid };
        }

        this._logger.info(`Fetching ${label} definition: ${trimmed}`);

        let apiResult: Record<string, unknown> | undefined;
        try {
            const response = await new ProcessFlowRequest(this._instance).get<unknown>(
                'flow/{flow_sys_id}',
                { flow_sys_id: trimmed },
                options?.scope ? { sysparm_transaction_scope: options.scope } : undefined
            );
            apiResult = this._readProcessFlowResult(response);
        } catch (error) {
            return { success: false, sysId: trimmed, ...this._classifyRequestFailure(error, `${label} definition`) };
        }

        if (!apiResult) {
            return { success: false, sysId: trimmed, ...this._malformedResponse(`${label} definition`, trimmed, 'did not contain a result object') };
        }

        const apiError = this._readApiError(apiResult);
        if (apiError) {
            return { success: false, sysId: trimmed, ...apiError };
        }

        const definition = this._asRecord(apiResult['data']);
        if (!definition || Object.keys(definition).length === 0) {
            return {
                success: false,
                sysId: trimmed,
                failureReason: 'not_found',
                errorMessage: `No ${label} definition found for sys_id "${trimmed}".`
            };
        }

        const reportedType = this._stringField(definition, 'type').trim();
        if (reportedType.length === 0) {
            return { success: false, sysId: trimmed, ...this._malformedResponse(`${label} definition`, trimmed, 'does not identify its artifact type') };
        }

        if (expectedType && reportedType !== expectedType) {
            return {
                success: false,
                sysId: trimmed,
                reportedType,
                failureReason: 'type_mismatch',
                errorMessage: `Expected sys_id "${trimmed}" to be a ${expectedType}, but ServiceNow reports it as "${reportedType}".`
            };
        }

        this._logger.info(`Fetched ${reportedType} definition: ${trimmed}`);

        return {
            success: true,
            sysId: trimmed,
            // Only set when ServiceNow reported a type this library knows. An
            // unrecognised type is surfaced on reportedType rather than mapped
            // onto the nearest known one.
            artifactType: reportedType === 'flow' || reportedType === 'subflow' ? reportedType : undefined,
            reportedType,
            definition,
            summary: this._buildFlowArtifactSummary(trimmed, definition)
        };
    }

    // ================================================================
    // Design-Time Definition Helpers
    // ================================================================

    /** Trim an incoming identifier, tolerating a non-string from JS callers. @internal */
    private _normalizeDefinitionSysId(sysId: string): string {
        return typeof sysId === 'string' ? sysId.trim() : '';
    }

    /** Validate a definition sys_id, returning a failure when it is unusable. @internal */
    private _validateDefinitionSysId(sysId: string, label: string): DefinitionFailure | undefined {
        if (sysId.length === 0) {
            return {
                failureReason: 'invalid_identifier',
                errorMessage: `A ${label} sys_id is required.`
            };
        }
        if (!SYS_ID_PATTERN.test(sysId)) {
            return {
                failureReason: 'invalid_identifier',
                errorMessage: `Invalid ${label} sys_id "${sysId.substring(0, MAX_ECHOED_ID_LENGTH)}". Expected a 32-character hex sys_id.`
            };
        }
        return undefined;
    }

    /** Build a consistent malformed-wrapper failure. @internal */
    private _malformedResponse(label: string, sysId: string, problem: string): DefinitionFailure {
        return {
            failureReason: 'malformed_response',
            errorMessage: `ProcessFlow API response for ${label} "${sysId}" ${problem}.`
        };
    }

    /**
     * Read `result` out of a processflow response, tolerating both the
     * Axios-style (`data.result`) and RequestHandler-style (`bodyObject.result`)
     * shapes. Returns undefined instead of throwing so a malformed wrapper can
     * be reported as a typed failure.
     * @internal
     */
    private _readProcessFlowResult(response: IHttpResponse<unknown> | null | undefined): Record<string, unknown> | undefined {
        if (!response) {
            return undefined;
        }
        const fromData = this._asRecord(response.data)?.['result'];
        const fromBody = this._asRecord(response.bodyObject)?.['result'];
        return this._asRecord(fromData ?? fromBody);
    }

    /**
     * Detect an error reported inside a processflow result envelope. Mirrors the
     * semantics the existing definition/test/copy calls already use: a non-zero
     * errorCode is an error, and so is a message with no code at all.
     * @internal
     */
    private _readApiError(result: Record<string, unknown>): DefinitionFailure | undefined {
        const rawCode = result['errorCode'];
        const errorCode = typeof rawCode === 'number' ? rawCode : undefined;
        const errorMessage = this._stringField(result, 'errorMessage').trim();

        if (errorCode !== undefined && errorCode !== 0) {
            return {
                failureReason: 'api_error',
                errorCode,
                errorMessage: errorMessage || `ProcessFlow API reported error code ${errorCode}.`
            };
        }
        if (errorCode === undefined && errorMessage.length > 0) {
            return { failureReason: 'api_error', errorMessage };
        }
        return undefined;
    }

    /**
     * Turn a thrown request error into a typed failure.
     *
     * RequestHandler throws `Error during request. Status: <n> Body: <body>` for
     * any non-2xx, so the status is recovered from the message. The body is
     * dropped deliberately — it can carry record data, and it must not travel
     * back to the caller or into a log line.
     * @internal
     */
    private _classifyRequestFailure(error: unknown, label: string): DefinitionFailure {
        const message = error instanceof Error ? error.message : '';
        const statusMatch = /Status:\s*(\d{3})/.exec(message);
        const status = statusMatch ? Number(statusMatch[1]) : undefined;

        if (status === 401 || status === 403) {
            return {
                failureReason: 'permission_denied',
                errorMessage: `Not permitted to read the ${label} (HTTP ${status}).`
            };
        }
        if (status === 404) {
            return {
                failureReason: 'not_found',
                errorMessage: `ServiceNow has no ${label} for the supplied sys_id (HTTP 404).`
            };
        }
        if (status !== undefined) {
            return {
                failureReason: 'request_failed',
                errorMessage: `ServiceNow returned HTTP ${status} for the ${label} request.`
            };
        }

        const detail = message.length > 0 ? `: ${this._summarizeErrorText(message)}` : '.';
        return {
            failureReason: 'request_failed',
            errorMessage: `Failed to fetch the ${label}${detail}`
        };
    }

    /** Trim a transport error message down to something safe to surface. @internal */
    private _summarizeErrorText(message: string): string {
        const bodyIndex = message.indexOf(' Body:');
        const withoutBody = bodyIndex >= 0 ? message.substring(0, bodyIndex) : message;
        return withoutBody.length > 200 ? `${withoutBody.substring(0, 200)}…` : withoutBody;
    }

    /** Narrow an unknown to a plain object. @internal */
    private _asRecord(value: unknown): Record<string, unknown> | undefined {
        return value !== null && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined;
    }

    /** Read a string field, defaulting to '' for anything else. @internal */
    private _stringField(source: Record<string, unknown>, key: string): string {
        const value = source[key];
        return typeof value === 'string' ? value : '';
    }

    /** Read an array field's length, defaulting to 0 for anything else. @internal */
    private _countField(source: Record<string, unknown>, key: string): number {
        const value = source[key];
        return Array.isArray(value) ? value.length : 0;
    }

    /** Project the commonly used fields of a flow/subflow definition. @internal */
    private _buildFlowArtifactSummary(sysId: string, definition: Record<string, unknown>): FlowArtifactSummary {
        return {
            sysId: this._stringField(definition, 'id') || sysId,
            name: this._stringField(definition, 'name'),
            internalName: this._stringField(definition, 'internalName'),
            description: this._stringField(definition, 'description'),
            scope: this._stringField(definition, 'scope'),
            scopeName: this._stringField(definition, 'scopeName'),
            status: this._stringField(definition, 'status'),
            active: definition['active'] === true,
            triggerCount: this._countField(definition, 'triggerInstances'),
            actionCount: this._countField(definition, 'actionInstances'),
            subflowCount: this._countField(definition, 'subFlowInstances'),
            flowLogicCount: this._countField(definition, 'flowLogicInstances'),
            inputCount: this._countField(definition, 'inputs'),
            outputCount: this._countField(definition, 'outputs')
        };
    }

    /** Project the commonly used fields of an action definition. @internal */
    private _buildActionSummary(
        sysId: string,
        metadata: Record<string, unknown>,
        steps: Array<Record<string, unknown>>
    ): ActionDefinitionSummary {
        const stepSummaries: ActionStepSummary[] = steps.map((step) => ({
            stepId: this._stringField(step, 'step_id'),
            order: this._stepOrder(step),
            label: this._stringField(step, 'label'),
            stepTypeName: this._stringField(step, 'step_type_name'),
            stepTypeId: this._stringField(step, 'step_type_id')
        }));

        return {
            sysId: this._stringField(metadata, 'id') || sysId,
            name: this._stringField(metadata, 'name'),
            internalName: this._stringField(metadata, 'internal_name'),
            description: this._stringField(metadata, 'description'),
            scope: this._stringField(metadata, 'scope'),
            scopeName: this._stringField(metadata, 'scopename'),
            state: this._stringField(metadata, 'state'),
            active: metadata['active'] === true,
            inputCount: this._countField(metadata, 'inputs'),
            outputCount: this._countField(metadata, 'outputs'),
            stepCount: steps.length,
            steps: stepSummaries
        };
    }

    /**
     * Sort step instances ascending by `order`, keeping the API's own ordering
     * as the tie-break so a missing or non-numeric order never reshuffles steps.
     * @internal
     */
    private _sortActionSteps(steps: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
        return steps
            .map((step, index) => ({ step, index, order: this._stepOrder(step) }))
            .sort((a, b) => a.order - b.order || a.index - b.index)
            .map((entry) => entry.step);
    }

    /** Read a step's execution order; unusable values sort last. @internal */
    private _stepOrder(step: Record<string, unknown>): number {
        const raw = step['order'];
        if (typeof raw === 'number' && Number.isFinite(raw)) {
            return raw;
        }
        if (typeof raw === 'string' && raw.trim().length > 0) {
            const parsed = Number(raw);
            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }
        return Number.MAX_SAFE_INTEGER;
    }

    /**
     * Test a flow as if running it from Flow Designer, without requiring it to be published.
     *
     * This uses the ProcessFlow REST API (`POST /api/now/processflow/flow/{id}/test`)
     * rather than the scripted FlowAPI.getRunner() approach used by the execute*() methods.
     *
     * The method fetches the full flow definition from the instance, combines it with
     * the provided outputMap (trigger test values), and submits it to the test endpoint.
     *
     * @param options Test flow options including flowId, outputMap, and optional scope/runOnThread
     * @returns FlowTestResult with the execution context sys_id on success
     */
    public async testFlow(options: TestFlowOptions): Promise<FlowTestResult> {
        if (!options.flowId || options.flowId.trim().length === 0) {
            throw new Error('Flow identifier is required (sys_id or scoped_name)');
        }
        if (!options.outputMap || typeof options.outputMap !== 'object') {
            throw new Error('outputMap is required (maps trigger output variables to test values)');
        }

        this._logger.info(`Testing flow: ${options.flowId}`);

        // Step 1: Resolve identifier to sys_id
        let resolved: ResolvedFlowIdentifier;
        try {
            resolved = await this._resolveFlowIdentifier(options.flowId);
        } catch (error) {
            const err = error as Error;
            return {
                success: false,
                errorMessage: err.message
            };
        }

        // Step 2: Fetch the flow definition
        const defResult = await this.getFlowDefinition(resolved.sysId, options.scope);
        if (!defResult.success || !defResult.definition) {
            return {
                success: false,
                errorMessage: defResult.errorMessage || 'Failed to fetch flow definition'
            };
        }

        // Step 3: Determine the scope for the transaction
        const transactionScope = options.scope || (defResult.definition.scope as string) || undefined;

        // Step 4: Build and send the test payload
        const payload: ProcessFlowTestPayload = {
            flow: defResult.definition,
            outputMap: options.outputMap,
            runOnThread: options.runOnThread !== undefined ? options.runOnThread : true
        };

        const pfr = new ProcessFlowRequest(this._instance);
        const query = transactionScope ? { sysparm_transaction_scope: transactionScope } : undefined;

        try {
            const response = await pfr.post<ProcessFlowApiResponse>(
                'flow/{flow_sys_id}/test',
                { flow_sys_id: resolved.sysId },
                query,
                payload
            );

            const apiResult = this._extractProcessFlowResult(response);

            if ((apiResult.errorCode != null && apiResult.errorCode !== 0) || (apiResult.errorCode == null && apiResult.errorMessage)) {
                this._logger.error(`Test flow failed: ${apiResult.errorMessage}`);
                return {
                    success: false,
                    errorMessage: apiResult.errorMessage || 'Unknown error from processflow test API',
                    errorCode: apiResult.errorCode,
                    rawResponse: apiResult
                };
            }

            const contextId = apiResult.data as string;
            this._logger.info(`Flow test started, context: ${contextId}`);

            return {
                success: true,
                contextId,
                errorCode: 0,
                rawResponse: apiResult
            };
        } catch (error) {
            const err = error as Error;
            this._logger.error(`Error testing flow "${options.flowId}": ${err.message}`);
            return {
                success: false,
                errorMessage: `Failed to test flow: ${err.message}`
            };
        }
    }

    /**
     * Copy an existing flow into a target scoped application.
     *
     * This uses the ProcessFlow REST API (`POST /api/now/processflow/flow/{id}/copy`)
     * to create a duplicate of a flow in a specified scope. The copied flow lands in
     * draft/unpublished state and can then be modified, tested, and published.
     *
     * @param options Copy flow options including sourceFlowId, name, and targetScope
     * @returns FlowCopyResult with the new flow's sys_id on success
     */
    public async copyFlow(options: CopyFlowOptions): Promise<FlowCopyResult> {
        if (!options.sourceFlowId || options.sourceFlowId.trim().length === 0) {
            throw new Error('Source flow identifier is required (sys_id or scoped_name)');
        }
        if (!options.name || options.name.trim().length === 0) {
            throw new Error('Name is required for the copied flow');
        }
        if (!options.targetScope || options.targetScope.trim().length === 0) {
            throw new Error('Target scope sys_id is required');
        }

        this._logger.info(`Copying flow "${options.sourceFlowId}" as "${options.name}" into scope ${options.targetScope}`);

        // Resolve source flow identifier to sys_id
        let resolved: ResolvedFlowIdentifier;
        try {
            resolved = await this._resolveFlowIdentifier(options.sourceFlowId);
        } catch (error) {
            const err = error as Error;
            return {
                success: false,
                errorMessage: err.message
            };
        }

        const pfr = new ProcessFlowRequest(this._instance);
        const query = { sysparm_transaction_scope: options.targetScope };
        const payload = { name: options.name, scope: options.targetScope };

        try {
            const response = await pfr.post<ProcessFlowApiResponse>(
                'flow/{flow_sys_id}/copy',
                { flow_sys_id: resolved.sysId },
                query,
                payload
            );

            const apiResult = this._extractProcessFlowResult(response);

            if ((apiResult.errorCode != null && apiResult.errorCode !== 0) || (apiResult.errorCode == null && apiResult.errorMessage)) {
                this._logger.error(`Copy flow failed: ${apiResult.errorMessage}`);
                return {
                    success: false,
                    errorMessage: apiResult.errorMessage || 'Unknown error from processflow copy API',
                    errorCode: apiResult.errorCode,
                    rawResponse: apiResult
                };
            }

            const newFlowSysId = apiResult.data as string;
            if (!newFlowSysId || typeof newFlowSysId !== 'string' || newFlowSysId.trim().length === 0) {
                return {
                    success: false,
                    errorMessage: 'ProcessFlow copy API returned no flow sys_id',
                    rawResponse: apiResult
                };
            }

            this._logger.info(`Flow copied successfully, new sys_id: ${newFlowSysId}`);

            return {
                success: true,
                newFlowSysId,
                errorCode: 0,
                rawResponse: apiResult
            };
        } catch (error) {
            const err = error as Error;
            this._logger.error(`Error copying flow "${options.sourceFlowId}": ${err.message}`);
            return {
                success: false,
                errorMessage: `Failed to copy flow: ${err.message}`,
                rawResponse: null
            };
        }
    }

    // ================================================================
    // Flow Context Details API (ProcessFlow Operations)
    // ================================================================

    /**
     * Get detailed flow execution context via the ProcessFlow operations API.
     *
     * Returns rich execution data including per-action timing, inputs, outputs,
     * execution metadata (who ran it, test vs production, runtime, etc.), and
     * optionally the full flow definition snapshot.
     *
     * This uses `GET /api/now/processflow/operations/flow/context/{id}` which is
     * the same endpoint Flow Designer uses to display execution details.
     *
     * Note: The execution report (`flowReport`) requires operations view / flow
     * logging to be enabled. If not available, `flowReportAvailabilityDetails`
     * will contain information about why.
     *
     * @param contextId The sys_id of the flow context (from sys_flow_context)
     * @param scope Optional scope sys_id for the transaction scope query parameter
     * @param includeFlowDefinition Whether to include the full flow definition snapshot (default: false)
     * @returns FlowContextDetailsResult with execution context and report
     */
    public async getFlowContextDetails(
        contextId: string,
        scope?: string,
        includeFlowDefinition: boolean = false
    ): Promise<FlowContextDetailsResult> {
        this._validateContextId(contextId);
        this._logger.info(`Getting flow context details: ${contextId}`);

        const pfr = new ProcessFlowRequest(this._instance);
        const query = scope ? { sysparm_transaction_scope: scope } : undefined;

        try {
            const response = await pfr.get<FlowContextOperationsResponse>(
                'operations/flow/context/{context_id}',
                { context_id: contextId },
                query
            );

            const result = (response as any)?.data?.result ?? (response as any)?.bodyObject?.result;
            if (!result) {
                return {
                    success: false,
                    contextId,
                    errorMessage: 'Unexpected response structure from processflow operations API: no result field',
                    rawResponse: response
                };
            }

            const flowContext = this._mapFlowContextInfo(result.flowContext);
            const flowDef = result.flow as Record<string, unknown> | undefined;
            const flowReport = this._mapFlowExecutionReport(result.flowReport, flowDef);
            const reportAvailability = result.flowReportAvailabilityDetails as FlowReportAvailabilityDetails | undefined;

            this._logger.info(`Flow context details fetched: state=${flowContext?.state ?? 'unknown'}`);

            return {
                success: true,
                contextId,
                flowContext,
                flowReport,
                flowReportAvailabilityDetails: reportAvailability,
                flowDefinition: includeFlowDefinition ? result.flow as Record<string, unknown> : undefined,
                rawResponse: result
            };
        } catch (error) {
            const err = error as Error;
            this._logger.error(`Error fetching flow context details "${contextId}": ${err.message}`);
            return {
                success: false,
                contextId,
                errorMessage: `Failed to fetch flow context details: ${err.message}`
            };
        }
    }

    // ================================================================
    // Flow Logs API (sys_flow_log Table)
    // ================================================================

    /**
     * Retrieve flow execution logs from the sys_flow_log table.
     *
     * Returns log entries associated with a flow context, including error messages,
     * step-level logs, and cancellation reasons. Log entries may be empty for
     * simple successful executions.
     *
     * @param contextId The sys_id of the flow context to get logs for
     * @param options Optional query options (limit, order direction)
     * @returns FlowLogResult with array of log entries
     */
    public async getFlowLogs(
        contextId: string,
        options?: FlowLogOptions
    ): Promise<FlowLogResult> {
        this._validateContextId(contextId);

        if (options?.limit !== undefined && (options.limit < 1 || !Number.isInteger(options.limit))) {
            throw new Error('Limit must be a positive integer');
        }

        this._logger.info(`Getting flow logs for context: ${contextId}`);

        const limit = options?.limit ?? 100;
        const orderDir = options?.orderDirection ?? 'asc';
        const orderBy = orderDir === 'desc' ? 'ORDERBYDESCorder' : 'ORDERBYorder';

        const tableRequest = new TableAPIRequest(this._instance);

        try {
            const response = await tableRequest.get<{ result: FlowLogRecord[] }>('sys_flow_log', {
                sysparm_query: `context=${contextId}^${orderBy}`,
                sysparm_fields: 'sys_id,level,message,action,operation,order,sys_created_on,sys_created_by',
                sysparm_limit: String(limit)
            });

            const records: FlowLogRecord[] = (response as any)?.data?.result ?? (response as any)?.bodyObject?.result ?? [];

            const entries: FlowLogEntry[] = records.map((r) => ({
                sysId: r.sys_id,
                level: r.level,
                message: r.message,
                action: r.action,
                operation: r.operation,
                order: r.order,
                createdOn: r.sys_created_on,
                createdBy: r.sys_created_by
            }));

            this._logger.info(`Flow logs fetched: ${entries.length} entries`);

            return {
                success: true,
                contextId,
                entries,
                rawResponse: records
            };
        } catch (error) {
            const err = error as Error;
            this._logger.error(`Error fetching flow logs for "${contextId}": ${err.message}`);
            return {
                success: false,
                contextId,
                entries: [],
                errorMessage: `Failed to fetch flow logs: ${err.message}`
            };
        }
    }

    /**
     * Map the raw flowContext object from the operations API to a typed FlowContextInfo.
     * @internal
     */
    private _mapFlowContextInfo(raw: Record<string, unknown> | undefined): FlowContextInfo | undefined {
        if (!raw) return undefined;

        const execSource = raw.executionSource as Record<string, string> | undefined;

        return {
            flowId: String(raw.flowId ?? ''),
            name: String(raw.name ?? ''),
            state: String(raw.state ?? ''),
            runTime: String(raw.runTime ?? ''),
            isTestRun: raw.isTestRun === true,
            executedAs: String(raw.executedAs ?? ''),
            flowInitiatedBy: String(raw.flowInitiatedBy ?? ''),
            reporting: String(raw.reporting ?? ''),
            debugMode: raw.debugMode === true,
            executionSource: {
                callingSource: execSource?.callingSource ?? '',
                executionSourceTable: execSource?.executionSourceTable ?? '',
                executionSourceRecord: execSource?.executionSourceRecord ?? '',
                executionSourceRecordDisplay: execSource?.executionSourceRecordDisplay ?? ''
            },
            enableOpsViewExpansion: raw.enableOpsViewExpansion === true,
            flowRetentionPolicyCandidate: raw.flowRetentionPolicyCandidate === true
        };
    }

    /**
     * Map the raw flowReport object from the operations API to a typed FlowExecutionReport.
     * Cross-references with the flow definition to resolve human-readable step names.
     * @internal
     */
    private _mapFlowExecutionReport(
        raw: Record<string, unknown> | undefined,
        flowDef?: Record<string, unknown>
    ): FlowExecutionReport | undefined {
        if (!raw) return undefined;

        // Build a lookup from action instance ID → { actionTypeName, comment }
        const actionLookup = this._buildActionInstanceLookup(flowDef);

        const mapActionReports = (reports: Record<string, Record<string, unknown>> | undefined): Record<string, FlowActionReport> => {
            if (!reports) return {};
            const result: Record<string, FlowActionReport> = {};
            for (const [key, report] of Object.entries(reports)) {
                const lookup = actionLookup.get(key);
                const actionTypeName = lookup?.actionTypeName;
                const stepComment = lookup?.comment;
                const stepLabel = actionTypeName
                    ? (stepComment ? `${actionTypeName} (${stepComment})` : actionTypeName)
                    : (stepComment || undefined);

                result[key] = {
                    fStepCount: String(report.fStepCount ?? ''),
                    actionName: String(report.actionName ?? ''),
                    instanceReference: String(report.instanceReference ?? ''),
                    stepLabel,
                    actionTypeName,
                    stepComment,
                    operationsCore: (report.operationsCore ?? { error: '', state: '', startTime: '', order: '', runTime: '' }) as FlowOperationsCore,
                    relatedLinks: (report.relatedLinks ?? {}) as Record<string, string>,
                    operationsOutput: (report.operationsOutput ?? { data: {} }) as FlowOperationsData,
                    operationsInput: (report.operationsInput ?? { data: {} }) as FlowOperationsData,
                    reportId: String(report.reportId ?? '')
                };
            }
            return result;
        };

        return {
            flowId: String(raw.flowId ?? ''),
            domainSeparationEnabled: raw.domainSeparationEnabled === true,
            executionDomain: String(raw.executionDomain ?? ''),
            actionOperationsReports: mapActionReports(raw.actionOperationsReports as Record<string, Record<string, unknown>>),
            subflowOperationsReports: mapActionReports(raw.subflowOperationsReports as Record<string, Record<string, unknown>>),
            iterationOperationsReports: (raw.iterationOperationsReports ?? {}) as Record<string, unknown>,
            instanceReference: String(raw.instanceReference ?? ''),
            operationsCore: (raw.operationsCore ?? { error: '', state: '', startTime: '', order: '', runTime: '' }) as FlowOperationsCore,
            relatedLinks: (raw.relatedLinks ?? {}) as Record<string, string>,
            operationsOutput: (raw.operationsOutput ?? { data: {} }) as FlowOperationsData,
            operationsInput: (raw.operationsInput ?? { data: {} }) as FlowOperationsData,
            reportId: String(raw.reportId ?? '')
        };
    }

    /**
     * Build a lookup map from action instance ID to human-readable names
     * by scanning the flow definition's actionInstances array.
     * @internal
     */
    private _buildActionInstanceLookup(flowDef?: Record<string, unknown>): Map<string, { actionTypeName?: string; comment?: string }> {
        const lookup = new Map<string, { actionTypeName?: string; comment?: string }>();
        if (!flowDef) return lookup;

        const actionInstances = flowDef.actionInstances as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(actionInstances)) return lookup;

        for (const instance of actionInstances) {
            const id = instance.id as string;
            if (!id) continue;

            const actionType = instance.actionType as Record<string, unknown> | undefined;
            const actionTypeName = (actionType?.displayName ?? actionType?.name) as string | undefined
                || undefined;
            const comment = (instance.comment as string | undefined) || undefined;

            lookup.set(id, { actionTypeName, comment });
        }

        return lookup;
    }

    /**
     * Extract the result from a ProcessFlow API response, handling both
     * Axios-style (data.result) and RequestHandler-style (bodyObject.result) response shapes.
     */
    private _extractProcessFlowResult(response: any): ProcessFlowApiResponse['result'] {
        const result = response?.data?.result ?? response?.bodyObject?.result;
        if (!result) {
            throw new Error('Unexpected response structure from processflow API: no result field');
        }
        return result;
    }

    // ================================================================
    // Internal Methods
    // ================================================================

    /** Build the ServiceNow server-side script string. */
    _buildFlowScript(options: ExecuteFlowOptions): string {
        const mode = options.mode || 'foreground';
        const modeMethod = mode === 'background' ? 'inBackground' : 'inForeground';
        const inputsJson = options.inputs ? this._serializeInputs(options.inputs) : '{}';
        const scopedName = options.scopedName.replace(/'/g, "\\'");
        const type = options.type;

        let optionalChain = '';
        if (options.timeout !== undefined && options.timeout !== null) {
            optionalChain += `\n            .timeout(${options.timeout})`;
        }
        if (options.quick === true) {
            optionalChain += `\n            .quick()`;
        }

        const hasInputs = options.inputs && Object.keys(options.inputs).length > 0;
        const inputsChain = hasInputs ? `\n            .withInputs(inputs)` : '';

        return `(function() {
    var __RESULT_MARKER = '${RESULT_MARKER}';
    try {
        var inputs = ${inputsJson};

        var result = sn_fd.FlowAPI.getRunner()
            .${type}('${scopedName}')
            .${modeMethod}()${optionalChain}${inputsChain}
            .run();

        var envelope = {
            __flowResult: true,
            success: true,
            flowObjectName: '' + result.getFlowObjectName(),
            flowObjectType: '' + result.getFlowObjectType(),
            contextId: result.getContextId() ? '' + result.getContextId() : null,
            executionDate: result.getDate() ? '' + result.getDate() : null,
            domainId: result.getDomainId() ? '' + result.getDomainId() : null,
            outputs: null,
            debugOutput: '' + result.debug(),
            errorMessage: null
        };

        try {
            var rawOutputs = result.getOutputs();
            if (rawOutputs) {
                var outputObj = {};
                for (var key in rawOutputs) {
                    if (rawOutputs.hasOwnProperty(key)) {
                        outputObj[key] = '' + rawOutputs[key];
                    }
                }
                envelope.outputs = outputObj;
            }
        } catch (outErr) {
            envelope.outputs = null;
        }

        gs.info(__RESULT_MARKER + JSON.stringify(envelope));
    } catch (ex) {
        var errorEnvelope = {
            __flowResult: true,
            success: false,
            flowObjectName: '${scopedName}',
            flowObjectType: '${type}',
            contextId: null,
            executionDate: null,
            domainId: null,
            outputs: null,
            debugOutput: '',
            errorMessage: '' + (ex.getMessage ? ex.getMessage() : ex)
        };
        gs.info(__RESULT_MARKER + JSON.stringify(errorEnvelope));
    }
})();`;
    }

    /** Serialize inputs for embedding in the generated script. */
    _serializeInputs(inputs: Record<string, unknown>): string {
        const cleanInputs: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(inputs)) {
            if (value !== undefined) {
                cleanInputs[key] = value;
            }
        }
        return JSON.stringify(cleanInputs);
    }

    /**
     * Decode HTML entities and strip HTML tags from a string.
     * ServiceNow's background script output encodes quotes as &quot;
     * and appends <BR/> tags that must be removed before JSON parsing.
     */
    _decodeHtmlEntities(str: string): string {
        return str
            .replace(/<BR\s*\/?>/gi, '')
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&#39;/g, "'")
            .replace(/&apos;/g, "'")
            .trim();
    }

    /** Try to parse a line containing the result marker into a FlowScriptResultEnvelope. */
    private _tryParseEnvelopeFromLine(line: string): FlowScriptResultEnvelope | null {
        if (!line || !line.includes(RESULT_MARKER)) {
            return null;
        }
        const afterMarker = line.substring(line.indexOf(RESULT_MARKER) + RESULT_MARKER.length);
        const jsonStr = this._decodeHtmlEntities(afterMarker);
        try {
            const parsed = JSON.parse(jsonStr);
            if (parsed && parsed.__flowResult === true) {
                return parsed as FlowScriptResultEnvelope;
            }
        } catch {
            this._logger.warn(`Failed to parse flow result JSON: ${jsonStr.substring(0, 200)}`);
        }
        return null;
    }

    /** Extract the JSON envelope from script output lines. */
    _extractResultEnvelope(bgResult: BackgroundScriptExecutionResult): FlowScriptResultEnvelope | null {
        // Search through scriptResults for our marker line
        if (bgResult.scriptResults && bgResult.scriptResults.length > 0) {
            for (const outputLine of bgResult.scriptResults) {
                const envelope = this._tryParseEnvelopeFromLine(outputLine.line);
                if (envelope) return envelope;
            }
        }

        // Fallback: search through consoleResult string array
        if (bgResult.consoleResult && bgResult.consoleResult.length > 0) {
            for (const line of bgResult.consoleResult) {
                const envelope = this._tryParseEnvelopeFromLine(line);
                if (envelope) return envelope;
            }
        }

        return null;
    }

    /** Parse BackgroundScriptExecutionResult into FlowExecutionResult. */
    _parseFlowResult(bgResult: BackgroundScriptExecutionResult, options: ExecuteFlowOptions): FlowExecutionResult {
        const envelope = this._extractResultEnvelope(bgResult);

        if (envelope) {
            return {
                success: envelope.success,
                flowObjectName: envelope.flowObjectName || options.scopedName,
                flowObjectType: (envelope.flowObjectType as FlowObjectType) || options.type,
                contextId: envelope.contextId || undefined,
                executionDate: envelope.executionDate || undefined,
                domainId: envelope.domainId || undefined,
                outputs: envelope.outputs || undefined,
                debugOutput: envelope.debugOutput || undefined,
                errorMessage: envelope.errorMessage || undefined,
                rawScriptResult: bgResult
            };
        }

        this._logger.warn('Could not extract flow result envelope from script output');
        return {
            success: false,
            flowObjectName: options.scopedName,
            flowObjectType: options.type,
            errorMessage: 'Could not parse flow execution result from script output. ' +
                          'The script may have failed before producing output.',
            rawScriptResult: bgResult
        };
    }

    // ================================================================
    // Lifecycle Script Builders
    // ================================================================

    /** Validate that a context ID is a non-empty 32-character hex sys_id. */
    private _validateContextId(contextId: string): void {
        if (!contextId || contextId.trim().length === 0) {
            throw new Error('Context ID is required');
        }
        if (!/^[0-9a-f]{32}$/i.test(contextId.trim())) {
            throw new Error(`Invalid context ID format: "${contextId}". Expected a 32-character hex sys_id.`);
        }
    }

    /** Escape a string for embedding in a generated SN script single-quoted string. */
    private _escapeForScript(str: string): string {
        return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    }

    /** Build script to query sys_flow_context status. */
    _buildContextStatusScript(contextId: string): string {
        const escapedId = this._escapeForScript(contextId);
        return `(function() {
    var __RESULT_MARKER = '${RESULT_MARKER}';
    try {
        var gr = new GlideRecord('sys_flow_context');
        if (gr.get('${escapedId}')) {
            gs.info(__RESULT_MARKER + JSON.stringify({
                __flowResult: true,
                success: true,
                contextId: '${escapedId}',
                found: true,
                state: '' + gr.getValue('state'),
                name: '' + gr.getValue('name'),
                started: gr.getValue('started') ? '' + gr.getValue('started') : null,
                ended: gr.getValue('ended') ? '' + gr.getValue('ended') : null,
                errorMessage: null
            }));
        } else {
            gs.info(__RESULT_MARKER + JSON.stringify({
                __flowResult: true,
                success: true,
                contextId: '${escapedId}',
                found: false,
                state: null,
                name: null,
                started: null,
                ended: null,
                errorMessage: null
            }));
        }
    } catch (ex) {
        gs.info(__RESULT_MARKER + JSON.stringify({
            __flowResult: true,
            success: false,
            contextId: '${escapedId}',
            found: false,
            errorMessage: '' + (ex.getMessage ? ex.getMessage() : ex)
        }));
    }
})();`;
    }

    /** Build script to retrieve flow outputs via FlowAPI.getOutputs(). */
    _buildGetOutputsScript(contextId: string): string {
        const escapedId = this._escapeForScript(contextId);
        return `(function() {
    var __RESULT_MARKER = '${RESULT_MARKER}';
    try {
        var outputs = sn_fd.FlowAPI.getOutputs('${escapedId}');
        var outputObj = {};
        if (outputs) {
            for (var key in outputs) {
                if (outputs.hasOwnProperty(key)) {
                    outputObj[key] = '' + outputs[key];
                }
            }
        }
        gs.info(__RESULT_MARKER + JSON.stringify({
            __flowResult: true,
            success: true,
            contextId: '${escapedId}',
            outputs: outputObj,
            errorMessage: null
        }));
    } catch (ex) {
        gs.info(__RESULT_MARKER + JSON.stringify({
            __flowResult: true,
            success: false,
            contextId: '${escapedId}',
            outputs: null,
            errorMessage: '' + (ex.getMessage ? ex.getMessage() : ex)
        }));
    }
})();`;
    }

    /** Build script to retrieve flow error via FlowAPI.getErrorMessage(). */
    _buildGetErrorScript(contextId: string): string {
        const escapedId = this._escapeForScript(contextId);
        return `(function() {
    var __RESULT_MARKER = '${RESULT_MARKER}';
    try {
        var errorMsg = sn_fd.FlowAPI.getErrorMessage('${escapedId}');
        gs.info(__RESULT_MARKER + JSON.stringify({
            __flowResult: true,
            success: true,
            contextId: '${escapedId}',
            flowErrorMessage: errorMsg ? '' + errorMsg : null,
            errorMessage: null
        }));
    } catch (ex) {
        gs.info(__RESULT_MARKER + JSON.stringify({
            __flowResult: true,
            success: false,
            contextId: '${escapedId}',
            flowErrorMessage: null,
            errorMessage: '' + (ex.getMessage ? ex.getMessage() : ex)
        }));
    }
})();`;
    }

    /** Build script to cancel a flow via FlowAPI.cancel(). */
    _buildCancelScript(contextId: string, reason: string): string {
        const escapedId = this._escapeForScript(contextId);
        const escapedReason = this._escapeForScript(reason);
        return `(function() {
    var __RESULT_MARKER = '${RESULT_MARKER}';
    try {
        sn_fd.FlowAPI.cancel('${escapedId}', '${escapedReason}');
        gs.info(__RESULT_MARKER + JSON.stringify({
            __flowResult: true,
            success: true,
            contextId: '${escapedId}',
            errorMessage: null
        }));
    } catch (ex) {
        gs.info(__RESULT_MARKER + JSON.stringify({
            __flowResult: true,
            success: false,
            contextId: '${escapedId}',
            errorMessage: '' + (ex.getMessage ? ex.getMessage() : ex)
        }));
    }
})();`;
    }

    /** Build script to publish a flow via FlowAPI.publish(). */
    private _buildPublishScript(flowSysId: string): string {
        const escapedId = this._escapeForScript(flowSysId);
        return `(function() {
    var __RESULT_MARKER = '${RESULT_MARKER}';
    try {
        sn_fd.FlowAPI.publish('${escapedId}');
        gs.info(__RESULT_MARKER + JSON.stringify({
            __flowResult: true,
            success: true,
            flowSysId: '${escapedId}',
            errorMessage: null
        }));
    } catch (ex) {
        gs.info(__RESULT_MARKER + JSON.stringify({
            __flowResult: true,
            success: false,
            flowSysId: '${escapedId}',
            errorMessage: '' + (ex.getMessage ? ex.getMessage() : ex)
        }));
    }
})();`;
    }

    /** Build script to send a message to a paused flow via FlowAPI.sendMessage(). */
    _buildSendMessageScript(contextId: string, message: string, payload: string): string {
        const escapedId = this._escapeForScript(contextId);
        const escapedMessage = this._escapeForScript(message);
        const escapedPayload = this._escapeForScript(payload);
        return `(function() {
    var __RESULT_MARKER = '${RESULT_MARKER}';
    try {
        sn_fd.FlowAPI.sendMessage('${escapedId}', '${escapedMessage}', '${escapedPayload}');
        gs.info(__RESULT_MARKER + JSON.stringify({
            __flowResult: true,
            success: true,
            contextId: '${escapedId}',
            errorMessage: null
        }));
    } catch (ex) {
        gs.info(__RESULT_MARKER + JSON.stringify({
            __flowResult: true,
            success: false,
            contextId: '${escapedId}',
            errorMessage: '' + (ex.getMessage ? ex.getMessage() : ex)
        }));
    }
})();`;
    }
}
