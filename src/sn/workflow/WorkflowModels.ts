/**
 * Models for workflow management operations in ServiceNow.
 */

import { FormValueInput } from '../../comm/http/FormRecordModels';
import { VariableDefinition } from '../variables/VariableModels';

// ============================================================
// Workflow Creation Options
// ============================================================

/**
 * Options for creating a workflow record.
 */
export interface CreateWorkflowOptions {
    /** Name of the workflow */
    name: string;

    /** Description of the workflow */
    description?: string;

    /** Whether this is a template workflow */
    template?: boolean;

    /** Access level (e.g., "public", "package_private") */
    access?: string;
}

/**
 * Result of creating a workflow.
 */
export interface CreateWorkflowResult {
    /** The sys_id of the created workflow */
    workflowSysId: string;

    /** The name of the created workflow */
    name: string;
}

// ============================================================
// Workflow Version Options
// ============================================================

/**
 * Options for creating a workflow version.
 */
export interface CreateWorkflowVersionOptions {
    /** Name of the workflow version */
    name: string;

    /** The sys_id of the parent workflow */
    workflowSysId: string;

    /** The table this workflow version applies to (e.g., "incident") */
    table: string;

    /** Description of the workflow version */
    description?: string;

    /** Whether the version is active */
    active?: boolean;

    /** Whether the version is published */
    published?: boolean;

    /** Condition expression for triggering the workflow */
    condition?: string;

    /** Execution order */
    order?: number;
}

/**
 * Result of creating a workflow version.
 */
export interface CreateWorkflowVersionResult {
    /** The sys_id of the created workflow version */
    versionSysId: string;

    /** The name of the created workflow version */
    name: string;
}

// ============================================================
// Activity Options
// ============================================================

/**
 * Options for creating a workflow activity.
 */
export interface CreateActivityOptions {
    /** Name of the activity */
    name: string;

    /** The sys_id of the workflow version this activity belongs to */
    workflowVersionSysId: string;

    /** The sys_id of the activity definition (type of activity) */
    activityDefinitionSysId?: string;

    /** X position on the workflow canvas */
    x?: number;

    /** Y position on the workflow canvas */
    y?: number;

    /** Width on the workflow canvas */
    width?: number;

    /** Height on the workflow canvas */
    height?: number;

    /** Script content for the activity */
    script?: string;

    /** Activity variables (JSON string or comma-separated key=value pairs) */
    vars?: string;

    /**
     * Variable values keyed by element name. When set, the activity is created through
     * the wf_activity form, which is what writes variables; `activityDefinitionSysId` is
     * then required and `script`/`vars` are not used.
     */
    variables?: Record<string, FormValueInput>;
}

/**
 * Result of creating a workflow activity.
 */
export interface CreateActivityResult {
    /** The sys_id of the created activity */
    activitySysId: string;

    /** The name of the created activity */
    name: string;
}

// ============================================================
// Transition Options
// ============================================================

/**
 * Options for creating a workflow transition between activities.
 */
export interface CreateTransitionOptions {
    /** The sys_id of the source activity */
    fromActivitySysId: string;

    /** The sys_id of the target activity */
    toActivitySysId: string;

    /** The sys_id of an optional condition record */
    conditionSysId?: string;

    /** Execution order of this transition */
    order?: number;
}

/**
 * Result of creating a workflow transition.
 */
export interface CreateTransitionResult {
    /** The sys_id of the created transition */
    transitionSysId: string;
}

// ============================================================
// Condition Options
// ============================================================

/**
 * Options for creating a workflow condition.
 */
export interface CreateConditionOptions {
    /** The sys_id of the activity this condition belongs to */
    activitySysId: string;

    /** Name of the condition */
    name: string;

    /** Description of the condition */
    description?: string;

    /** Condition expression */
    condition?: string;

    /** Execution order */
    order?: number;

    /** Whether this is an else condition */
    elseFlag?: boolean;
}

/**
 * Result of creating a workflow condition.
 */
export interface CreateConditionResult {
    /** The sys_id of the created condition */
    conditionSysId: string;

