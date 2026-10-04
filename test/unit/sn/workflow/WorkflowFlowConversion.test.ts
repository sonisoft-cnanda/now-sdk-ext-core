/**
 * Planning the move of a legacy workflow to Flow Designer, on synthetic exports.
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { WorkflowExport } from '../../../../src/sn/workflow/WorkflowModels';
import { FlowConversionPlan, FlowPlanNode } from '../../../../src/sn/workflow/WorkflowConversionModels';
import { encodedQueryToCondition, identifierFrom, planFlowConversion, renderFlowPlan } from '../../../../src/sn/workflow/WorkflowFlowConversion';
import { buildExport } from './workflowExportBuilder';

const LAPTOP = JSON.parse(readFileSync(new URL('./fixtures/laptop-request.json', import.meta.url), 'utf8')) as WorkflowExport;

type Node<K extends FlowPlanNode['kind']> = Extract<FlowPlanNode, { kind: K }>;

/** Every node of the plan, depth first. */
function nodes(plan: FlowConversionPlan | FlowPlanNode[]): FlowPlanNode[] {
    const list = Array.isArray(plan) ? plan : plan.steps;
    return list.flatMap(n => [n, ...(n.kind === 'if' ? [...n.branches.flatMap(b => nodes(b.body)), ...nodes(n.otherwise?.body ?? [])]
        : n.kind === 'parallel' ? n.lanes.flatMap(l => nodes(l)) : [])]);
}

function find<K extends FlowPlanNode['kind']>(plan: FlowConversionPlan, kind: K, activity?: string): Node<K> {
    return nodes(plan).find(n => n.kind === kind && (!activity || n.source.activity === activity)) as Node<K>;
}

const linear = (middle: Parameters<typeof buildExport>[0]['activities'], extra: Partial<Parameters<typeof buildExport>[0]> = {}) => {
    const ids = ['begin', ...middle.map(a => a.id), 'end'];
    return buildExport({
        ...extra,
        activities: [{ id: 'begin', type: 'Begin' }, ...middle, { id: 'end', type: 'End' }],
        edges: ids.slice(0, -1).map((id, i) => [id, i === 0 ? 'Always' : 'Always', ids[i + 1]]),
    });
};

