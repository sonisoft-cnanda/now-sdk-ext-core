import { WorkflowExport } from "./WorkflowModels";

/**
 * Models for planning the move of a legacy workflow to Flow Designer.
 */

/** How completely a step carries over. */
export type FlowPlanConfidence = 'direct' | 'partial' | 'manual';

/** A value for a Flow Designer action input. */
export type FlowPlanValue =
    | { kind: 'literal'; value: string | number | boolean }
    /** A data pill: `expr` is a Fluent expression such as `params.trigger.request_item.requested_for.manager` */
    | { kind: 'pill'; expr: string; type: string }
    /** Text mixing literals and data pills, e.g. a subject line */
    | { kind: 'text'; parts: Array<string | { expr: string; type: string }> }
    /** A field map (`TemplateValue({...})`) */
    | { kind: 'template'; fields: Record<string, FlowPlanValue> }
    /** Approval rules (`wfa.approvalRules({...})`) */
    | { kind: 'approvalRules'; ruleType: 'Any' | 'All' | 'Res'; action: 'Approves' | 'Rejects' | 'ApprovesRejects'; users: FlowPlanValue[]; groups: FlowPlanValue[] }
    /** A duration (`Duration({...})`) */
    | { kind: 'duration'; seconds: number }
    /** A list of values */
    | { kind: 'list'; items: FlowPlanValue[] };

/** A flow condition: an encoded query whose fields may be data pills. */
export interface FlowPlanCondition {
    /** The condition as a Fluent template literal body, e.g. `${wfa.dataPill(x, "string")}=1` — empty when it could not be derived */
    expression: string;

    /** The legacy condition or exit it came from */
    source: string;

    /** False when the condition has to be written by hand */
    derived: boolean;
}

/** Where a planned step came from. */
export interface FlowPlanSource {
    activity: string;
    name: string;
    type: string;

    /** Step number in the workflow outline */
    number: number;
}

/** A node of the planned flow body. */
export type FlowPlanNode =
    | {
        kind: 'action';
        id: string;
        source: FlowPlanSource;
        /** Fluent action, e.g. `action.core.askForApproval` */
        action: string;
        label: string;
        inputs: Record<string, FlowPlanValue>;
        /** Variable name the action's outputs are captured in, when later steps use them */
        output?: string;
        confidence: FlowPlanConfidence;
        notes: string[];
        stage?: string;
        waits: boolean;
    }
    | {
        kind: 'waitForADuration';
        id: string;
        source: FlowPlanSource;
        seconds: number;
        confidence: FlowPlanConfidence;
        notes: string[];
    }
    | {
        kind: 'if';
        id: string;
        source: FlowPlanSource;
        /** if, then elseIf… in order */
        branches: Array<{ label: string; condition: FlowPlanCondition; body: FlowPlanNode[] }>;
        /** else, when present */
        otherwise?: { label: string; body: FlowPlanNode[] };
        confidence: FlowPlanConfidence;
        notes: string[];
    }
    | {
        kind: 'parallel';
        id: string;
        source: FlowPlanSource;
        lanes: FlowPlanNode[][];
        notes: string[];
    }
    | {
        /** Set flow variables (a script that only wrote workflow.scratchpad keys) */
        kind: 'setFlowVariables';
        id: string;
        source: FlowPlanSource;
        values: Record<string, FlowPlanValue>;
        notes: string[];
    }
    | { kind: 'endFlow'; id: string; source: FlowPlanSource }
    | {
        /** A step that has to be designed by hand: a script, a loop, a goto, a spoke, … */
        kind: 'todo';
        id: string;
        source: FlowPlanSource;
        reason: string;
        /** Legacy detail to work from (script body, inputs, condition) */
        detail?: string;
        /** Set when the path continues at a step the flow already has elsewhere (a goto): that step's activity sys_id */
        continueAt?: string;
    };

/** The trigger of the planned flow, or the inputs of a planned subflow. */
export interface FlowPlanTrigger {
    /** `serviceCatalog` for catalog item workflows, `record` for table workflows, `subflow` when nothing triggers it */
    kind: 'serviceCatalog' | 'record' | 'subflow';
    table: string;

    /** Record trigger: created or created-or-updated, and its condition */
    recordEvent?: 'created' | 'createdOrUpdated';
    condition?: string;

    /** Catalog items whose workflow this is (the flow is bound to them, not to its trigger) */
    catalogItems: Array<{ sysId: string; name: string }>;

    /** Subflow inputs, from the workflow's inputs */
    inputs: Array<{ name: string; label: string; type: string; mandatory: boolean }>;

    /** Fluent expression for the record the workflow ran on */
    recordPill: string;

    notes: string[];
}

/** A decision the conversion leaves to a person (or agent). */
export interface FlowPlanDecision {
    topic: 'script' | 'loop' | 'goto' | 'catalogVariable' | 'spoke' | 'subflow' | 'stage' | 'trigger' | 'mergeWithoutJoin'
        | 'deadExit' | 'unreachable' | 'approval' | 'task' | 'other';
    detail: string;
    /** Activities involved (sys_ids) */
    activities: string[];
}

/**
 * A plan for rebuilding a legacy workflow in Flow Designer: the trigger, flow variables
 * from the scratchpad, a flow-shaped body mapped step by step, and the decisions that
 * need a person.
 */
export interface FlowConversionPlan {
    format: 'now-sdk-ext/flow-conversion-plan@1';

    source: { workflowSysId: string; versionSysId: string; name: string; table: string };

    kind: 'flow' | 'subflow';

    /** Suggested flow name and a code-safe identifier */
    name: string;
    identifier: string;

    trigger: FlowPlanTrigger;

    /** workflow.scratchpad keys used across steps become flow variables */
    flowVariables: Array<{ name: string; type: 'string' | 'boolean' | 'integer'; setBy: string[]; usedBy: string[] }>;

    steps: FlowPlanNode[];

    openDecisions: FlowPlanDecision[];

    /** How many activities map directly, partly, or need design work */
    coverage: { direct: number; partial: number; manual: number };
}

/** One generated source file. */
export interface FluentSourceFile {
    /** Suggested path inside a now-sdk app, e.g. `src/fluent/flows/laptop-request.now.ts` */
    path: string;
    content: string;
}

/** A workflow version's move to Flow Designer: its export, the plan and the Fluent skeleton. */
export interface WorkflowFlowConversion {
    export: WorkflowExport;
    plan: FlowConversionPlan;
    files: FluentSourceFile[];
}