    /** The name of the created condition */
    name: string;
}

// ============================================================
// Publish Options
// ============================================================

/**
 * Options for publishing a workflow version.
 */
export interface PublishWorkflowOptions {
    /** The sys_id of the workflow version to publish */
    versionSysId: string;

    /** The sys_id of the start activity */
    startActivitySysId: string;
}

// ============================================================
// Complete Workflow Spec (Orchestration)
// ============================================================

/**
 * Specification for a single activity in a complete workflow.
 */
export interface ActivitySpec {
    /** Optional unique identifier used for referencing in transitions */
    id?: string;

    /** Name of the activity */
    name: string;

    /** Script content for the activity */
    script?: string;

    /** The activity type / definition sys_id */
    activityType?: string;

    /** X position on the workflow canvas */
    x?: number;

    /** Y position on the workflow canvas */
    y?: number;

    /** Width on the workflow canvas */
    width?: number;

    /** Height on the workflow canvas */
    height?: number;

    /** Activity variables */
    vars?: string;

    /** Variable values keyed by element name (see CreateActivityOptions.variables) */
    variables?: Record<string, FormValueInput>;
}

/**
 * Specification for a transition between activities in a complete workflow.
 */
export interface TransitionSpec {
    /** The id or name of the source activity */
    from: string;

    /** The id or name of the target activity */
    to: string;

    /** Optional condition sys_id for this transition */
    conditionSysId?: string;

    /** Execution order */
    order?: number;
}

/**
 * Complete specification for creating a workflow with all its components.
 */
export interface CompleteWorkflowSpec {
    /** Name of the workflow */
    name: string;

    /** Description of the workflow */
    description?: string;

    /** The table this workflow applies to (e.g., "incident") */
    table: string;

    /** Whether this is a template workflow */
    template?: boolean;

    /** Access level */
    access?: string;

    /** Whether the workflow version is active */
    active?: boolean;

    /** Condition expression for triggering the workflow */
    condition?: string;

    /** The activities in this workflow */
    activities: ActivitySpec[];

    /** The transitions between activities */
    transitions?: TransitionSpec[];

    /** Whether to publish the workflow after creation */
    publish?: boolean;

    /** The id or name of the start activity (required if publish=true) */
    startActivity?: string;
}

/**
 * Result of creating a complete workflow.
 */
export interface CompleteWorkflowResult {
    /** The sys_id of the created workflow */
    workflowSysId: string;

    /** The sys_id of the created workflow version */
    versionSysId: string;

    /** Map of activity id/index keys to their created sys_ids */
    activitySysIds: Record<string, string>;

    /** Array of created transition sys_ids */
    transitionSysIds: string[];

    /** Whether the workflow was published */
    published: boolean;

    /** The start activity key, if published */
    startActivity?: string;
}

// ============================================================
// Standard SN Record Response Wrappers
// ============================================================

/**
 * A generic ServiceNow record with sys_id and additional fields.
 */
export interface WorkflowRecord {
    sys_id: string;
    name?: string;
    [key: string]: unknown;
}

/**
 * Response containing a single workflow-related record.
 */
export interface WorkflowRecordResponse {
    result: WorkflowRecord;
}

/**
 * Response containing a list of workflow-related records.
 */
export interface WorkflowRecordListResponse {
    result: WorkflowRecord[];
}

// ============================================================
// Workflow Editor parity: graph, read models, lifecycle, editing
// ============================================================

/**
 * An activity on a workflow diagram, as the editor's diagram processor reports it.
 */
export interface WorkflowGraphNode {
    /** wf_activity sys_id */
    id: string;

    /** The activity's own name */
    name: string;

    /** The activity type's name (e.g. "Timer") */
    typeName: string;

    /** Activity definition sys_id */
    activityDefinition: string;

    x?: number;
    y?: number;
    width?: number;
    height?: number;

    /** wf_stage sys_id */
    stage?: string;

    /** Parent activity sys_id, for activities nested in a container activity */
    parent?: string;

    /** Whether this activity contains child activities */
    isParent: boolean;

