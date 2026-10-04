import { randomBytes } from "node:crypto";
import { ServiceNowInstance } from "../ServiceNowInstance";
import { Logger } from "../../util/Logger";
import { ServiceNowRequest } from "../../comm/http/ServiceNowRequest";
import { SessionManager } from "../../comm/http/SessionManager";
import { TableAPIRequest } from "../../comm/http/TableAPIRequest";
import { IHttpResponse } from "../../comm/http/IHttpResponse";
import { FormRecordWriter } from "../../comm/http/FormRecordWriter";
import { FormValueInput } from "../../comm/http/FormRecordModels";
import { InvalidParameterException } from "../../exception/InvalidParameterException";
import { WorkflowValidationError } from "../../exception/WorkflowValidationError";
import { READ_ONLY } from "../../policy/PolicyTypes";
import { VariableDefinitions } from "../variables/VariableDefinitions";
import { VariableDefinition } from "../variables/VariableModels";
import { WorkflowDiagramClient } from "./WorkflowDiagramClient";
import {
    CreateWorkflowOptions,
    CreateWorkflowResult,
    CreateWorkflowVersionOptions,
    CreateWorkflowVersionResult,
    CreateActivityOptions,
    CreateActivityResult,
    CreateTransitionOptions,
    CreateTransitionResult,
    CreateConditionOptions,
    CreateConditionResult,
    PublishWorkflowOptions,
    CompleteWorkflowSpec,
    CompleteWorkflowResult,
    WorkflowRecordResponse,
    ActivityDefinitionDetail,
    ActivityDefinitionSummary,
    ActivityPosition,
    ActivityUsage,
    ActivityDesignerField,
    AddActivityOptions,
    AddActivityResult,
    AddConditionOptions,
    AddTransitionOptions,
    CheckoutOptions,
    CheckoutResult,
    DefaultConditionInfo,
    ExportWorkflowOptions,
    FindWorkflowsOptions,
    GetActivityDefinitionOptions,
    GetActivityUsageOptions,
    GetWorkflowDefinitionOptions,
    ListActivityDefinitionsOptions,
    NewWorkflowOptions,
    NewWorkflowResult,
    PublishOptions,
    PublishResult,
    RemoveActivityOptions,
    UpdateActivityOptions,
    UpdateConditionOptions,
    UpdateWorkflowPropertiesOptions,
    WorkflowActivityInfo,
    WorkflowConditionInfo,
    WorkflowDefinition,
    WorkflowExport,
    WorkflowExportActivity,
    WorkflowExportActivityType,
    WorkflowExportVariable,
    WorkflowGraph,
    WorkflowGraphEdge,
    WorkflowStageInfo,
    WorkflowSummary,
    WorkflowTransitionInfo,
    WorkflowValidationItem,
    WorkflowValidationReport,
    WorkflowVersionSummary
} from './WorkflowModels';

type Row = Record<string, unknown>;

const SYS_ID = /^[0-9a-f]{32}$/i;

const VERSION_FIELDS = [
    'sys_id', 'workflow', 'name', 'table', 'description', 'published', 'active', 'checked_out', 'checked_out_by',
    'checked_out_by.name', 'condition', 'condition_type', 'start', 'full_sequences', 'sys_created_on', 'sys_updated_on'
].join(',');
const CONDITION_FIELDS = [
    'sys_id', 'activity', 'name', 'condition', 'order', 'else_flag', 'error', 'event', 'event_name',
    'short_description', 'skip_during_generate'
].join(',');

/**
 * Manages legacy ServiceNow workflows (the Workflow Editor's wf_* records).
 *
 * Two families of methods live here:
 *
 * - **Editor-parity methods** (`newWorkflow`, `checkout`, `addActivity`, `publish`, …)
 *   drive the same server endpoints the Workflow Editor uses — its diagram processor for
 *   structure and lifecycle, and the classic `wf_activity` form for activity
 *   configuration — so checkout's deep copy, publish's validation and version swap, and
 *   activity variables (`sys_variable_value`) all behave exactly as they do in the UI.
 *   Editing methods require a draft checked out to the current user.
 * - **Record methods** (`createWorkflow`, `createActivity`, …, `createCompleteWorkflow`)
 *   insert wf_* records directly through the Table API. They predate the editor-parity
 *   methods and are kept for compatibility.
 */
export class WorkflowManager {
    private static readonly WF_WORKFLOW = 'wf_workflow';
    private static readonly WF_WORKFLOW_VERSION = 'wf_workflow_version';
    private static readonly WF_ACTIVITY = 'wf_activity';
    private static readonly WF_TRANSITION = 'wf_transition';
    private static readonly WF_CONDITION = 'wf_condition';

    /** The form view the Workflow Editor uses for activity dialogs. */
    private static readonly ACTIVITY_VIEW = 'diagrammer';

    private _logger: Logger = new Logger("WorkflowManager");
    private _req: ServiceNowRequest;
    private _tableAPI: TableAPIRequest;
    private _instance: ServiceNowInstance;
    private _diagram: WorkflowDiagramClient;
    private _forms: FormRecordWriter;
    private _variables: VariableDefinitions;
    private _currentUser?: Promise<string>;

    public constructor(instance: ServiceNowInstance) {
        this._instance = instance;
        this._req = new ServiceNowRequest(instance);
        this._tableAPI = new TableAPIRequest(instance);
        this._diagram = new WorkflowDiagramClient(instance);
        this._forms = new FormRecordWriter(instance);
        this._variables = new VariableDefinitions(instance);
    }

    /**
     * Create a new workflow record.
     *
     * @param options Workflow creation options
     * @returns The sys_id and name of the created workflow
     * @throws Error if the API call fails
     */
    public async createWorkflow(options: CreateWorkflowOptions): Promise<CreateWorkflowResult> {
        if (!options.name || options.name.trim().length === 0) {
            throw new Error('Workflow name is required');
        }

        this._logger.info(`Creating workflow: ${options.name}`);

        const body: Record<string, unknown> = {
            name: options.name
        };

        if (options.description !== undefined) {
            body.description = options.description;
        }
        if (options.template !== undefined) {
            body.template = options.template;
        }
        if (options.access !== undefined) {
            body.access = options.access;
        }

        const response: IHttpResponse<WorkflowRecordResponse> = await this._tableAPI.post<WorkflowRecordResponse>(
            WorkflowManager.WF_WORKFLOW, {}, body
        );

        if (response && (response.status === 200 || response.status === 201) && response.bodyObject?.result?.sys_id) {
            const result = response.bodyObject.result;
            this._logger.info(`Created workflow '${options.name}' with sys_id=${result.sys_id}`);
            return {
                workflowSysId: result.sys_id,
                name: result.name || options.name
            };
        }

        throw new Error(`Failed to create workflow '${options.name}'. Status: ${response?.status ?? 'unknown'}`);
    }

    /**
     * Create a new workflow version.
     *
     * @param options Workflow version creation options
     * @returns The sys_id and name of the created version
     * @throws Error if the API call fails
     */
    public async createWorkflowVersion(options: CreateWorkflowVersionOptions): Promise<CreateWorkflowVersionResult> {
        if (!options.name || options.name.trim().length === 0) {
            throw new Error('Workflow version name is required');
        }
        if (!options.workflowSysId || options.workflowSysId.trim().length === 0) {
            throw new Error('Workflow sys_id is required');
        }
        if (!options.table || options.table.trim().length === 0) {
            throw new Error('Table name is required');
        }

        this._logger.info(`Creating workflow version: ${options.name} for workflow ${options.workflowSysId}`);

        const body: Record<string, unknown> = {
            name: options.name,
            workflow: options.workflowSysId,
            table: options.table
        };

        if (options.description !== undefined) {
            body.description = options.description;
        }
        if (options.active !== undefined) {
            body.active = options.active;
        }
        if (options.published !== undefined) {
            body.published = options.published;
        }
        if (options.condition !== undefined) {
            body.condition = options.condition;
        }
        if (options.order !== undefined) {
            body.order = options.order;
        }

        const response: IHttpResponse<WorkflowRecordResponse> = await this._tableAPI.post<WorkflowRecordResponse>(
            WorkflowManager.WF_WORKFLOW_VERSION, {}, body
        );

        if (response && (response.status === 200 || response.status === 201) && response.bodyObject?.result?.sys_id) {
            const result = response.bodyObject.result;
            this._logger.info(`Created workflow version '${options.name}' with sys_id=${result.sys_id}`);
            return {
                versionSysId: result.sys_id,
                name: result.name || options.name
            };
        }

        throw new Error(`Failed to create workflow version '${options.name}'. Status: ${response?.status ?? 'unknown'}`);
    }

    /**
     * Create a new workflow activity.
     *
     * @param options Activity creation options
     * @returns The sys_id and name of the created activity
     * @throws Error if the API call fails
     */
    public async createActivity(options: CreateActivityOptions): Promise<CreateActivityResult> {
        if (!options.name || options.name.trim().length === 0) {
            throw new Error('Activity name is required');
        }
        if (!options.workflowVersionSysId || options.workflowVersionSysId.trim().length === 0) {
            throw new Error('Workflow version sys_id is required');
        }

        this._logger.info(`Creating activity: ${options.name} for version ${options.workflowVersionSysId}`);

        if (options.variables !== undefined) {
            return await this.createActivityThroughForm(options);
        }

        const body: Record<string, unknown> = {
            name: options.name,
            workflow_version: options.workflowVersionSysId
        };

        if (options.activityDefinitionSysId !== undefined) {
            body.activity_definition = options.activityDefinitionSysId;
        }
        if (options.x !== undefined) {
            body.x = options.x;
        }
        if (options.y !== undefined) {
            body.y = options.y;
        }
        if (options.width !== undefined) {
            body.width = options.width;
        }
        if (options.height !== undefined) {
            body.height = options.height;
        }
        if (options.script !== undefined) {
            body.script = options.script;
        }
        if (options.vars !== undefined) {
            body.vars = options.vars;
        }

        const response: IHttpResponse<WorkflowRecordResponse> = await this._tableAPI.post<WorkflowRecordResponse>(
            WorkflowManager.WF_ACTIVITY, {}, body
        );

        if (response && (response.status === 200 || response.status === 201) && response.bodyObject?.result?.sys_id) {
            const result = response.bodyObject.result;
            this._logger.info(`Created activity '${options.name}' with sys_id=${result.sys_id}`);
            return {
                activitySysId: result.sys_id,
                name: result.name || options.name
            };
        }

        throw new Error(`Failed to create activity '${options.name}'. Status: ${response?.status ?? 'unknown'}`);
    }