describe('planFlowConversion: a catalog item workflow', () => {
    const plan = planFlowConversion(LAPTOP);

    it('triggers on the catalog item and works on the requested item', () => {
        expect(plan.kind).toBe('flow');
        expect(plan.identifier).toBe('laptop_request');
        expect(plan.trigger).toMatchObject({ kind: 'serviceCatalog', table: 'sc_req_item', recordPill: 'params.trigger.request_item', catalogItems: [{ sysId: 'cat-1', name: 'Laptop' }] });
    });

    it('turns the approval into Ask For Approval with its approvers as data pills', () => {
        const approval = plan.steps[0] as Node<'action'>;
        expect(approval).toMatchObject({ kind: 'action', action: 'action.core.askForApproval', output: 'manager_approval', waits: true, confidence: 'direct' });
        expect(approval.inputs.approval_conditions).toEqual({
            kind: 'approvalRules', ruleType: 'Any', action: 'ApprovesRejects', groups: [],
            users: [{ kind: 'pill', expr: 'params.trigger.request_item.requested_for.manager', type: 'reference' }],
        });
        expect(approval.notes).toContain('Exit "Skipped" leads nowhere in the workflow.');
    });

    it('branches on the approval state, guard-clause style, ending the flow where the workflow ended', () => {
        const decision = plan.steps[1] as Node<'if'>;
        expect(decision.kind).toBe('if');
        expect(decision.branches).toHaveLength(1);
        expect(decision.branches[0].label).toBe('Rejected');
        expect(decision.branches[0].condition).toMatchObject({ derived: true, expression: '${wfa.dataPill(manager_approval.approval_state, "choice")}=rejected' });
        expect(decision.branches[0].body.map(n => n.kind)).toEqual(['action', 'endFlow']);
        expect(decision.notes).toEqual(['Approved: carries on with the steps after this decision.']);
    });

    it('keeps Set Values as Update Record, flagging ${…} values', () => {
        const rejected = find(plan, 'action', 'rej');
        expect(rejected.action).toBe('action.core.updateRecord');
        expect(rejected.inputs.values).toEqual({ kind: 'template', fields: { state: { kind: 'literal', value: '4' }, comments: { kind: 'literal', value: 'Rejected ${number}' } } });
        expect(rejected.confidence).toBe('partial');
        const complete = find(plan, 'action', 'close');
        expect(complete.confidence).toBe('direct');
    });

    it('runs parallel branches in a parallel block', () => {
        const parallel = find(plan, 'parallel');
        expect(parallel.lanes).toHaveLength(2);
        const order = parallel.lanes[0][0] as Node<'action'>;
        expect(order.action).toBe('action.core.createCatalogTask');
        expect(order.inputs.ah_fields).toEqual({ kind: 'template', fields: { assignment_group: { kind: 'literal', value: 'c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2' } } });
        // its advanced script never runs: "advanced" is off
        expect(order.notes.join('\n')).not.toContain('task.short_description');
    });

    it('leaves what cannot be carried over as TODOs with the legacy detail', () => {
        const todos = nodes(plan).filter((n): n is Node<'todo'> => n.kind === 'todo');
        expect(todos.find(t => t.source.activity === 'prep').detail).toContain('workflow.scratchpad.ticket = current.number;');
        expect(todos.find(t => t.source.activity === 'acct').reason).toContain('Activity Designer activity "Create AD User"');
        expect(todos.find(t => t.source.activity === 'sub').reason).toContain('Runs the workflow "Child provisioning"');
        expect(todos.filter(t => t.continueAt).map(t => t.continueAt).sort()).toEqual(['close', 'fail']);
    });

    it('turns scratchpad values passed between steps into flow variables', () => {
        expect(plan.flowVariables).toEqual([{ name: 'ticket', type: 'string', setBy: ['prep'], usedBy: ['order'] }]);
    });

    it('lists the decisions that need a person', () => {
        const topics = plan.openDecisions.map(d => d.topic);
        for (const topic of ['subflow', 'script', 'spoke', 'loop', 'deadExit', 'unreachable', 'catalogVariable', 'stage', 'goto'] as const) {
            expect(topics).toContain(topic);
        }
        expect(plan.openDecisions.filter(d => d.topic === 'goto')).toHaveLength(2);
        expect(plan.openDecisions.find(d => d.topic === 'catalogVariable').detail).toContain('needs_laptop (Needs a laptop?)');
    });

    it('counts how much carries over', () => {
        expect(plan.coverage).toEqual({ direct: 5, partial: 1, manual: 5 });
    });

    it('renders as readable text', () => {
        const text = renderFlowPlan(plan);
        expect(text).toContain('TRIGGER Service Catalog (sc_req_item) for "Laptop"');
        expect(text).toContain('FLOW VARIABLES (from workflow.scratchpad): ticket: string');
        expect(text).toContain('askForApproval → manager_approval [WAIT]   ← 2. Manager approval');
        expect(text).toContain('  - approval_conditions = Any of users [{{trigger.request_item.requested_for.manager}}]');
        expect(text).toContain('if {{manager_approval.approval_state}}=rejected   [Rejected]');
        expect(text).toContain('if TODO(variables.needs_laptop=true)   [Yes: carries on below] [MANUAL]');
        expect(text).toContain('OPEN DECISIONS:');
    });
});