    /** False for Begin and End, which the editor will not delete */
    deletable: boolean;
}

/**
 * An exit (wf_condition) on a diagram activity.
 */
export interface WorkflowGraphPort {
    /** wf_condition sys_id */
    id: string;

    /** wf_activity sys_id the exit belongs to */
    node: string;

    name: string;
    order: number;
    error: boolean;
    event: boolean;
}

/**
 * A transition (wf_transition) on a diagram.
 */
export interface WorkflowGraphEdge {
    /** wf_transition sys_id */
    id: string;

    /** wf_activity sys_id the transition leaves */
    source: string;

    /** wf_condition sys_id the transition leaves from */
    sourcePort: string;

    /** wf_activity sys_id the transition enters */
    target: string;
}

/**
 * A workflow version as the Workflow Editor's diagram processor sees it, including what
 * the current user may do with it.
 */
export interface WorkflowGraph {
    /** wf_workflow_version sys_id */
    id: string;

    /** wf_workflow sys_id */
    workflowSysId: string;

    name: string;
    table: string;
    published: boolean;
    active: boolean;

    /** True unless the version is a draft the current user can edit */
    readOnly: boolean;

    canCheckout: boolean;
    canForceCheckout: boolean;
    canPublish: boolean;
    canDelete: boolean;

    /** e.g. "Published", "Checked out by me" */
    statusDisplay: string;

    /** Activity sys_ids along the workflow's paths, as computed at publish */
    fullSequences: string[];

    /** Every graph property the processor returned, verbatim */
    properties: Record<string, string>;

    /** Activity type names keyed by activity definition sys_id (the editor's palette) */
    activityTypes: Record<string, string>;

    nodes: WorkflowGraphNode[];
    ports: WorkflowGraphPort[];
    edges: WorkflowGraphEdge[];
}

/**
 * A workflow (wf_workflow) with the state of its versions.
 */
export interface WorkflowSummary {
    /** wf_workflow sys_id */
    sysId: string;

    name: string;
    table: string;
    description: string;

    /** sys_id of the published version, if any */
    publishedVersionSysId?: string;

    /** The draft version, if someone has the workflow checked out */
    checkedOutVersion?: {
        sysId: string;
        checkedOutBy: string;
        checkedOutByName?: string;
        checkedOutOn: string;

        /** Whether the current user holds the draft */
        byCurrentUser: boolean;
    };

    /** Whether the published (or only) version is active */
    active: boolean;
}

/**
 * A workflow version (wf_workflow_version).
 */
export interface WorkflowVersionSummary {
    sysId: string;
    workflowSysId: string;
    name: string;
    table: string;
    published: boolean;
    active: boolean;

    /** When the version was checked out; empty unless it is a draft */
    checkedOut: string;

    /** sys_user sys_id of the user holding the draft; empty unless it is a draft */
    checkedOutBy: string;

    createdOn: string;
    updatedOn: string;
}

/**
 * Options for finding workflows.
 */
export interface FindWorkflowsOptions {
    /** Name contains this text */
    name?: string;

    /** Workflow table (e.g. "sc_req_item") */
    table?: string;

    /** Additional encoded query on wf_workflow */
    query?: string;

    /** Maximum number of workflows to return. Defaults to 50. */
    limit?: number;
}

/**
 * An activity exit (wf_condition).
 */
export interface WorkflowConditionInfo {
    sysId: string;
    activitySysId: string;
    name: string;

    /** JavaScript condition, e.g. `activity.result == 'approved'` */
    condition: string;

    order: number;
    elseFlag: boolean;
    error: boolean;
    event: boolean;
    eventName: string;
    shortDescription: string;
    skipDuringGenerate: boolean;
}

/**
 * A transition (wf_transition).
 */
export interface WorkflowTransitionInfo {
    sysId: string;

    /** wf_activity sys_id */
    from: string;

    /** wf_activity sys_id */
    to: string;

    /** wf_condition sys_id the transition leaves from */
    condition: string;
}

/**
 * A workflow stage (wf_stage).
 */