    /**
     * Create a transition between two activities.
     *
     * @param options Transition creation options
     * @returns The sys_id of the created transition
     * @throws Error if the API call fails
     */
    public async createTransition(options: CreateTransitionOptions): Promise<CreateTransitionResult> {
        if (!options.fromActivitySysId || options.fromActivitySysId.trim().length === 0) {
            throw new Error('From activity sys_id is required');
        }
        if (!options.toActivitySysId || options.toActivitySysId.trim().length === 0) {
            throw new Error('To activity sys_id is required');
        }

        this._logger.info(`Creating transition: ${options.fromActivitySysId} -> ${options.toActivitySysId}`);

        const body: Record<string, unknown> = {
            from: options.fromActivitySysId,
            to: options.toActivitySysId
        };

        if (options.conditionSysId !== undefined) {
            body.condition = options.conditionSysId;
        }
        if (options.order !== undefined) {
            body.order = options.order;
        }

        const response: IHttpResponse<WorkflowRecordResponse> = await this._tableAPI.post<WorkflowRecordResponse>(
            WorkflowManager.WF_TRANSITION, {}, body
        );

        if (response && (response.status === 200 || response.status === 201) && response.bodyObject?.result?.sys_id) {
            const result = response.bodyObject.result;
            this._logger.info(`Created transition with sys_id=${result.sys_id}`);
            return {
                transitionSysId: result.sys_id
            };
        }

        throw new Error(
            `Failed to create transition from '${options.fromActivitySysId}' to '${options.toActivitySysId}'. Status: ${response?.status ?? 'unknown'}`
        );
    }

    /**
     * Create a condition on an activity.
     *
     * @param options Condition creation options
     * @returns The sys_id and name of the created condition
     * @throws Error if the API call fails
     */
    public async createCondition(options: CreateConditionOptions): Promise<CreateConditionResult> {
        if (!options.activitySysId || options.activitySysId.trim().length === 0) {
            throw new Error('Activity sys_id is required');
        }
        if (!options.name || options.name.trim().length === 0) {
            throw new Error('Condition name is required');
        }

        this._logger.info(`Creating condition: ${options.name} on activity ${options.activitySysId}`);

        const body: Record<string, unknown> = {
            activity: options.activitySysId,
            name: options.name
        };

        if (options.description !== undefined) {
            body.description = options.description;
        }
        if (options.condition !== undefined) {
            body.condition = options.condition;
        }
        if (options.order !== undefined) {
            body.order = options.order;
        }
        if (options.elseFlag !== undefined) {
            body.else_flag = options.elseFlag;
        }

        const response: IHttpResponse<WorkflowRecordResponse> = await this._tableAPI.post<WorkflowRecordResponse>(
            WorkflowManager.WF_CONDITION, {}, body
        );

        if (response && (response.status === 200 || response.status === 201) && response.bodyObject?.result?.sys_id) {
            const result = response.bodyObject.result;
            this._logger.info(`Created condition '${options.name}' with sys_id=${result.sys_id}`);
            return {
                conditionSysId: result.sys_id,
                name: result.name || options.name
            };
        }

        throw new Error(`Failed to create condition '${options.name}'. Status: ${response?.status ?? 'unknown'}`);
    }

    /**
     * Set a workflow version's start activity and publish it.
     *
     * Publishes through the Workflow Editor's publish (without its validation prompt, as
     * this method never validated), so the version swap, path computation and update-set
     * capture match a publish from the editor. Use {@link publish} for validation.
     *
     * @param options Publish options including version sys_id and start activity sys_id
     * @throws Error if the API call fails
     */
    public async publishWorkflow(options: PublishWorkflowOptions): Promise<void> {
        if (!options.versionSysId || options.versionSysId.trim().length === 0) {
            throw new Error('Workflow version sys_id is required');
        }
        if (!options.startActivitySysId || options.startActivitySysId.trim().length === 0) {
            throw new Error('Start activity sys_id is required');
        }

        this._logger.info(`Publishing workflow version ${options.versionSysId} with start activity ${options.startActivitySysId}`);

        const response: IHttpResponse<WorkflowRecordResponse> = await this._tableAPI.put<WorkflowRecordResponse>(
            WorkflowManager.WF_WORKFLOW_VERSION, options.versionSysId, { start: options.startActivitySysId }
        );

        if (!(response && response.status === 200 && response.bodyObject?.result)) {
            throw new Error(`Failed to publish workflow version ${options.versionSysId}. Status: ${response?.status ?? 'unknown'}`);
        }

        const published = await this._diagram.publish(options.versionSysId, false);
        if (!published.graph?.published) {
            throw new Error(`Failed to publish workflow version ${options.versionSysId}: the instance did not publish it`);
        }

        this._logger.info(`Successfully published workflow version ${options.versionSysId}`);
    }

    /**
     * Create a complete workflow from a single specification.
     * Orchestrates: create workflow -> create version -> create activities ->
     * create transitions -> optionally publish.
     *
     * Activity references in transitions use the activity's id field (if set) or
     * its index in the activities array (as a string like "0", "1", etc.).
     *
     * @param spec The complete workflow specification
     * @param onProgress Optional progress callback
     * @returns The complete result including all created sys_ids
     * @throws Error if any step fails
     */
    public async createCompleteWorkflow(
        spec: CompleteWorkflowSpec,
        onProgress?: (message: string) => void
    ): Promise<CompleteWorkflowResult> {
        if (!spec.name || spec.name.trim().length === 0) {
            throw new Error('Workflow name is required');
        }
        if (!spec.activities || spec.activities.length === 0) {
            throw new Error('At least one activity is required');
        }

        this._logger.info(`Creating complete workflow: ${spec.name}`);

        // Step 1: Create workflow
        if (onProgress) {
            onProgress(`Creating workflow '${spec.name}'`);
        }

        const workflowResult = await this.createWorkflow({
            name: spec.name,
            description: spec.description,
            template: spec.template,
            access: spec.access
        });

        // Step 2: Create workflow version
        if (onProgress) {
            onProgress(`Creating workflow version for '${spec.name}'`);
        }

        const versionResult = await this.createWorkflowVersion({
            name: spec.name,
            workflowSysId: workflowResult.workflowSysId,
            table: spec.table,
            description: spec.description,
            active: spec.active,
            condition: spec.condition
        });

        // Step 3: Create activities
        const activitySysIds: Record<string, string> = {};

        for (let i = 0; i < spec.activities.length; i++) {
            const activitySpec = spec.activities[i];

            if (onProgress) {
                onProgress(`Creating activity ${i + 1}/${spec.activities.length}: '${activitySpec.name}'`);
            }

            const activityResult = await this.createActivity({
                name: activitySpec.name,
                workflowVersionSysId: versionResult.versionSysId,
                activityDefinitionSysId: activitySpec.activityType,
                x: activitySpec.x,
                y: activitySpec.y,
                width: activitySpec.width,
                height: activitySpec.height,
                script: activitySpec.script,
                vars: activitySpec.vars,
                variables: activitySpec.variables
            });

            // Store by id if provided, and always by index
            if (activitySpec.id) {
                activitySysIds[activitySpec.id] = activityResult.activitySysId;
            }
            activitySysIds[String(i)] = activityResult.activitySysId;
        }

        // Step 4: Create transitions
        const transitionSysIds: string[] = [];

        if (spec.transitions && spec.transitions.length > 0) {
            for (let i = 0; i < spec.transitions.length; i++) {
                const transitionSpec = spec.transitions[i];

                if (onProgress) {
                    onProgress(`Creating transition ${i + 1}/${spec.transitions.length}: '${transitionSpec.from}' -> '${transitionSpec.to}'`);
                }

                const fromSysId = activitySysIds[transitionSpec.from];
                const toSysId = activitySysIds[transitionSpec.to];

                if (!fromSysId) {
                    throw new Error(`Transition 'from' activity '${transitionSpec.from}' not found in activity map`);
                }
                if (!toSysId) {
                    throw new Error(`Transition 'to' activity '${transitionSpec.to}' not found in activity map`);
                }

                const transitionResult = await this.createTransition({
                    fromActivitySysId: fromSysId,
                    toActivitySysId: toSysId,
                    conditionSysId: transitionSpec.conditionSysId,
                    order: transitionSpec.order
                });

                transitionSysIds.push(transitionResult.transitionSysId);
            }
        }

        // Step 5: Publish if requested
        let published = false;
        let startActivityKey: string | undefined;

        if (spec.publish) {
            if (!spec.startActivity) {
                throw new Error('startActivity is required when publish=true');
            }

            const startSysId = activitySysIds[spec.startActivity];
            if (!startSysId) {
                throw new Error(`Start activity '${spec.startActivity}' not found in activity map`);
            }

            if (onProgress) {
                onProgress(`Publishing workflow '${spec.name}'`);
            }

            await this.publishWorkflow({
                versionSysId: versionResult.versionSysId,
                startActivitySysId: startSysId
            });

            published = true;
            startActivityKey = spec.startActivity;
        }

        if (onProgress) {
            onProgress(`Complete workflow '${spec.name}' created successfully`);
        }

        return {
            workflowSysId: workflowResult.workflowSysId,
            versionSysId: versionResult.versionSysId,
            activitySysIds,
            transitionSysIds,
            published,
            startActivity: startActivityKey
        };
    }

    // ============================================================
    // Reading workflows
    // ============================================================

    /**
     * Find workflows, with the state of their published and checked-out versions.
     */
    public async findWorkflows(options: FindWorkflowsOptions = {}): Promise<WorkflowSummary[]> {
        const parts: string[] = [];
        if (options.name) parts.push(`nameLIKE${queryValue(options.name, 'name')}`);
        if (options.table) parts.push(`table=${queryValue(options.table, 'table')}`);
        if (options.query) parts.push(options.query);
        parts.push('ORDERBYname');
        const limit = options.limit ?? 50;
        const workflows = await this.read(WorkflowManager.WF_WORKFLOW, parts.join('^'), 'sys_id,name,table,description', limit);
        return await this.summarize(workflows);
    }