describe('planFlowConversion: activity mappings', () => {
    it('turns scratchpad flags into flow variables and If scripts that test them into conditions', () => {
        const plan = planFlowConversion(buildExport({
            activities: [
                { id: 'begin', type: 'Begin' },
                { id: 'flag', type: 'Run Script', vars: { script: 'workflow.scratchpad.legal = true;' } },
                { id: 'check', type: 'If', vars: { advanced: '1', script: "answer = ifScript();\nfunction ifScript() {\n  if (workflow.scratchpad.legal == true) {\n    return 'yes';\n  }\n  return 'no';\n}" } },
                { id: 'log', type: 'Log Message', vars: { message: 'Legal for ${number}' } },
                { id: 'end', type: 'End' },
            ],
            edges: [['begin', 'Always', 'flag'], ['flag', 'Always', 'check'], ['check', 'Yes', 'log'], ['check', 'No', 'end'], ['log', 'Always', 'end']],
        }));
        expect(plan.steps[0]).toMatchObject({ kind: 'setFlowVariables', values: { legal: { kind: 'literal', value: true } } });
        // Yes is the longer path, so it carries on below the decision; No ends the flow
        const decision = plan.steps[1] as Node<'if'>;
        expect(decision.branches[0]).toMatchObject({ label: 'Yes: carries on below', body: [] });
        expect(decision.branches[0].condition).toMatchObject({ derived: true, expression: '${wfa.dataPill(params.flowVariables.legal, "boolean")}=true' });
        expect(decision.otherwise.body.map(n => n.kind)).toEqual(['endFlow']);
        expect(decision.confidence).toBe('partial');
        expect(plan.flowVariables).toEqual([{ name: 'legal', type: 'boolean', setBy: ['flag'], usedBy: ['check'] }]);
        const log = plan.steps[2] as Node<'action'>;
        expect(log.inputs.log_message).toEqual({ kind: 'text', parts: ['Legal for ', { expr: 'params.trigger.request_item.number', type: 'string' }] });
    });

    it('converts If conditions on the record into data-pill conditions', () => {
        const plan = planFlowConversion(buildExport({
            table: 'incident', condition: 'priority=1',
            activities: [
                { id: 'begin', type: 'Begin' },
                { id: 'check', type: 'If', vars: { condition: 'state=2^ORstate=3^assigned_toISEMPTY^EQ' } },
                { id: 'set', type: 'Set Values', vars: { values: 'state=6^EQ' } },
                { id: 'end', type: 'End' },
            ],
            edges: [['begin', 'Always', 'check'], ['check', 'Yes', 'set'], ['check', 'No', 'end'], ['set', 'Always', 'end']],
        }));
        expect(plan.trigger).toMatchObject({ kind: 'record', recordEvent: 'created', condition: 'priority=1', recordPill: 'params.trigger.current' });
        const decision = plan.steps[0] as Node<'if'>;
        expect(decision.confidence).toBe('direct');
        expect(decision.branches[0].condition.expression).toBe(
            '${wfa.dataPill(params.trigger.current.state, "string")}=2^OR${wfa.dataPill(params.trigger.current.state, "string")}=3^${wfa.dataPill(params.trigger.current.assigned_to, "string")}ISEMPTY');
    });

    it('maps Switch exits on a field, and leaves catalog-variable switches to a person', () => {
        const build = (vars: Record<string, string>) => planFlowConversion(buildExport({
            activities: [
                { id: 'begin', type: 'Begin' },
                { id: 'sw', type: 'Switch', vars, exits: ['Low', 'High'] },
                { id: 'low', type: 'Log Message', vars: { message: 'low' } },
                { id: 'high', type: 'Log Message', vars: { message: 'high' } },
                { id: 'done', type: 'Log Message', vars: { message: 'done' } },
                { id: 'end', type: 'End' },
            ],
            edges: [['begin', 'Always', 'sw'], ['sw', 'Low', 'low'], ['sw', 'High', 'high'], ['low', 'Always', 'done'], ['high', 'Always', 'done'], ['done', 'Always', 'end']],
        }));
        const byField = build({ type: 'field', field: 'priority' }).steps[0] as Node<'if'>;
        expect(byField.branches.map(b => b.condition.expression)).toEqual([
            '${wfa.dataPill(params.trigger.request_item.priority, "string")}=low',
            '${wfa.dataPill(params.trigger.request_item.priority, "string")}=high',
        ]);
        const byVariable = build({ type: 'variable', item_variable: 'abc' }).steps[0] as Node<'if'>;
        expect(byVariable.confidence).toBe('manual');
        expect(byVariable.branches[0].condition).toMatchObject({ derived: false, source: 'catalog variable abc = low' });
    });

    it('makes an else exit the flow\'s else and reads custom exit conditions on the record', () => {
        const plan = planFlowConversion(buildExport({
            activities: [
                { id: 'begin', type: 'Begin' },
                { id: 'sw', type: 'Switch', vars: { type: 'field', field: 'cmdb_ci' }, exits: [{ name: 'Else', elseFlag: true }, { name: 'SAP', condition: "current.category == 'sap'" }] },
                { id: 'sap', type: 'Log Message', vars: { message: 'sap' } },
                { id: 'other', type: 'Log Message', vars: { message: 'other' } },
                { id: 'done', type: 'Log Message', vars: { message: 'done' } },
                { id: 'end', type: 'End' },
            ],
            edges: [['begin', 'Always', 'sw'], ['sw', 'SAP', 'sap'], ['sw', 'Else', 'other'], ['sap', 'Always', 'done'], ['other', 'Always', 'done'], ['done', 'Always', 'end']],
        }));
        const decision = plan.steps[0] as Node<'if'>;
        expect(decision.branches.map(b => b.label)).toEqual(['SAP']);
        expect(decision.branches[0].condition.expression).toBe('${wfa.dataPill(params.trigger.request_item.category, "string")}=sap');
        expect(decision.otherwise?.label).toBe('Else');
    });

    it('creates a branchable sc_task when the workflow branches on how a catalog task closed', () => {
        const plan = planFlowConversion(buildExport({
            activities: [
                { id: 'begin', type: 'Begin' },
                { id: 'task', type: 'Catalog Task', name: 'Fulfil', vars: { task_short_description: 'Do it', task_priority: '2' },
                    exits: [{ name: 'Closed Complete', condition: "activity.result == '3'" }, { name: 'Closed Incomplete', condition: "activity.result == '4'" }] },
                { id: 'ok', type: 'Log Message', vars: { message: 'ok' } },
                { id: 'end', type: 'End' },
            ],
            edges: [['begin', 'Always', 'task'], ['task', 'Closed Complete', 'ok'], ['task', 'Closed Incomplete', 'end'], ['ok', 'Always', 'end']],
        }));
        const task = plan.steps[0] as Node<'action'>;
        expect(task).toMatchObject({ action: 'action.core.createTask', output: 'fulfil', waits: true });
        expect(task.inputs.task_table).toEqual({ kind: 'literal', value: 'sc_task' });
        expect(Object.keys((task.inputs.field_values as { fields: object }).fields)).toEqual(['request_item', 'parent', 'short_description', 'priority']);
        // Closed Complete carries on below; Closed Incomplete ends the flow
        const decision = plan.steps[1] as Node<'if'>;
        expect(decision.branches[0].label).toBe('Closed Incomplete');
        expect(decision.branches[0].condition.expression).toBe('${wfa.dataPill(fulfil.Record.state, "choice")}=4');
    });

    it('notes an advanced task script only when advanced is on', () => {
        const plan = planFlowConversion(linear([{ id: 'task', type: 'Create Task', vars: { task_table: 'incident_task', advanced: '1', advanced_script: 'task.urgency = 1;' } }]));
        expect((plan.steps[0] as Node<'action'>).notes.join('\n')).toContain('task.urgency = 1;');
        expect(plan.openDecisions.map(d => d.topic)).toContain('task');
    });

    it('keeps Create Catalog Task when nothing branches on the task', () => {
        const plan = planFlowConversion(linear([{ id: 'task', type: 'Catalog Task', vars: { task_short_description: 'Do it', wait_for_completion: '0' } }]));
        expect(plan.steps[0]).toMatchObject({
            action: 'action.core.createCatalogTask', waits: false,
            inputs: { ah_short_description: { kind: 'literal', value: 'Do it' }, ah_wait: { kind: 'literal', value: false } },
        });
    });

    it('waits for an explicit duration directly and flags other timers', () => {
        const plan = planFlowConversion(linear([
            { id: 'wait', type: 'Timer', vars: { duration: '1970-01-02 01:30:00' }, defaults: { script: 'answer = 0;' } },
            { id: 'rel', type: 'Timer', vars: { timer_type: 'relative_duration', relative_duration: 'rd1' } },
        ]));
        expect(plan.steps[0]).toMatchObject({ kind: 'waitForADuration', seconds: 91800, confidence: 'direct' });
        expect(plan.steps[1]).toMatchObject({ kind: 'waitForADuration', confidence: 'partial' });
        expect((plan.steps[1] as Node<'waitForADuration'>).notes[0]).toContain('the relative duration "rd1"');
    });

    it('carries Run Script steps that only set fields as Update Record', () => {
        const plan = planFlowConversion(linear([{ id: 'set', type: 'Run Script', vars: { script: "// close it\ncurrent.state = 3;\ncurrent.close_notes = 'done';" } }]));
        expect(plan.steps[0]).toMatchObject({
            action: 'action.core.updateRecord', confidence: 'direct',
            inputs: { values: { kind: 'template', fields: { state: { kind: 'literal', value: 3 }, close_notes: { kind: 'literal', value: 'done' } } } },
        });
    });

    it('flags approvers added by script and lists settings it did not carry over', () => {
        const plan = planFlowConversion(linear([{
            id: 'appr', type: 'Approval - Group',
            vars: { groups: 'a'.repeat(32), wait_for: 'all', advanced: '1', approver_script: 'answer = ["x"];', u_reason: 'Because' },
        }]));
        const approval = plan.steps[0] as Node<'action'>;
        expect(approval.confidence).toBe('partial');
        expect(approval.inputs.approval_conditions).toMatchObject({ ruleType: 'All', groups: [{ kind: 'literal', value: 'a'.repeat(32) }] });
        expect(approval.notes.join('\n')).toContain('Approvers are also added by script');
        expect(approval.notes).toContain('Not carried over: u_reason = Because');
        expect(plan.openDecisions.map(d => d.topic)).toContain('approval');
    });

    it('plans a subflow when another workflow calls this one, without a record on global workflows', () => {
        const called = planFlowConversion(linear([{ id: 'log', type: 'Log Message', vars: { message: 'hi' } }], { table: 'incident', parents: ['Parent'] }));
        expect(called.kind).toBe('subflow');
        expect(called.trigger).toMatchObject({ kind: 'subflow', recordPill: 'params.inputs.record' });
        const global = planFlowConversion(linear([{ id: 'set', type: 'Set Values', vars: { values: 'state=1' } }], { table: 'global' }));
        expect(global.trigger.recordPill).toBe('');
        expect((global.steps[0] as Node<'action'>).inputs.record).toEqual({ kind: 'literal', value: '' });
    });

    it('flags a parallel block inside another one', () => {
        const plan = planFlowConversion(buildExport({
            activities: [
                { id: 'begin', type: 'Begin' },
                { id: 'a', type: 'Log Message', vars: { message: 'a' } },
                { id: 'b', type: 'Branch', name: 'Inner' },
                { id: 'b1', type: 'Log Message', vars: { message: 'b1' } },
                { id: 'b2', type: 'Log Message', vars: { message: 'b2' } },
                { id: 'join', type: 'Join' },
                { id: 'end', type: 'End' },
            ],
            edges: [['begin', 'Always', 'a'], ['begin', 'Always', 'b'], ['a', 'Always', 'join'], ['b', 'Always', 'b1'], ['b', 'Always', 'b2'],
                ['b1', 'Always', 'join'], ['b2', 'Always', 'join'], ['join', 'Complete', 'end'], ['join', 'Incomplete', 'end']],
        }));
        const parallels = nodes(plan).filter((n): n is Node<'parallel'> => n.kind === 'parallel');
        expect(parallels).toHaveLength(2);
        expect(parallels[0].notes).toEqual([]);
        expect(parallels[1].notes[0]).toContain('Nested in another parallel block');
        expect(plan.openDecisions.some(d => d.topic === 'other' && d.detail.includes('inside another parallel block'))).toBe(true);
    });

    it('gives every step a unique id without repeating the workflow name', () => {
        const plan = planFlowConversion(linear([
            { id: 'one', type: 'Log Message', name: 'Test Workflow notice', vars: { message: '1' } },
            { id: 'two', type: 'Log Message', name: 'Test Workflow notice', vars: { message: '2' } },
        ]));
        expect(plan.steps.map(n => n.id)).toEqual(['notice', 'notice_2']);
    });
});

describe('encodedQueryToCondition', () => {
    it('turns each field into a data pill and keeps operators', () => {
        expect(encodedQueryToCondition('active=true^NQpriority<=2', 'params.trigger.current')).toEqual({
            derived: true, source: 'active=true^NQpriority<=2',
            expression: '${wfa.dataPill(params.trigger.current.active, "string")}=true^NQ${wfa.dataPill(params.trigger.current.priority, "string")}<=2',
        });
    });

    it('cannot derive catalog variables or scripted values', () => {
        expect(encodedQueryToCondition('variables.abc=true', 'params.trigger.request_item').derived).toBe(false);
        expect(encodedQueryToCondition('assigned_to=javascript:gs.getUserID()', 'params.trigger.current').derived).toBe(false);
    });
});

describe('identifierFrom', () => {
    it('makes code-safe identifiers', () => {
        expect(identifierFrom('New Hardware Request (EMEA)')).toBe('new_hardware_request_emea');
        expect(identifierFrom('2nd step!')).toBe('x_2nd_step');
        expect(identifierFrom('')).toBe('x_step');
    });
});