export interface WorkflowStageInfo {
    sysId: string;
    name: string;
    value: string;
    order: number;
}

/**
 * An activity (wf_activity) with its configuration.
 */
export interface WorkflowActivityInfo {
    sysId: string;
    name: string;

    /** Activity definition sys_id */
    definitionSysId: string;

    /** Activity type name (e.g. "Timer") */
    definitionName: string;

    x?: number;
    y?: number;
    width?: number;
    height?: number;

    /** wf_stage sys_id */
    stage?: string;

    /** Parent activity sys_id, for activities nested in a container activity */
    parent?: string;

    /** Activity Designer input mapping (JSON text); empty for core activities */
    input: string;

    /** Variable values keyed by element name (present when variables were requested) */
    variables?: Record<string, string>;

    /** The activity's exits, in order */
    conditions: WorkflowConditionInfo[];
}

/**
 * Everything that makes up one workflow version.
 */
export interface WorkflowDefinition {
    workflowSysId: string;
    versionSysId: string;
    name: string;
    table: string;
    description: string;

    /** Trigger condition (encoded query) */
    condition: string;

    /** e.g. "run_match", or empty for none */
    conditionType: string;

    published: boolean;
    active: boolean;
    checkedOut: string;
    checkedOutBy: string;

    /** Begin activity sys_id */
    start: string;

    /** Activity sys_ids along the workflow's paths, as computed at publish */
    fullSequences: string[];

    /** What the current user may do with this version (present when status was requested) */
    status?: {
        readOnly: boolean;
        canCheckout: boolean;
        canForceCheckout: boolean;
        canPublish: boolean;
        statusDisplay: string;
    };

    activities: WorkflowActivityInfo[];
    transitions: WorkflowTransitionInfo[];
    stages: WorkflowStageInfo[];
}

/**
 * Options for reading a workflow definition.
 */
export interface GetWorkflowDefinitionOptions {
    /** Include activity variable values. Defaults to true. */
    includeVariables?: boolean;

    /** Include the current user's permissions from the diagram processor. Defaults to true. */
    includeStatus?: boolean;
}

/**
 * An activity type (wf_activity_definition, or an Activity Designer wf_element_activity).
 */
export interface ActivityDefinitionSummary {
    sysId: string;
    name: string;
    category: string;

    /** `wf_activity_definition` for core activities, `wf_element_activity` for Activity Designer ones */
    sysClassName: string;
}

/**
 * Options for listing activity types.
 */
export interface ListActivityDefinitionsOptions {
    /** Name contains this text */
    name?: string;

    /** Category (e.g. "Approvals", "Timers") */
    category?: string;

    /** Include Activity Designer / Orchestration activities. Defaults to true. */
    includeDesigner?: boolean;

    /** Maximum number to return. Defaults to 500. */
    limit?: number;
}

/**
 * A default exit an activity type gives every new activity (wf_condition_default).
 */
export interface DefaultConditionInfo {
    name: string;
    condition: string;
    order: number;
    elseFlag: boolean;
    error: boolean;
    skipDuringGenerate: boolean;
}

/**
 * An activity type with the variables its activities carry and the exits they start with.
 */
export interface ActivityDefinitionDetail extends ActivityDefinitionSummary {
    /**
     * The type's own documentation, as written on the instance: what it does and the
     * results (exits) it produces. Often the best single explanation of the type.
     */
    description: string;

    /** Definition attributes, e.g. `generate=approval,approval=true`, `begin=true` */
    attributes: string;

    /** Variables (core activities); empty for Activity Designer activities, which use `input` */
    variables: VariableDefinition[];

    /** Exits a new activity of this type starts with. Empty means a single "Always" exit. */
    defaultConditions: DefaultConditionInfo[];

    /** Activity Designer inputs, set through the activity's `input` JSON keyed by `name` */
    inputs?: ActivityDesignerField[];

    /** Activity Designer outputs (`activityOutput.<name>`), which its exits test */
    outputs?: ActivityDesignerField[];

    /**
     * The implementation, when requested: a core type's handler script (how each
     * variable is read and which `activity.result` values it sets), or an Activity
     * Designer type's output processing script.
     */
    script?: string;
}