    /**
     * Resolve a workflow by name, wf_workflow sys_id, or the sys_id of any of its versions.
     *
     * @throws InvalidParameterException when nothing or more than one workflow matches
     */
    public async resolveWorkflow(nameOrSysId: string): Promise<WorkflowSummary> {
        const ref = (nameOrSysId ?? '').trim();
        if (!ref) throw new InvalidParameterException('A workflow name or sys_id is required');

        let rows: Row[] = [];
        if (SYS_ID.test(ref)) {
            rows = await this.read(WorkflowManager.WF_WORKFLOW, `sys_id=${ref}`, 'sys_id,name,table,description', 1);
            if (!rows.length) {
                const version = await this.read(WorkflowManager.WF_WORKFLOW_VERSION, `sys_id=${ref}`, 'workflow', 1);
                if (version.length) {
                    rows = await this.read(WorkflowManager.WF_WORKFLOW, `sys_id=${str(version[0].workflow)}`, 'sys_id,name,table,description', 1);
                }
            }
        }
        if (!rows.length) {
            rows = await this.read(WorkflowManager.WF_WORKFLOW, `name=${queryValue(ref, 'workflow name')}`, 'sys_id,name,table,description', 10);
        }
        if (!rows.length) throw new InvalidParameterException(`No workflow found for '${ref}'`);
        if (rows.length > 1) {
            throw new InvalidParameterException(
                `'${ref}' matches ${rows.length} workflows; use a sys_id: ${rows.map(r => `${str(r.sys_id)} (${str(r.table)})`).join(', ')}`);
        }
        return (await this.summarize(rows))[0];
    }

    /**
     * List a workflow's versions, newest first.
     */
    public async getWorkflowVersions(workflowSysId: string): Promise<WorkflowVersionSummary[]> {
        this.requireSysId(workflowSysId, 'workflowSysId');
        const rows = await this.read(WorkflowManager.WF_WORKFLOW_VERSION, `workflow=${workflowSysId}^ORDERBYDESCsys_created_on`, VERSION_FIELDS, 1000);
        return rows.map(toVersionSummary);
    }

    /**
     * Read everything that makes up a workflow version: activities with their variables
     * and exits, transitions and stages.
     */
    public async getWorkflowDefinition(versionSysId: string, options: GetWorkflowDefinitionOptions = {}): Promise<WorkflowDefinition> {
        this.requireSysId(versionSysId, 'versionSysId');
        const version = await this.readVersion(versionSysId);

        const [activityRows, conditionRows, transitionRows, stageRows] = await Promise.all([
            this.read(WorkflowManager.WF_ACTIVITY, `workflow_version=${versionSysId}^ORDERBYsys_created_on`,
                'sys_id,name,activity_definition,activity_definition.name,x,y,width,height,stage,parent,input', 10000),
            this.read(WorkflowManager.WF_CONDITION, `activity.workflow_version=${versionSysId}^ORDERBYorder`, CONDITION_FIELDS, 10000),
            this.read(WorkflowManager.WF_TRANSITION, `from.workflow_version=${versionSysId}`, 'sys_id,from,to,condition', 10000),
            this.read('wf_stage', `workflow_version=${versionSysId}^ORDERBYorder`, 'sys_id,name,value,order', 1000),
        ]);

        const conditions = conditionRows.map(toCondition);
        const activities: WorkflowActivityInfo[] = activityRows.map(row => ({
            sysId: str(row.sys_id),
            name: str(row.name),
            definitionSysId: str(row.activity_definition),
            definitionName: str(row['activity_definition.name']),
            x: optNum(row.x),
            y: optNum(row.y),
            width: optNum(row.width),
            height: optNum(row.height),
            stage: str(row.stage) || undefined,
            parent: str(row.parent) || undefined,
            input: str(row.input),
            conditions: conditions.filter(c => c.activitySysId === str(row.sys_id)),
        }));

        if (options.includeVariables !== false && activities.length) {
            const values = await this.readVariableValues(activities.map(a => a.sysId));
            for (const activity of activities) activity.variables = values.get(activity.sysId) ?? {};
        }

        const definition: WorkflowDefinition = {
            workflowSysId: str(version.workflow),
            versionSysId,
            name: str(version.name),
            table: str(version.table),
            description: str(version.description),
            condition: str(version.condition),
            conditionType: str(version.condition_type),
            published: str(version.published) === 'true',
            active: str(version.active) === 'true',
            checkedOut: str(version.checked_out),
            checkedOutBy: str(version.checked_out_by),
            start: str(version.start),
            fullSequences: str(version.full_sequences).split(',').filter(Boolean),
            activities,
            transitions: transitionRows.map((row): WorkflowTransitionInfo => ({
                sysId: str(row.sys_id), from: str(row.from), to: str(row.to), condition: str(row.condition),
            })),
            stages: stageRows.map((row): WorkflowStageInfo => ({
                sysId: str(row.sys_id), name: str(row.name), value: str(row.value), order: num(row.order),
            })),
        };

        if (options.includeStatus !== false) {
            const graph = await this._diagram.get(versionSysId);
            definition.status = {
                readOnly: graph.readOnly,
                canCheckout: graph.canCheckout,
                canForceCheckout: graph.canForceCheckout,
                canPublish: graph.canPublish,
                statusDisplay: graph.statusDisplay,
            };
        }
        return definition;
    }

    /**
     * Read a version's diagram as the Workflow Editor sees it.
     */
    public async getWorkflowGraph(versionSysId: string): Promise<WorkflowGraph> {
        this.requireSysId(versionSysId, 'versionSysId');
        return await this._diagram.get(versionSysId);
    }

    /**
     * List activity types — core activities and, unless excluded, Activity Designer ones.
     */
    public async listActivityDefinitions(options: ListActivityDefinitionsOptions = {}): Promise<ActivityDefinitionSummary[]> {
        const parts: string[] = [];
        if (options.name) parts.push(`nameLIKE${queryValue(options.name, 'name')}`);
        if (options.category) parts.push(`category=${queryValue(options.category, 'category')}`);
        if (options.includeDesigner === false) parts.push('sys_class_name=wf_activity_definition');
        parts.push('ORDERBYname');
        const rows = await this.read('wf_element_definition', parts.join('^'), 'sys_id,name,category,sys_class_name', options.limit ?? 500);
        return rows.map(toDefinitionSummary);
    }

    /**
     * Describe an activity type as the instance defines it: its own description, the
     * variables its activities carry (types, defaults, choices, hints) or — for Activity
     * Designer types — its inputs and outputs, and the exits a new activity starts with.
     * With `includeScript`, also its implementation, which shows how each variable is used
     * and which results drive the exits.
     *
     * @param nameOrSysId Definition sys_id or exact name (e.g. "Timer")
     */
    public async getActivityDefinition(nameOrSysId: string, options: GetActivityDefinitionOptions = {}): Promise<ActivityDefinitionDetail> {
        const summary = await this.resolveActivityDefinition(nameOrSysId);
        const designer = summary.sysClassName === 'wf_element_activity';
        const ownFields = designer
            ? `input_meta,output_meta${options.includeScript ? ',output_process_script' : ''}`
            : (options.includeScript ? 'script' : '');
        const [variables, defaults, base, own] = await Promise.all([
            designer ? Promise.resolve<VariableDefinition[]>([]) : this._variables.list(`var__m_${summary.sysId}`),
            this.read('wf_condition_default', `activity_definition=${summary.sysId}^ORDERBYorder`,
                'name,condition,order,else_flag,error,skip_during_generate', 200),
            this.read('wf_element_definition', `sys_id=${summary.sysId}`, 'description,attributes', 1),
            ownFields ? this.read(summary.sysClassName, `sys_id=${summary.sysId}`, ownFields, 1) : Promise.resolve([] as Row[]),
        ]);

        const detail: ActivityDefinitionDetail = {
            ...summary,
            description: str(base[0]?.description),
            attributes: str(base[0]?.attributes),
            variables,
            defaultConditions: defaults.map((row): DefaultConditionInfo => ({
                name: str(row.name),
                condition: str(row.condition),
                order: num(row.order),
                elseFlag: str(row.else_flag) === 'true',
                error: str(row.error) === 'true',
                skipDuringGenerate: str(row.skip_during_generate) === 'true',
            })),
        };
        const row = own[0];
        if (designer && row) {
            detail.inputs = designerFields(str(row.input_meta));
            detail.outputs = designerFields(str(row.output_meta));
            if (options.includeScript) detail.script = str(row.output_process_script);
        } else if (row && options.includeScript) {
            detail.script = str(row.script);
        }
        return detail;
    }

    /**
     * Learn how an activity type is configured on this instance: samples activities of the
     * type in published workflows and reports, per variable (or Activity Designer input),
     * how often it is set and its most common values. Use it to follow the instance's own
     * conventions — which fields approvals reference, how task values are templated, … .
     *
     * @param nameOrSysId Definition sys_id or exact name
     */
    public async getActivityUsage(nameOrSysId: string, options: GetActivityUsageOptions = {}): Promise<ActivityUsage> {
        const sampleSize = Math.min(Math.max(options.sampleSize ?? 100, 1), 500);
        const perField = options.examplesPerField ?? 5;
        const maxLength = options.maxValueLength ?? 300;
        const definition = await this.getActivityDefinition(nameOrSysId);
        const designer = definition.sysClassName === 'wf_element_activity';

        const query = `activity_definition=${definition.sysId}^workflow_version.published=true`;
        const activities = await this.read(WorkflowManager.WF_ACTIVITY, `${query}^ORDERBYDESCsys_updated_on`,
            designer ? 'sys_id,input' : 'sys_id', sampleSize);
        const total = await this.count(WorkflowManager.WF_ACTIVITY, query);

        const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim();
        const defaults = new Map(definition.variables.map(v => [v.element, normalize(v.defaultValue)]));
        const tallies = new Map<string, Map<string, { count: number; isDefault: boolean }>>();
        const add = (field: string, value: string): void => {
            if (value === '') return;
            const kept = value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
            const counts = tallies.get(field) ?? new Map<string, { count: number; isDefault: boolean }>();
            const entry = counts.get(kept) ?? { count: 0, isDefault: defaults.get(field) === normalize(value) };
            entry.count++;
            counts.set(kept, entry);
            tallies.set(field, counts);
        };

        let order: string[];
        if (designer) {
            order = (definition.inputs ?? []).map(i => i.name);
            for (const activity of activities) {
                let input: Record<string, unknown> = {};
                try {
                    input = JSON.parse(str(activity.input) || '{}') as Record<string, unknown>;
                } catch {
                    continue;
                }
                for (const [name, value] of Object.entries(input)) {
                    if (!order.includes(name)) order.push(name);
                    add(name, typeof value === 'string' ? value : JSON.stringify(value));
                }
            }
        } else {
            order = definition.variables.map(v => v.element);
            const values = await this.readVariableValues(activities.map(a => str(a.sys_id)));
            for (const byElement of values.values()) {
                for (const [element, value] of Object.entries(byElement)) add(element, value);
            }
        }

        return {
            definitionSysId: definition.sysId,
            definitionName: definition.name,
            publishedActivities: total,
            sampled: activities.length,
            fields: order.map(name => {
                const counts = [...(tallies.get(name)?.entries() ?? [])].sort((a, b) => b[1].count - a[1].count);
                return {
                    name,
                    setCount: counts.reduce((sum, [, e]) => sum + e.count, 0),
                    examples: counts.slice(0, perField).map(([value, e]) => ({ value, count: e.count, isDefault: e.isDefault })),
                };
            }),
        };
    }

