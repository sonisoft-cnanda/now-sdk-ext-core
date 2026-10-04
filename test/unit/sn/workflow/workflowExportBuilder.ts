/**
 * Builds small synthetic `WorkflowExport` documents for unit tests.
 */
import { WorkflowExport, WorkflowExportActivity } from '../../../../src/sn/workflow/WorkflowModels';

export interface ExitSpec {
    name: string;
    condition?: string;
    elseFlag?: boolean;
}

export interface ActivitySpec {
    id: string;
    type: string;
    name?: string;
    exits?: Array<string | ExitSpec>;

    /** Non-default variable values */
    vars?: Record<string, string>;

    /** Variables left at the type's default */
    defaults?: Record<string, string>;
    stage?: string;
    designer?: boolean;
    input?: Record<string, unknown>;
    subflow?: { workflowSysId: string; name: string };
}

export interface ExportSpec {
    name?: string;
    table?: string;
    condition?: string;
    catalogItems?: string[];
    parents?: string[];
    inputs?: Array<{ name: string; type: string }>;
    stages?: Array<{ sysId: string; name: string }>;
    references?: Record<string, { table: string; display: string }>;
    activities: ActivitySpec[];

    /** [from, exit name, to] */
    edges: Array<[string, string, string]>;
}

const WAITING = new Set(['Approval - User', 'Approval - Group', 'Catalog Task', 'Create Task', 'Join', 'Timer', 'Wait for condition', 'Workflow']);
const DEFAULT_EXITS: Record<string, string[]> = {
    'Begin': ['Always'],
    'End': [],
    'Approval - User': ['Approved', 'Rejected', 'Skipped'],
    'Approval - Group': ['Approved', 'Rejected', 'Skipped'],
    'If': ['Yes', 'No'],
    'Join': ['Complete', 'Incomplete'],
};
const ATTRIBUTES: Record<string, string> = { Begin: 'begin=true', End: 'end=true', Join: 'generate=join' };

export function buildExport(spec: ExportSpec): WorkflowExport {
    const types: WorkflowExport['activityTypes'] = {};
    const activities: WorkflowExportActivity[] = spec.activities.map((a, i) => {
        const typeSysId = `t-${a.type}${a.designer ? '-ad' : ''}`;
        types[typeSysId] = {
            sysId: typeSysId, name: a.type, category: '', sysClassName: a.designer ? 'wf_element_activity' : 'wf_activity_definition',
            attributes: ATTRIBUTES[a.type] ?? '', description: '', ...(a.designer ? {} : { waits: WAITING.has(a.type) }),
        };
        const exits = (a.exits ?? DEFAULT_EXITS[a.type] ?? ['Always']).map((e, order) => {
            const exit = typeof e === 'string' ? { name: e } : e;
            return {
                sysId: `${a.id}:${exit.name}`, name: exit.name, order, elseFlag: !!exit.elseFlag, error: false,
                condition: exit.condition ?? (exit.elseFlag ? '' : exit.name === 'Always' ? 'true' : `activity.result == '${exit.name.toLowerCase()}'`),
            };
        });
        const variable = (isDefault: boolean) => ([element, value]: [string, string]) => ({ element, label: element, type: element.includes('script') ? 'script' : 'string', value, isDefault });
        return {
            sysId: a.id, name: a.name ?? a.id, typeSysId, type: a.type, x: 100, y: i * 100,
            ...(a.stage ? { stage: a.stage } : {}),
            variables: [...Object.entries(a.vars ?? {}).map(variable(false)), ...Object.entries(a.defaults ?? {}).map(variable(true))],
            ...(a.input ? { input: a.input } : {}),
            ...(a.subflow ? { subflow: a.subflow } : {}),
            exits,
        };
    });
    const begin = spec.activities.find(a => a.type === 'Begin')?.id ?? '';
    return {
        format: 'now-sdk-ext/legacy-workflow@1',
        exportedAt: '2026-01-01T00:00:00Z',
        workflow: { sysId: 'wf-test', name: spec.name ?? 'Test Workflow', table: spec.table ?? 'sc_req_item', description: '', scope: 'global' },
        version: {
            sysId: 'ver-test', name: spec.name ?? 'Test Workflow', published: true, active: true, checkedOut: '', checkedOutBy: '',
            condition: spec.condition ?? '', conditionType: spec.condition ? 'run_match' : '', order: 100, runMultiple: false,
            afterBusinessRules: false, stageField: 'stage', onCancel: '', start: begin, fullSequences: [],
        },
        inputs: (spec.inputs ?? []).map(i => ({ name: i.name, label: i.name, type: i.type, mandatory: false, defaultValue: '' })),
        stages: (spec.stages ?? []).map((s, order) => ({ sysId: s.sysId, name: s.name, value: s.sysId, order })),
        activityTypes: types,
        activities,
        transitions: spec.edges.map(([from, exit, to], i) => ({ sysId: `tr${i}`, from, exit: `${from}:${exit}`, to })),
        references: spec.references ?? {},
        usedBy: {
            catalogItems: (spec.catalogItems ?? []).map((name, i) => ({ sysId: `cat-${i}`, name, active: true })),
            parentWorkflows: (spec.parents ?? []).map((name, i) => ({ workflowSysId: `parent-${i}`, name, versionSysId: `pv-${i}` })),
        },
    };
}