/**
 * An Activity Designer input or output.
 */
export interface ActivityDesignerField {
    name: string;

    /** e.g. STRING, BOOLEAN, INTEGER, DATA_OBJECT */
    type: string;

    mandatory: boolean;
}

/**
 * Options for describing an activity type.
 */
export interface GetActivityDefinitionOptions {
    /** Include the implementation script. Defaults to false (scripts run to several KB). */
    includeScript?: boolean;
}

/**
 * How published workflows on the instance configure an activity type: for each variable
 * (or Activity Designer input), how often it is set and its most common values.
 */
export interface ActivityUsage {
    definitionSysId: string;
    definitionName: string;

    /** Activities of this type in published workflow versions */
    publishedActivities: number;

    /** Activities sampled to build the examples */
    sampled: number;

    /** Per variable or input, in definition order */
    fields: Array<{
        name: string;

        /** Sampled activities with a non-empty value */
        setCount: number;

        /** Most common values (trimmed to `maxValueLength`); `isDefault` marks the type's untouched default */
        examples: Array<{ value: string; count: number; isDefault: boolean }>;
    }>;
}

/**
 * Options for reading how an activity type is used.
 */
export interface GetActivityUsageOptions {
    /** Activities to sample. Defaults to 100. */
    sampleSize?: number;

    /** Examples per field. Defaults to 5. */
    examplesPerField?: number;

    /** Longest example value kept, in characters. Defaults to 300. */
    maxValueLength?: number;
}

/**
 * Options for creating a workflow the way the Workflow Editor does.
 */
export interface NewWorkflowOptions {
    /** Workflow name; must be unique */
    name: string;

    /** Table the workflow runs on (e.g. "incident", "sc_req_item") */
    table: string;

    description?: string;

    /** Trigger condition (encoded query) */
    condition?: string;

    /** Trigger condition type, e.g. "run_match". Defaults to the instance default. */
    conditionType?: string;

    /** Additional wf_workflow_version fields to set, keyed by column name */
    fields?: Record<string, string | number | boolean>;
}

/**
 * Result of creating a workflow. The new version is a draft checked out to the current user.
 */
export interface NewWorkflowResult {
    workflowSysId: string;
    versionSysId: string;
    beginActivitySysId: string;
    endActivitySysId: string;

    /** The Begin activity's "Always" exit */
    beginConditionSysId: string;

    /** The Begin → End transition */
    transitionSysId: string;
}

/**
 * Options for checking out a workflow.
 */
export interface CheckoutOptions {
    /** Take the checkout from another user (the editor's "Force Checkout") */
    force?: boolean;
}

/**
 * Result of a checkout.
 */
export interface CheckoutResult {
    workflowSysId: string;

    /** The draft version to edit */
    versionSysId: string;

    /** True when the current user already had this draft checked out */
    alreadyCheckedOut: boolean;
}

/**
 * Options for publishing.
 */
export interface PublishOptions {
    /**
     * Publish even when validation reports warnings (the editor's "Publish this workflow
     * with warnings?" prompt). Critical findings always block. Defaults to false.
     */
    allowWarnings?: boolean;
}

/**
 * Result of publishing.
 */
export interface PublishResult {
    versionSysId: string;

    /** Validation findings at Warn level that were accepted */
    warnings: WorkflowValidationItem[];

    /** Activity sys_ids along the workflow's paths, as computed at publish */
    fullSequences: string[];
}

/**
 * One validation check result.
 */
export interface WorkflowValidationItem {
    /** Check name, e.g. "ValidateTransitionOut" */
    type: string;

    /** "Info", "Warn" or "Critical" */
    level: string;

    message: string;
    details: string;
}

/**
 * The Workflow Editor's validation report for a version.
 */
export interface WorkflowValidationReport {
    versionSysId: string;

    /** e.g. "Validate Summary - Workflow version contains Warnings - Total checks performed:16 (Info:14, Warn:2, Critical:0)" */
    summary: string;

    /** True when no check reported Warn or Critical */
    valid: boolean;