    /**
     * Export one workflow version as a complete, self-contained definition: the workflow
     * and version properties, inputs, stages, every activity with its type, labelled
     * variables (defaults marked) and exits, the transitions, the activity types it uses
     * (described from the instance, including whether they pause the workflow), display
     * names for referenced records, the subflows it calls, and what uses it.
     *
     * @param workflow Workflow name or sys_id, or a version sys_id (exported as is)
     */
    public async exportWorkflow(workflow: string, options: ExportWorkflowOptions = {}): Promise<WorkflowExport> {
        const versionSysId = await this.resolveVersionToRead(workflow, options.version ?? 'current');
        const version = (await this.read(WorkflowManager.WF_WORKFLOW_VERSION, `sys_id=${versionSysId}`,
            `${VERSION_FIELDS},order,run_multiple,after_business_rules,stage_field,on_cancel`, 1))[0];
        const workflowSysId = str(version.workflow);
        const definition = await this.getWorkflowDefinition(versionSysId, { includeStatus: false });

        const typeIds = [...new Set(definition.activities.map(a => a.definitionSysId))];
        // A session runs one transaction at a time; a wide fan-out only queues (or is refused with 202).
        const details = await mapLimit(typeIds, 2, id => this.getActivityDefinition(id));
        const waits = await mapLimit(details, 2, d => this.typeWaits(d));
        const activityTypes: Record<string, WorkflowExportActivityType> = {};
        details.forEach((d, i) => {
            activityTypes[d.sysId] = {
                sysId: d.sysId, name: d.name, category: d.category, sysClassName: d.sysClassName,
                attributes: d.attributes, description: d.description, waits: waits[i],
                ...(d.inputs ? { inputs: d.inputs, outputs: d.outputs } : {}),
            };
        });
        const variableDefs = new Map(details.map(d => [d.sysId, new Map(d.variables.map(v => [v.element, v]))]));

        const [wfRows, inputRows, subflowRows, catalogRows, parentRows] = await Promise.all([
            this.read(WorkflowManager.WF_WORKFLOW, `sys_id=${workflowSysId}`, 'sys_id,name,table,description,sys_scope.scope', 1),
            this.read('var_dictionary', `model_id=${workflowSysId}^ORDERBYorder`, 'element,column_label,internal_type,mandatory,default_value', 500),
            this.read('wf_workflow_instance', `workflow_version=${versionSysId}`, 'activity,workflow,workflow.name', 1000),
            this.read('sc_cat_item', `workflow=${workflowSysId}^ORDERBYname`, 'sys_id,name,active', 500),
            this.read('wf_workflow_instance', `workflow=${workflowSysId}^workflow_version.published=true`,
                'workflow_version,workflow_version.workflow,workflow_version.name', 500),
        ]);
        const subflows = new Map(subflowRows.map(r => [str(r.activity), { workflowSysId: str(r.workflow), name: str(r['workflow.name']) }]));

        // Collect the sys_ids variables point at, by table, so they can be named once.
        const wanted = new Map<string, Set<string>>();
        const want = (table: string, id: string): void => {
            if (!table || !SYS_ID.test(id)) return;
            wanted.set(table, (wanted.get(table) ?? new Set<string>()).add(id));
        };
        for (const activity of definition.activities) {
            const defs = variableDefs.get(activity.definitionSysId);
            for (const [element, value] of Object.entries(activity.variables ?? {})) {
                const def = defs?.get(element);
                if (def?.reference && (def.internalType === 'reference' || def.internalType === 'glide_list')) {
                    for (const id of value.split(',')) want(def.reference, id.trim());
                }
                for (const match of value.matchAll(/variables\.([0-9a-f]{32})/gi)) want('item_option_new', match[1]);
            }
        }
        const references = await this.displayNames(wanted);

        const activities: WorkflowExportActivity[] = definition.activities.map(activity => {
            const defs = variableDefs.get(activity.definitionSysId);
            const variables: WorkflowExportVariable[] = [];
            for (const [element, value] of Object.entries(activity.variables ?? {})) {
                if (value === '') continue;
                const def = defs?.get(element);
                const exported: WorkflowExportVariable = {
                    element, label: def?.label ?? element, type: def?.internalType ?? '', value,
                    isDefault: !!def && normalizeSpace(def.defaultValue) === normalizeSpace(value),
                };
                const choice = def?.choices?.find(c => c.value === value);
                const named = value.split(',').map(id => references[id.trim()]?.display).filter(Boolean);
                if (choice) exported.display = choice.label;
                else if (named.length) exported.display = named.join(', ');
                variables.push(exported);
            }
            const result: WorkflowExportActivity = {
                sysId: activity.sysId,
                name: activity.name,
                typeSysId: activity.definitionSysId,
                type: activity.definitionName,
                x: activity.x,
                y: activity.y,
                stage: activity.stage,
                parent: activity.parent,
                variables,
                exits: activity.conditions.map(c => ({
                    sysId: c.sysId, name: c.name, condition: c.condition, order: c.order, elseFlag: c.elseFlag, error: c.error,
                })),
            };
            if (activity.input && activity.input !== '{}') result.input = parseJsonObject(activity.input);
            const subflow = subflows.get(activity.sysId);
            if (subflow) result.subflow = subflow;
            return result;
        });

        const wf = wfRows[0] ?? {};
        return {
            format: 'now-sdk-ext/legacy-workflow@1',
            exportedAt: new Date().toISOString(),
            workflow: {
                sysId: workflowSysId, name: str(wf.name), table: str(wf.table), description: str(wf.description),
                scope: str(wf['sys_scope.scope']),
            },
            version: {
                sysId: versionSysId,
                name: str(version.name),
                published: str(version.published) === 'true',
                active: str(version.active) === 'true',
                checkedOut: str(version.checked_out),
                checkedOutBy: str(version.checked_out_by),
                condition: str(version.condition),
                conditionType: str(version.condition_type),
                order: num(version.order),
                runMultiple: str(version.run_multiple) === 'true',
                afterBusinessRules: str(version.after_business_rules) === 'true',
                stageField: str(version.stage_field),
                onCancel: str(version.on_cancel),
                start: str(version.start),
                fullSequences: definition.fullSequences,
            },
            inputs: inputRows.map(r => ({
                name: str(r.element), label: str(r.column_label), type: str(r.internal_type),
                mandatory: str(r.mandatory) === 'true', defaultValue: str(r.default_value),
            })),
            stages: definition.stages,
            activityTypes,
            activities,
            transitions: definition.transitions.map(t => ({ sysId: t.sysId, from: t.from, exit: t.condition, to: t.to })),
            references,
            usedBy: {
                catalogItems: catalogRows.map(r => ({ sysId: str(r.sys_id), name: str(r.name), active: str(r.active) === 'true' })),
                parentWorkflows: parentRows.map(r => ({
                    workflowSysId: str(r['workflow_version.workflow']), name: str(r['workflow_version.name']), versionSysId: str(r.workflow_version),
                })),
            },
        };
    }

    /**
     * Run the Workflow Editor's validation ("Validate Workflow") without publishing.
     */
    public async validateWorkflow(versionSysId: string): Promise<WorkflowValidationReport> {
        this.requireSysId(versionSysId, 'versionSysId');
        // Rendering the report page is what runs the checks; the results are then
        // readable as records.
        const page = await this.request().get<string>({
            method: 'GET', path: '/validate_workflow.do', headers: null, body: null,
            query: { sysparm_sys_id: versionSysId }, requires: READ_ONLY, responseFormat: 'text',
        });
        const html = typeof page.data === 'string' ? page.data : '';
        const summaryMatch = /id="wf_validation_summary_message"[^>]*>\s*<h4>([\s\S]*?)<\/h4>/.exec(html);
        const summary = summaryMatch ? decodeEntities(summaryMatch[1]).replace(/\s+/g, ' ').trim() : '';

        const rows = await this.read('v_wf_validation_report', `workflow_version=${versionSysId}`, 'type,level,message,details', 500);
        const items = rows.map((row): WorkflowValidationItem => ({
            type: str(row.type), level: str(row.level), message: str(row.message), details: str(row.details),
        }));
        if (!summary && !items.length) {
            throw new Error(`Could not read the validation report for workflow version ${versionSysId}`);
        }
        return {
            versionSysId,
            summary,
            valid: !items.some(i => i.level === 'Warn' || i.level === 'Critical'),
            items,
        };
    }

    // ============================================================
    // Workflow lifecycle (Workflow Editor parity)
    // ============================================================