    items: WorkflowValidationItem[];
}

/**
 * Where a new activity connects.
 */
export interface ActivityConnection {
    /** Activity sys_id */
    activity: string;

    /** Exit name or wf_condition sys_id. Required when the activity has more than one exit. */
    condition?: string;
}

/**
 * Options for adding an activity to a checked-out workflow version.
 */
export interface AddActivityOptions {
    /** Activity type: definition sys_id or exact name (e.g. "Timer", "Approval - User") */
    definition: string;

    /** The activity's name */
    name: string;

    /** Canvas position. Defaults to the middle of `insertOn`, or to the right of `connectFrom`. */
    x?: number;
    y?: number;

    /** Stage: wf_stage sys_id, name or value */
    stage?: string;

    /** Variable values keyed by element name; see getActivityDefinition() for what a type accepts */
    variables?: Record<string, FormValueInput>;

    /** Activity Designer input mapping (object or JSON text) */
    input?: string | Record<string, unknown>;

    /**
     * Drop the activity onto this transition, as the editor does when you drop onto a
     * line: the transition is re-pointed at the new activity, and a new transition runs
     * from the new activity to the original target.
     */
    insertOn?: string;

    /** Add a transition into the new activity from this activity and exit */
    connectFrom?: ActivityConnection;

    /** Add a transition from the new activity to this activity */
    connectTo?: string;

    /**
     * Which of the new activity's exits feeds `insertOn` / `connectTo` (name or sys_id).
     * Defaults to its first exit, as the editor does.
     */
    exitCondition?: string;
}

/**
 * Result of adding an activity.
 */
export interface AddActivityResult {
    activitySysId: string;
    name: string;

    /** The exits the activity was created with */
    conditions: WorkflowConditionInfo[];

    /** Transitions created or re-pointed to wire the activity in */
    transitionSysIds: string[];
}

/**
 * Options for updating an activity. Omitted values are left unchanged.
 */
export interface UpdateActivityOptions {
    name?: string;
    variables?: Record<string, FormValueInput>;
    input?: string | Record<string, unknown>;

    /** Stage: wf_stage sys_id, name or value; empty string clears it */
    stage?: string;

    x?: number;
    y?: number;
}

/**
 * Options for removing an activity.
 */
export interface RemoveActivityOptions {
    /**
     * When the activity has exactly one incoming and one outgoing transition, join them
     * so the flow stays connected. Otherwise every transition touching it is removed.
     */
    reconnect?: boolean;
}

/**
 * Options for adding a transition.
 */
export interface AddTransitionOptions {
    /** Source activity sys_id */
    from: string;

    /** Target activity sys_id */
    to: string;

    /** Exit on `from`: name or wf_condition sys_id. Required when `from` has more than one exit. */
    condition?: string;
}

/**
 * Options for adding an exit to an activity.
 */
export interface AddConditionOptions {
    /** Activity sys_id */
    activity: string;

    name: string;

    /** JavaScript condition, e.g. `activity.result == 'skipped'` */
    condition: string;

    order?: number;
    elseFlag?: boolean;
    error?: boolean;
    shortDescription?: string;
}

/**
 * Options for updating an exit. Omitted values are left unchanged.
 */
export interface UpdateConditionOptions {
    name?: string;
    condition?: string;
    order?: number;
    elseFlag?: boolean;
    error?: boolean;
    shortDescription?: string;
}

/**
 * A new canvas position for an activity.
 */
export interface ActivityPosition {
    sysId: string;
    x: number;
    y: number;
}

/**
 * Workflow properties to change on a draft. Omitted values are left unchanged.
 */
export interface UpdateWorkflowPropertiesOptions {
    name?: string;
    description?: string;

    /** Trigger condition (encoded query) */
    condition?: string;

    conditionType?: string;

    /** Additional wf_workflow_version fields to set, keyed by column name */
    fields?: Record<string, string | number | boolean>;
}

// ============================================================
// Workflow export (a complete, self-contained definition)
// ============================================================

/**
 * Options for exporting a workflow.
 */
export interface ExportWorkflowOptions {
    /**
     * Which version to export when given a workflow (not a version sys_id): `current`
     * (your draft if you have one, else the published version — the default),
     * `published`, or `draft` (your draft).
     */
    version?: 'current' | 'published' | 'draft';
}

/**
 * A variable value on an exported activity.
 */
export interface WorkflowExportVariable {
    element: string;
    label: string;

    /** Internal type of the variable (e.g. `script`, `glide_list`, `conditions`) */
    type: string;

    /** Stored value */
    value: string;

    /** True when the value is the activity type's untouched default */
    isDefault: boolean;

    /** Choice label for choice values, or display names for referenced records */
    display?: string;
}

/**
 * An activity type used by an exported workflow, described from the instance.
 */
export interface WorkflowExportActivityType {
    sysId: string;
    name: string;
    category: string;
    sysClassName: string;
    attributes: string;
    description: string;

    /**
     * Whether activities of this type can pause the workflow (approvals, timers, waits,
     * tasks, joins, subflows). Read from the type's handler script and the handlers it
     * extends; some only wait conditionally (tasks honour their `wait_for_completion`
     * variable). Undefined for Activity Designer types, which run through their own engine.
     */
    waits?: boolean;

    /** Activity Designer inputs and outputs */
    inputs?: ActivityDesignerField[];
    outputs?: ActivityDesignerField[];
}

/**
 * An exit of an exported activity.
 */
export interface WorkflowExportExit {
    sysId: string;
    name: string;
    condition: string;
    order: number;
    elseFlag: boolean;
    error: boolean;
}

/**
 * An activity in an exported workflow.
 */
export interface WorkflowExportActivity {
    sysId: string;
    name: string;

    /** Activity type sys_id (key of `activityTypes`) */
    typeSysId: string;

    /** Activity type name */
    type: string;

    x?: number;
    y?: number;

    /** Stage sys_id (see `stages`) */
    stage?: string;

    /** Parent activity sys_id, for activities nested in a container */
    parent?: string;

    /** Non-empty variable values (core types) */
    variables: WorkflowExportVariable[];

    /** Activity Designer input mapping */
    input?: Record<string, unknown>;

    /** For subflow activities: the workflow they run */
    subflow?: { workflowSysId: string; name: string };

    exits: WorkflowExportExit[];
}

/**
 * A complete, self-contained definition of one workflow version: everything needed to
 * understand, redraw or port it without going back to the instance.
 */
export interface WorkflowExport {
    /** Format identifier, bumped on incompatible changes */
    format: 'now-sdk-ext/legacy-workflow@1';

    exportedAt: string;

    workflow: {
        sysId: string;
        name: string;
        table: string;
        description: string;
        scope: string;
    };

    version: {
        sysId: string;
        name: string;
        published: boolean;
        active: boolean;
        checkedOut: string;
        checkedOutBy: string;

        /** Trigger condition (encoded query) and how it is applied */
        condition: string;
        conditionType: string;

        order: number;
        runMultiple: boolean;
        afterBusinessRules: boolean;
        stageField: string;

        /** Script run when the workflow is cancelled */
        onCancel: string;

        /** Begin activity sys_id */
        start: string;

        fullSequences: string[];
    };

    /** Workflow input variables (for subflows and scripted starts) */
    inputs: Array<{ name: string; label: string; type: string; mandatory: boolean; defaultValue: string }>;

    stages: WorkflowStageInfo[];

    /** Activity types used, keyed by sys_id */
    activityTypes: Record<string, WorkflowExportActivityType>;

    activities: WorkflowExportActivity[];

    /** Transitions: from activity, via one of its exits, to activity */
    transitions: Array<{ sysId: string; from: string; exit: string; to: string }>;

    /** Display names for sys_ids found in variable values */
    references: Record<string, { table: string; display: string }>;

    /** What starts or calls this workflow */
    usedBy: {
        catalogItems: Array<{ sysId: string; name: string; active: boolean }>;
        parentWorkflows: Array<{ workflowSysId: string; name: string; versionSysId: string }>;
    };
}