    /**
     * Create a workflow the way the Workflow Editor's "New Workflow" does: a version with
     * Begin and End activities joined by a transition, checked out to the current user.
     *
     * @throws InvalidParameterException when a workflow with this name already exists
     */
    public async newWorkflow(options: NewWorkflowOptions): Promise<NewWorkflowResult> {
        if (!options?.name || options.name.trim().length === 0) throw new InvalidParameterException('Workflow name is required');
        if (!options.table || options.table.trim().length === 0) throw new InvalidParameterException('Table name is required');

        const existing = await this.read(WorkflowManager.WF_WORKFLOW, `name=${queryValue(options.name, 'workflow name')}`, 'sys_id', 1);
        if (existing.length) throw new InvalidParameterException(`A workflow named '${options.name}' already exists (${str(existing[0].sys_id)})`);

        // Inserting a version without a parent workflow is what the editor does; the
        // instance's "Workflow initialize" rule then creates the workflow, Begin, End,
        // the Begin exit and the Begin → End transition.
        const body: Record<string, unknown> = { ...(options.fields ?? {}), name: options.name, table: options.table };
        if (options.description !== undefined) body.description = options.description;
        if (options.condition !== undefined) body.condition = options.condition;
        if (options.conditionType !== undefined) body.condition_type = options.conditionType;

        this._logger.info(`Creating workflow '${options.name}' on ${options.table}`);
        const response = await this._tableAPI.post<WorkflowRecordResponse>(WorkflowManager.WF_WORKFLOW_VERSION, {}, body);
        const versionSysId = response?.bodyObject?.result?.sys_id;
        if (!versionSysId) throw new Error(`Failed to create workflow '${options.name}'. Status: ${response?.status ?? 'unknown'}`);

        const version = await this.readVersion(versionSysId);
        const transitions = await this.read(WorkflowManager.WF_TRANSITION, `from.workflow_version=${versionSysId}`, 'sys_id,from,to,condition', 10);
        const begin = str(version.start);
        const transition = transitions.find(t => str(t.from) === begin);
        if (!begin || !transition) {
            throw new Error(`Workflow '${options.name}' was created (version ${versionSysId}) but its Begin/End activities were not`);
        }
        return {
            workflowSysId: str(version.workflow),
            versionSysId,
            beginActivitySysId: begin,
            endActivitySysId: str(transition.to),
            beginConditionSysId: str(transition.condition),
            transitionSysId: str(transition.sys_id),
        };
    }

    /**
     * Check a workflow out for editing. Like the editor, this creates a draft version —
     * a full copy of the published one — checked out to the current user. If the
     * current user already has a draft, that draft is returned.
     *
     * @param workflow Workflow name, wf_workflow sys_id or a version sys_id
     * @throws Error when another user has it checked out (unless `force`)
     */
    public async checkout(workflow: string, options: CheckoutOptions = {}): Promise<CheckoutResult> {
        const summary = await this.resolveWorkflow(workflow);
        const draft = summary.checkedOutVersion;
        if (draft) {
            if (draft.byCurrentUser) {
                return { workflowSysId: summary.sysId, versionSysId: draft.sysId, alreadyCheckedOut: true };
            }
            if (!options.force) {
                throw new Error(`Workflow '${summary.name}' is checked out by ${draft.checkedOutByName || draft.checkedOutBy} `
                    + `(since ${draft.checkedOutOn}). Pass force to take over the checkout.`);
            }
            const graph = await this._diagram.forceCheckout(summary.publishedVersionSysId ?? draft.sysId);
            this._logger.info(`Force-checked out workflow '${summary.name}' as version ${graph.id}`);
            return { workflowSysId: summary.sysId, versionSysId: graph.id, alreadyCheckedOut: false };
        }
        if (!summary.publishedVersionSysId) {
            throw new Error(`Workflow '${summary.name}' has no published version to check out`);
        }
        const graph = await this._diagram.checkout(summary.publishedVersionSysId, summary.name);
        if (graph.id === summary.publishedVersionSysId || graph.readOnly) {
            throw new Error(`Workflow '${summary.name}' could not be checked out (${graph.statusDisplay || 'no draft was created'})`);
        }
        this._logger.info(`Checked out workflow '${summary.name}' as version ${graph.id}`);
        return { workflowSysId: summary.sysId, versionSysId: graph.id, alreadyCheckedOut: false };
    }

    /**
     * The draft version of a workflow that the current user has checked out.
     *
     * @param workflow Workflow name, wf_workflow sys_id or a version sys_id
     * @throws Error when the workflow is not checked out, or is checked out by someone else
     */
    public async getDraftVersion(workflow: string): Promise<string> {
        const summary = await this.resolveWorkflow(workflow);
        const draft = summary.checkedOutVersion;
        if (!draft) throw new Error(`Workflow '${summary.name}' is not checked out. Check it out first.`);
        if (!draft.byCurrentUser) {
            throw new Error(`Workflow '${summary.name}' is checked out by ${draft.checkedOutByName || draft.checkedOutBy}, not the current user.`);
        }
        return draft.sysId;
    }

    /**
     * Publish a checked-out draft, as the editor's Publish does: validate, publish, and
     * retire the previously published version. The instance records the whole workflow
     * in the current update set.
     *
     * @throws WorkflowValidationError when validation finds critical problems, or
     *         warnings without `allowWarnings`
     */
    public async publish(versionSysId: string, options: PublishOptions = {}): Promise<PublishResult> {
        await this.requireDraft(versionSysId);

        let outcome = await this._diagram.publish(versionSysId, true);
        let warnings: WorkflowValidationItem[] = [];

        if (outcome.messages.validationCritical !== undefined) {
            const items = await this.findingsOrEmpty(versionSysId);
            throw new WorkflowValidationError(versionSysId, 'critical', firstLine(outcome.messages.validationCritical, items), items);
        }
        if (outcome.messages.validationWarning !== undefined) {
            const items = await this.findingsOrEmpty(versionSysId);
            if (!options.allowWarnings) {
                throw new WorkflowValidationError(versionSysId, 'warning', firstLine(outcome.messages.validationWarning, items), items);
            }
            warnings = items;
            outcome = await this._diagram.publish(versionSysId, false);
        }

        if (!outcome.graph?.published) {
            throw new Error(`Workflow version ${versionSysId} was not published`);
        }
        this._logger.info(`Published workflow version ${versionSysId}`);
        return { versionSysId, warnings, fullSequences: outcome.graph.fullSequences };
    }

    /**
     * Throw away a checked-out draft, keeping the published version.
     *
     * @throws Error when the draft is the workflow's only version (use deleteWorkflow)
     */
    public async discardCheckout(versionSysId: string): Promise<void> {
        const version = await this.requireDraft(versionSysId);
        const others = await this.read(WorkflowManager.WF_WORKFLOW_VERSION, `workflow=${str(version.workflow)}^sys_id!=${versionSysId}`, 'sys_id', 1);
        if (!others.length) {
            throw new Error(`Version ${versionSysId} is the only version of workflow '${str(version.name)}'; `
                + 'discarding it would delete the workflow. Use deleteWorkflow() to do that.');
        }
        await this._diagram.delete(versionSysId);
        if ((await this.read(WorkflowManager.WF_WORKFLOW_VERSION, `sys_id=${versionSysId}`, 'sys_id', 1)).length) {
            throw new Error(`Draft version ${versionSysId} was not deleted`);
        }
        this._logger.info(`Discarded draft version ${versionSysId}`);
    }

    /**
     * Delete a workflow and every version of it.
     *
     * @param workflow Workflow name, wf_workflow sys_id or a version sys_id
     */
    public async deleteWorkflow(workflow: string): Promise<void> {
        const summary = await this.resolveWorkflow(workflow);
        const versions = await this.getWorkflowVersions(summary.sysId);
        // Drafts first, the published version last: the parent workflow goes with its last version.
        const ordered = [...versions].sort((a, b) => Number(a.published) - Number(b.published));
        for (const version of ordered) await this._diagram.delete(version.sysId);
        if ((await this.read(WorkflowManager.WF_WORKFLOW, `sys_id=${summary.sysId}`, 'sys_id', 1)).length) {
            throw new Error(`Workflow '${summary.name}' was not fully deleted`);
        }
        this._logger.info(`Deleted workflow '${summary.name}' (${versions.length} versions)`);
    }

    /**
     * Activate or deactivate a workflow (the editor's Set Active / Set Inactive).
     *
     * @param versionSysId The published version
     */
    public async setWorkflowActive(versionSysId: string, active: boolean): Promise<void> {
        this.requireSysId(versionSysId, 'versionSysId');
        await this._diagram.setActive(versionSysId, active);
    }

    /**
     * Change a draft's workflow properties.
     */
    public async updateWorkflowProperties(versionSysId: string, options: UpdateWorkflowPropertiesOptions): Promise<void> {
        await this.requireDraft(versionSysId);
        const body: Record<string, unknown> = { ...(options.fields ?? {}) };
        if (options.name !== undefined) body.name = options.name;
        if (options.description !== undefined) body.description = options.description;
        if (options.condition !== undefined) body.condition = options.condition;
        if (options.conditionType !== undefined) body.condition_type = options.conditionType;
        if (!Object.keys(body).length) return;
        const response = await this._tableAPI.put<WorkflowRecordResponse>(WorkflowManager.WF_WORKFLOW_VERSION, versionSysId, body);
        if (response?.status !== 200) {
            throw new Error(`Failed to update workflow version ${versionSysId}. Status: ${response?.status ?? 'unknown'}`);
        }
    }

    // ============================================================
    // Editing a checked-out draft (Workflow Editor parity)
    // ============================================================

    /**
     * Add an activity to a checked-out draft, configured with variables, and optionally
     * wire it in. The activity is created through the editor's activity form, so its
     * variables are written and its default exits are created exactly as in the UI.
     */
    public async addActivity(versionSysId: string, options: AddActivityOptions): Promise<AddActivityResult> {
        await this.requireDraft(versionSysId);
        if (!options?.name || options.name.trim().length === 0) throw new InvalidParameterException('Activity name is required');
        const definition = await this.resolveActivityDefinition(options.definition);

        const insertOn = options.insertOn ? await this.readTransition(versionSysId, options.insertOn) : undefined;
        const from = options.connectFrom ? await this.readActivity(options.connectFrom.activity, versionSysId) : undefined;
        if (options.connectTo) await this.readActivity(options.connectTo, versionSysId);

        let x = options.x;
        let y = options.y;
        if (x === undefined || y === undefined) {
            const position = this.defaultPosition(insertOn, from);
            x = x ?? position.x;
            y = y ?? position.y;
        }

        const fields: Record<string, FormValueInput> = { name: options.name, x, y };
        if (options.stage !== undefined) fields.stage = await this.resolveStage(versionSysId, options.stage);
        if (options.input !== undefined) fields.input = typeof options.input === 'string' ? options.input : JSON.stringify(options.input);

        this._logger.info(`Adding ${definition.name} activity '${options.name}' to version ${versionSysId}`);
        const written = await this._forms.insert(WorkflowManager.WF_ACTIVITY, {
            view: WorkflowManager.ACTIVITY_VIEW,
            initialQuery: `workflow_version=${versionSysId}^activity_definition=${definition.sysId}`,
            fields,
            variables: options.variables && Object.keys(options.variables).length ? options.variables : undefined,
        });
        const activitySysId = written.sysId;
        const conditions = await this.readConditions(activitySysId);

        const transitionSysIds: string[] = [];
        if (insertOn) {
            const exit = this.pickExit(conditions, options.exitCondition, options.name, true);
            const outgoing: WorkflowGraphEdge = { id: newSysId(), source: activitySysId, sourcePort: exit.sysId, target: insertOn.to };
            await this._diagram.newEdgeControlNode(versionSysId, { id: activitySysId, x, y },
                [{ id: insertOn.sysId, source: insertOn.from, sourcePort: insertOn.condition, target: activitySysId }], [outgoing]);
            transitionSysIds.push(insertOn.sysId, outgoing.id);
        }
        if (from) {
            const exit = this.pickExit(await this.readConditions(from.sysId), options.connectFrom.condition, from.name, false);
            const edge: WorkflowGraphEdge = { id: newSysId(), source: from.sysId, sourcePort: exit.sysId, target: activitySysId };
            await this._diagram.newEdge(versionSysId, edge);
            transitionSysIds.push(edge.id);
        }
        if (options.connectTo) {
            const exit = this.pickExit(conditions, options.exitCondition, options.name, true);
            const edge: WorkflowGraphEdge = { id: newSysId(), source: activitySysId, sourcePort: exit.sysId, target: options.connectTo };
            await this._diagram.newEdge(versionSysId, edge);
            transitionSysIds.push(edge.id);
        }
        await this._diagram.updateStages(versionSysId);

        return { activitySysId, name: options.name, conditions, transitionSysIds };
    }

    /**
     * Change an activity on a checked-out draft. Variables you do not pass keep their values.
     */
    public async updateActivity(activitySysId: string, options: UpdateActivityOptions): Promise<void> {
        const activity = await this.readActivity(activitySysId);
        await this.requireDraft(activity.versionSysId);

        const fields: Record<string, FormValueInput> = {};
        if (options.name !== undefined) fields.name = options.name;
        if (options.stage !== undefined) fields.stage = await this.resolveStage(activity.versionSysId, options.stage);
        if (options.input !== undefined) fields.input = typeof options.input === 'string' ? options.input : JSON.stringify(options.input);
        const variables = options.variables && Object.keys(options.variables).length ? options.variables : undefined;

        if (Object.keys(fields).length || variables) {
            await this._forms.update(WorkflowManager.WF_ACTIVITY, activitySysId, {
                view: WorkflowManager.ACTIVITY_VIEW, fields, variables,
            });
        }
        if (options.x !== undefined || options.y !== undefined) {
            await this._diagram.moveNodes(activity.versionSysId, [{
                id: activitySysId, x: options.x ?? activity.x ?? 0, y: options.y ?? activity.y ?? 0,
            }]);
        }
        if (fields.stage !== undefined) await this._diagram.updateStages(activity.versionSysId);
    }

    /**
     * Remove an activity (with its exits and variables) from a checked-out draft.
     */
    public async removeActivity(activitySysId: string, options: RemoveActivityOptions = {}): Promise<void> {
        const activity = await this.readActivity(activitySysId);
        await this.requireDraft(activity.versionSysId);
        if (/(^|,)\s*(begin|end)\s*=\s*true/i.test(activity.definitionAttributes)) {
            throw new InvalidParameterException(`'${activity.name}' is the workflow's ${activity.definitionName} activity and cannot be removed`);
        }

        const touching = (await this.read(WorkflowManager.WF_TRANSITION, `from=${activitySysId}^ORto=${activitySysId}`, 'sys_id,from,to,condition', 1000))
            .map(toEdge);
        const incoming = touching.filter(e => e.target === activitySysId && e.source !== activitySysId);
        const outgoing = touching.filter(e => e.source === activitySysId);

        if (options.reconnect) {
            if (incoming.length !== 1 || outgoing.length !== 1) {
                throw new InvalidParameterException(`Cannot reconnect around '${activity.name}': it has ${incoming.length} incoming `
                    + `and ${outgoing.length} outgoing transitions (exactly one of each is needed)`);
            }
            const joined: WorkflowGraphEdge = { ...incoming[0], target: outgoing[0].target };
            // The path may already exist; the editor never draws the same exit-to-target twice.
            const duplicate = await this.read(WorkflowManager.WF_TRANSITION,
                `condition=${joined.sourcePort}^to=${joined.target}^sys_id!=${joined.id}`, 'sys_id', 1);
            if (duplicate.length) {
                await this._diagram.deleteNode(activity.versionSysId, activitySysId, [...incoming, ...outgoing]);
            } else {
                await this._diagram.deleteNode(activity.versionSysId, activitySysId, outgoing, [joined]);
            }
        } else {
            await this._diagram.deleteNode(activity.versionSysId, activitySysId, touching);
        }

        if ((await this.read(WorkflowManager.WF_ACTIVITY, `sys_id=${activitySysId}`, 'sys_id', 1)).length) {
            throw new Error(`Activity '${activity.name}' was not removed`);
        }
        this._logger.info(`Removed activity '${activity.name}' from version ${activity.versionSysId}`);
    }

    /**
     * Reposition activities on checked-out drafts.
     */
    public async moveActivities(positions: ActivityPosition[]): Promise<void> {
        const byVersion = new Map<string, ActivityPosition[]>();
        for (const position of positions ?? []) {
            const activity = await this.readActivity(position.sysId);
            byVersion.set(activity.versionSysId, [...(byVersion.get(activity.versionSysId) ?? []), position]);
        }
        for (const [versionSysId, moves] of byVersion) {
            await this.requireDraft(versionSysId);
            await this._diagram.moveNodes(versionSysId, moves.map(m => ({ id: m.sysId, x: m.x, y: m.y })));
        }
    }

    /**
     * Add a transition on a checked-out draft.
     *
     * @returns The new transition's sys_id
     */
    public async addTransition(options: AddTransitionOptions): Promise<string> {
        const from = await this.readActivity(options.from);
        await this.requireDraft(from.versionSysId);
        await this.readActivity(options.to, from.versionSysId);
        const exit = this.pickExit(await this.readConditions(from.sysId), options.condition, from.name, false);

        const existing = await this.read(WorkflowManager.WF_TRANSITION, `condition=${exit.sysId}^to=${options.to}`, 'sys_id', 1);
        if (existing.length) throw new InvalidParameterException(`'${from.name}' (${exit.name}) already leads to that activity (${str(existing[0].sys_id)})`);

        const edge: WorkflowGraphEdge = { id: newSysId(), source: from.sysId, sourcePort: exit.sysId, target: options.to };
        await this._diagram.newEdge(from.versionSysId, edge);
        return edge.id;
    }

    /**
     * Point an existing transition at a different activity on a checked-out draft.
     */
    public async retargetTransition(transitionSysId: string, toActivitySysId: string): Promise<void> {
        const transition = await this.readTransition(undefined, transitionSysId);
        await this.requireDraft(transition.versionSysId);
        await this.readActivity(toActivitySysId, transition.versionSysId);
        await this._diagram.changeEdge(transition.versionSysId, {
            id: transition.sysId, source: transition.from, sourcePort: transition.condition, target: toActivitySysId,
        });
    }

    /**
     * Remove a transition from a checked-out draft.
     */
    public async removeTransition(transitionSysId: string): Promise<void> {
        const transition = await this.readTransition(undefined, transitionSysId);
        await this.requireDraft(transition.versionSysId);
        await this._diagram.deleteEdge(transition.versionSysId, {
            id: transition.sysId, source: transition.from, sourcePort: transition.condition, target: transition.to,
        });
    }

    /**
     * Add an exit to an activity on a checked-out draft.
     *
     * @returns The new condition's sys_id
     */
    public async addCondition(options: AddConditionOptions): Promise<string> {
        const activity = await this.readActivity(options.activity);
        await this.requireDraft(activity.versionSysId);
        if (!options.name || !options.condition) throw new InvalidParameterException('Condition name and condition are required');

        const body: Record<string, unknown> = { activity: activity.sysId, name: options.name, condition: options.condition };
        if (options.order !== undefined) body.order = options.order;
        if (options.elseFlag !== undefined) body.else_flag = options.elseFlag;
        if (options.error !== undefined) body.error = options.error;
        if (options.shortDescription !== undefined) body.short_description = options.shortDescription;

        const response = await this._tableAPI.post<WorkflowRecordResponse>(WorkflowManager.WF_CONDITION, {}, body);
        const sysId = response?.bodyObject?.result?.sys_id;
        if (!sysId) throw new Error(`Failed to add condition '${options.name}'. Status: ${response?.status ?? 'unknown'}`);
        return sysId;
    }

    /**
     * Change an exit on a checked-out draft.
     */
    public async updateCondition(conditionSysId: string, options: UpdateConditionOptions): Promise<void> {
        const condition = await this.readCondition(conditionSysId);
        await this.requireDraft(condition.versionSysId);
        const body: Record<string, unknown> = {};
        if (options.name !== undefined) body.name = options.name;
        if (options.condition !== undefined) body.condition = options.condition;
        if (options.order !== undefined) body.order = options.order;
        if (options.elseFlag !== undefined) body.else_flag = options.elseFlag;
        if (options.error !== undefined) body.error = options.error;
        if (options.shortDescription !== undefined) body.short_description = options.shortDescription;
        if (!Object.keys(body).length) return;
        const response = await this._tableAPI.put<WorkflowRecordResponse>(WorkflowManager.WF_CONDITION, conditionSysId, body);
        if (response?.status !== 200) throw new Error(`Failed to update condition ${conditionSysId}. Status: ${response?.status ?? 'unknown'}`);
    }

    /**
     * Remove an exit, and the transitions leaving from it, from a checked-out draft.
     */
    public async removeCondition(conditionSysId: string): Promise<void> {
        const condition = await this.readCondition(conditionSysId);
        await this.requireDraft(condition.versionSysId);
        const leaving = (await this.read(WorkflowManager.WF_TRANSITION, `condition=${conditionSysId}`, 'sys_id,from,to,condition', 1000)).map(toEdge);
        for (const edge of leaving) await this._diagram.deleteEdge(condition.versionSysId, edge);
        await this.request().delete({
            method: 'DELETE', path: `/api/now/table/${WorkflowManager.WF_CONDITION}/${conditionSysId}`,
            headers: { Accept: 'application/json' }, query: null, body: null,
        });
    }

    // ============================================================
    // Internals
    // ============================================================

    private async createActivityThroughForm(options: CreateActivityOptions): Promise<CreateActivityResult> {
        if (!options.activityDefinitionSysId) {
            throw new Error('activityDefinitionSysId is required when variables are given');
        }
        const fields: Record<string, FormValueInput> = { name: options.name };
        if (options.x !== undefined) fields.x = options.x;
        if (options.y !== undefined) fields.y = options.y;
        if (options.width !== undefined) fields.width = options.width;
        if (options.height !== undefined) fields.height = options.height;
        const written = await this._forms.insert(WorkflowManager.WF_ACTIVITY, {
            view: WorkflowManager.ACTIVITY_VIEW,
            initialQuery: `workflow_version=${options.workflowVersionSysId}^activity_definition=${options.activityDefinitionSysId}`,
            fields,
            variables: Object.keys(options.variables).length ? options.variables : undefined,
        });
        this._logger.info(`Created activity '${options.name}' with sys_id=${written.sysId}`);
        return { activitySysId: written.sysId, name: options.name };
    }

    private async summarize(workflows: Row[]): Promise<WorkflowSummary[]> {
        if (!workflows.length) return [];
        const ids = workflows.map(w => str(w.sys_id));
        const versions = await this.read(WorkflowManager.WF_WORKFLOW_VERSION,
            `workflowIN${ids.join(',')}^published=true^ORchecked_outISNOTEMPTY`, VERSION_FIELDS, 10000);
        const me = versions.some(v => str(v.published) !== 'true' && str(v.checked_out_by)) ? await this.currentUserSysId() : '';
        return workflows.map(row => {
            const own = versions.filter(v => str(v.workflow) === str(row.sys_id));
            const published = own.find(v => str(v.published) === 'true');
            const draft = own.find(v => str(v.published) !== 'true' && str(v.checked_out_by));
            const summary: WorkflowSummary = {
                sysId: str(row.sys_id),
                name: str(row.name),
                table: str(row.table),
                description: str(row.description),
                active: str((published ?? draft)?.active) === 'true',
            };
            if (published) summary.publishedVersionSysId = str(published.sys_id);
            if (draft) {
                summary.checkedOutVersion = {
                    sysId: str(draft.sys_id),
                    checkedOutBy: str(draft.checked_out_by),
                    checkedOutByName: str(draft['checked_out_by.name']) || undefined,
                    checkedOutOn: str(draft.checked_out),
                    byCurrentUser: str(draft.checked_out_by) === me,
                };
            }
            return summary;
        });
    }

    private async readVersion(versionSysId: string): Promise<Row> {
        const rows = await this.read(WorkflowManager.WF_WORKFLOW_VERSION, `sys_id=${versionSysId}`, VERSION_FIELDS, 1);
        if (!rows.length) throw new InvalidParameterException(`Workflow version ${versionSysId} was not found`);
        return rows[0];
    }

    /**
     * Editing is only allowed on an unpublished draft checked out to the current user —
     * the same rule the editor enforces (and the wf_condition ACLs require a checkout).
     */
    private async requireDraft(versionSysId: string): Promise<Row> {
        this.requireSysId(versionSysId, 'versionSysId');
        const version = await this.readVersion(versionSysId);
        if (str(version.published) === 'true') {
            throw new Error(`Workflow version ${versionSysId} ('${str(version.name)}') is published. Check the workflow out and edit the draft.`);
        }
        const holder = str(version.checked_out_by);
        if (!holder) {
            throw new Error(`Workflow version ${versionSysId} ('${str(version.name)}') is not checked out; it is a retired version.`);
        }
        if (holder !== await this.currentUserSysId()) {
            throw new Error(`Workflow version ${versionSysId} ('${str(version.name)}') is checked out by ${str(version['checked_out_by.name']) || holder}.`);
        }
        return version;
    }

    private async readActivity(activitySysId: string, versionSysId?: string): Promise<{
        sysId: string; name: string; versionSysId: string; definitionName: string; definitionAttributes: string; x?: number; y?: number;
    }> {
        this.requireSysId(activitySysId, 'activity sys_id');
        const rows = await this.read(WorkflowManager.WF_ACTIVITY, `sys_id=${activitySysId}`,
            'sys_id,name,workflow_version,activity_definition.name,activity_definition.attributes,x,y', 1);
        if (!rows.length) throw new InvalidParameterException(`Activity ${activitySysId} was not found`);
        const row = rows[0];
        if (versionSysId && str(row.workflow_version) !== versionSysId) {
            throw new InvalidParameterException(`Activity ${activitySysId} ('${str(row.name)}') belongs to a different workflow version`);
        }
        return {
            sysId: activitySysId,
            name: str(row.name),
            versionSysId: str(row.workflow_version),
            definitionName: str(row['activity_definition.name']),
            definitionAttributes: str(row['activity_definition.attributes']),
            x: optNum(row.x),
            y: optNum(row.y),
        };
    }

    private async readTransition(versionSysId: string | undefined, transitionSysId: string): Promise<{
        sysId: string; from: string; to: string; condition: string; versionSysId: string;
        fromX?: number; fromY?: number; toX?: number; toY?: number;
    }> {
        this.requireSysId(transitionSysId, 'transition sys_id');
        const rows = await this.read(WorkflowManager.WF_TRANSITION, `sys_id=${transitionSysId}`,
            'sys_id,from,to,condition,from.workflow_version,from.x,from.y,to.x,to.y', 1);
        if (!rows.length) throw new InvalidParameterException(`Transition ${transitionSysId} was not found`);
        const row = rows[0];
        const owner = str(row['from.workflow_version']);
        if (versionSysId && owner !== versionSysId) {
            throw new InvalidParameterException(`Transition ${transitionSysId} belongs to a different workflow version`);
        }
        return {
            sysId: transitionSysId, from: str(row.from), to: str(row.to), condition: str(row.condition), versionSysId: owner,
            fromX: optNum(row['from.x']), fromY: optNum(row['from.y']), toX: optNum(row['to.x']), toY: optNum(row['to.y']),
        };
    }

    private async readCondition(conditionSysId: string): Promise<WorkflowConditionInfo & { versionSysId: string }> {
        this.requireSysId(conditionSysId, 'condition sys_id');
        const rows = await this.read(WorkflowManager.WF_CONDITION, `sys_id=${conditionSysId}`, `${CONDITION_FIELDS},activity.workflow_version`, 1);
        if (!rows.length) throw new InvalidParameterException(`Condition ${conditionSysId} was not found`);
        return { ...toCondition(rows[0]), versionSysId: str(rows[0]['activity.workflow_version']) };
    }

    private async readConditions(activitySysId: string): Promise<WorkflowConditionInfo[]> {
        return (await this.read(WorkflowManager.WF_CONDITION, `activity=${activitySysId}^ORDERBYorder`, CONDITION_FIELDS, 500)).map(toCondition);
    }

    private async readVariableValues(activitySysIds: string[]): Promise<Map<string, Record<string, string>>> {
        const values = new Map<string, Record<string, string>>();
        for (let i = 0; i < activitySysIds.length; i += 100) {
            const chunk = activitySysIds.slice(i, i + 100);
            const rows = await this.read('sys_variable_value',
                `document=wf_activity^document_keyIN${chunk.join(',')}^ORDERBYorder`, 'document_key,variable.element,value', 10000);
            for (const row of rows) {
                const key = str(row.document_key);
                const element = str(row['variable.element']);
                if (!element) continue;
                values.set(key, { ...(values.get(key) ?? {}), [element]: str(row.value) });
            }
        }
        return values;
    }

    private async resolveActivityDefinition(nameOrSysId: string): Promise<ActivityDefinitionSummary> {
        const ref = (nameOrSysId ?? '').trim();
        if (!ref) throw new InvalidParameterException('An activity definition name or sys_id is required');
        const fields = 'sys_id,name,category,sys_class_name';
        let rows = SYS_ID.test(ref) ? await this.read('wf_element_definition', `sys_id=${ref}`, fields, 1) : [];
        if (!rows.length) rows = await this.read('wf_element_definition', `name=${queryValue(ref, 'activity definition name')}`, fields, 20);
        if (!rows.length) throw new InvalidParameterException(`No activity definition found for '${ref}'`);
        if (rows.length > 1) {
            // A core activity wins over same-named Activity Designer ones.
            const core = rows.filter(r => str(r.sys_class_name) === 'wf_activity_definition');
            if (core.length === 1) rows = core;
            else {
                throw new InvalidParameterException(`'${ref}' matches ${rows.length} activity definitions; use a sys_id: `
                    + rows.map(r => `${str(r.sys_id)} (${str(r.sys_class_name)}${str(r.category) ? `, ${str(r.category)}` : ''})`).join(', '));
            }
        }
        return toDefinitionSummary(rows[0]);
    }

    private async resolveStage(versionSysId: string, stage: string): Promise<string> {
        if (stage === '') return '';
        const stages = await this.read('wf_stage', `workflow_version=${versionSysId}`, 'sys_id,name,value', 1000);
        const match = stages.find(s => str(s.sys_id) === stage)
            ?? stages.find(s => str(s.name).toLowerCase() === stage.toLowerCase())
            ?? stages.find(s => str(s.value).toLowerCase() === stage.toLowerCase());
        if (!match) {
            const known = stages.map(s => str(s.name)).join(', ') || '(this version has no stages)';
            throw new InvalidParameterException(`No stage '${stage}' on workflow version ${versionSysId}. Available: ${known}`);
        }
        return str(match.sys_id);
    }

    /**
     * Pick an exit by name or sys_id. With no reference, a single exit is unambiguous;
     * for several, `firstWhenAmbiguous` takes the first in order (what the editor does
     * when you drop onto a line), otherwise the caller must choose.
     */
    private pickExit(conditions: WorkflowConditionInfo[], ref: string | undefined, activityName: string, firstWhenAmbiguous: boolean): WorkflowConditionInfo {
        if (!conditions.length) throw new InvalidParameterException(`'${activityName}' has no exits to connect from`);
        const names = conditions.map(c => c.name).join(', ');
        if (ref) {
            const match = conditions.find(c => c.sysId === ref) ?? conditions.find(c => c.name.toLowerCase() === ref.toLowerCase());
            if (!match) throw new InvalidParameterException(`'${activityName}' has no exit '${ref}'. Exits: ${names}`);
            return match;
        }
        if (conditions.length === 1 || firstWhenAmbiguous) return conditions[0];
        throw new InvalidParameterException(`'${activityName}' has several exits; specify one of: ${names}`);
    }

    private defaultPosition(
        insertOn: { fromX?: number; fromY?: number; toX?: number; toY?: number } | undefined,
        from: { x?: number; y?: number } | undefined,
    ): { x: number; y: number } {
        if (insertOn) {
            return {
                x: Math.round(((insertOn.fromX ?? 0) + (insertOn.toX ?? 0)) / 2),
                y: Math.round(((insertOn.fromY ?? 0) + (insertOn.toY ?? 0)) / 2),
            };
        }
        if (from) return { x: (from.x ?? 0) + 180, y: from.y ?? 0 };
        return { x: 200, y: 200 };
    }

    /**
     * The version to read for a workflow reference: a version sys_id as is; otherwise the
     * current user's draft and/or the published version, as asked.
     */
    private async resolveVersionToRead(ref: string, which: 'current' | 'published' | 'draft'): Promise<string> {
        if (SYS_ID.test(ref ?? '') && (await this.read(WorkflowManager.WF_WORKFLOW_VERSION, `sys_id=${ref}`, 'sys_id', 1)).length) {
            return ref;
        }
        const summary = await this.resolveWorkflow(ref);
        const mine = summary.checkedOutVersion?.byCurrentUser ? summary.checkedOutVersion.sysId : undefined;
        const chosen = which === 'draft' ? mine
            : which === 'published' ? summary.publishedVersionSysId
                : mine ?? summary.publishedVersionSysId ?? summary.checkedOutVersion?.sysId;
        if (!chosen) throw new Error(`Workflow '${summary.name}' has no ${which === 'current' ? 'readable' : which} version`);
        return chosen;
    }

    /**
     * Whether a core activity type can pause the workflow, read from its handler script:
     * it sets `activity.state` / `executing.state` to `'waiting'`, itself or in a handler it
     * extends. Some only wait conditionally (tasks honour `wait_for_completion`).
     */
    private async typeWaits(detail: ActivityDefinitionDetail): Promise<boolean | undefined> {
        if (detail.sysClassName !== 'wf_activity_definition') return undefined;
        let query = `sys_id=${detail.sysId}`;
        for (let depth = 0; depth < 5; depth++) {
            const rows = await this.read('wf_activity_definition', query, 'script', 1);
            if (!rows.length) return undefined;
            const script = str(rows[0].script);
            if (/\b(activity|executing)\.state\s*=\s*['"]waiting['"]/.test(script)) return true;
            const parent = /extendsObject\(\s*(\w+)ActivityHandler\b/.exec(script)?.[1];
            if (!parent || parent === 'WF') return false;
            query = `js_class_name=${parent}`;
        }
        return false;
    }

    /** Display names for sys_ids, grouped by table. Unknown tables or records are skipped. */
    private async displayNames(wanted: Map<string, Set<string>>): Promise<Record<string, { table: string; display: string }>> {
        const names: Record<string, { table: string; display: string }> = {};
        await mapLimit([...wanted.entries()], 2, async ([table, ids]) => {
            if (!/^[a-z0-9_]+$/i.test(table)) return;
            const list = [...ids];
            for (let i = 0; i < list.length; i += 100) {
                let rows: Row[] = [];
                try {
                    rows = await this.read(table, `sys_idIN${list.slice(i, i + 100).join(',')}`,
                        'sys_id,name,label,question_text,user_name,number,short_description,title', 100);
                } catch {
                    return;
                }
                for (const row of rows) {
                    const display = ['name', 'question_text', 'label', 'title', 'user_name', 'number', 'short_description']
                        .map(f => str(row[f])).find(Boolean);
                    if (display) names[str(row.sys_id)] = { table, display };
                }
            }
        });
        return names;
    }

    private async findingsOrEmpty(versionSysId: string): Promise<WorkflowValidationItem[]> {
        try {
            const report = await this.validateWorkflow(versionSysId);
            return report.items.filter(i => i.level === 'Warn' || i.level === 'Critical');
        } catch (error) {
            this._logger.warn(`Could not read validation details for ${versionSysId}: ${(error as Error).message}`);
            return [];
        }
    }

    private async currentUserSysId(): Promise<string> {
        if (this._currentUser === undefined) {
            this._currentUser = this.read('sys_user', 'sys_id=javascript:gs.getUserID()', 'sys_id', 1).then(rows => {
                const id = str(rows[0]?.sys_id);
                if (!id) throw new Error('Could not determine the current user');
                return id;
            });
            this._currentUser.catch(() => { this._currentUser = undefined; });
        }
        return this._currentUser;
    }

    private async read(table: string, query: string, fields: string, limit: number): Promise<Row[]> {
        const params = { sysparm_query: query, sysparm_fields: fields, sysparm_limit: String(limit), sysparm_exclude_reference_link: 'true' };
        let response = await this._tableAPI.get<{ result: Row[] }>(table, params);
        // 202: the instance queued the request behind others in this session; ask again.
        for (let attempt = 1; response?.status === 202 && attempt <= 3; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 500 * attempt));
            response = await this._tableAPI.get<{ result: Row[] }>(table, params);
        }
        if (response?.status !== 200 || !Array.isArray(response.bodyObject?.result)) {
            throw new Error(`Failed to read ${table}. Status: ${response?.status ?? 'unknown'}`);
        }
        return response.bodyObject.result;
    }

    private async count(table: string, query: string): Promise<number> {
        const response = await this.request().get<{ result?: { stats?: { count?: string } } }>({
            method: 'GET', path: `/api/now/stats/${table}`, headers: { Accept: 'application/json' }, body: null,
            query: { sysparm_query: query, sysparm_count: 'true' },
        });
        return Number(response.bodyObject?.result?.stats?.count ?? 0) || 0;
    }

    private request(): ServiceNowRequest {
        return SessionManager.getInstance().getRequest(this._instance);
    }

    private requireSysId(value: string, label: string): void {
        if (!SYS_ID.test(value ?? '')) throw new InvalidParameterException(`${label} must be a 32-character sys_id`);
    }
}

function str(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value && typeof value === 'object' && 'value' in value) return str((value as Row).value);
    return '';
}

function num(value: unknown): number {
    return Number(str(value)) || 0;
}

function optNum(value: unknown): number | undefined {
    const text = str(value);
    if (text === '') return undefined;
    const n = Number(text);
    return Number.isFinite(n) ? n : undefined;
}

/** A value embedded in an encoded query must not be able to add conditions of its own. */
function queryValue(value: string, label: string): string {
    if (/[\^\r\n]/.test(value)) throw new InvalidParameterException(`The ${label} cannot contain '^' or line breaks`);
    return value;
}

function normalizeSpace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function parseJsonObject(text: string): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
        // fall through: keep the raw text
    }
    return { raw: text };
}

/** Map with at most `limit` calls in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array<R>(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

function newSysId(): string {
    return randomBytes(16).toString('hex');
}

function decodeEntities(text: string): string {
    return text
        .replace(/&nbsp;/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

/** The processor's validation text is a canned prompt; the report summary line says more. */
function firstLine(message: string, items: WorkflowValidationItem[]): string {
    const summary = /Validate Summary[^\n]*/.exec(message)?.[0]?.replace(/\s+/g, ' ').trim();
    return summary || message.split('\n')[0] || `${items.length} findings`;
}

/** Parse Activity Designer `input_meta` / `output_meta` (a DATA_OBJECT with properties). */
function designerFields(meta: string): ActivityDesignerField[] {
    if (!meta) return [];
    try {
        const parsed = JSON.parse(meta) as { properties?: Array<{ name?: string; type?: string; mandatory?: boolean }> };
        return (parsed.properties ?? []).map(p => ({ name: String(p.name ?? ''), type: String(p.type ?? ''), mandatory: p.mandatory === true }));
    } catch {
        return [];
    }
}

function toEdge(row: Row): WorkflowGraphEdge {
    return { id: str(row.sys_id), source: str(row.from), sourcePort: str(row.condition), target: str(row.to) };
}

function toCondition(row: Row): WorkflowConditionInfo {
    return {
        sysId: str(row.sys_id),
        activitySysId: str(row.activity),
        name: str(row.name),
        condition: str(row.condition),
        order: num(row.order),
        elseFlag: str(row.else_flag) === 'true',
        error: str(row.error) === 'true',
        event: str(row.event) === 'true',
        eventName: str(row.event_name),
        shortDescription: str(row.short_description),
        skipDuringGenerate: str(row.skip_during_generate) === 'true',
    };
}

function toDefinitionSummary(row: Row): ActivityDefinitionSummary {
    return { sysId: str(row.sys_id), name: str(row.name), category: str(row.category), sysClassName: str(row.sys_class_name) };
}

function toVersionSummary(row: Row): WorkflowVersionSummary {
    return {
        sysId: str(row.sys_id),
        workflowSysId: str(row.workflow),
        name: str(row.name),
        table: str(row.table),
        published: str(row.published) === 'true',
        active: str(row.active) === 'true',
        checkedOut: str(row.checked_out),
        checkedOutBy: str(row.checked_out_by),
        createdOn: str(row.sys_created_on),
        updatedOn: str(row.sys_updated_on),
    };
}
