/**
 * Views of a legacy workflow export (outline, nodes, analysis, Mermaid), on synthetic exports.
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { WorkflowExport } from '../../../../src/sn/workflow/WorkflowModels';
import {
    analyzeWorkflow,
    lineCount,
    renderWorkflowAnalysis,
    renderWorkflowMermaid,
    renderWorkflowNodes,
    renderWorkflowOutline,
    trivialCondition,
} from '../../../../src/sn/workflow/WorkflowViews';
import { buildOutline, WorkflowStructure } from '../../../../src/sn/workflow/WorkflowStructure';
import { buildExport } from './workflowExportBuilder';

const fixture = (name: string): WorkflowExport => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as WorkflowExport;
const LAPTOP = fixture('laptop-request');
const MERGE = fixture('merge-without-join');

describe('renderWorkflowOutline', () => {
    const text = renderWorkflowOutline(LAPTOP);

    it('names what starts the workflow', () => {
        expect(text).toContain('# Laptop Request  (wf_workflow wf-laptop, version ver-laptop published, table sc_req_item');
        expect(text).toContain('TRIGGER catalog item "Laptop"');
        expect(text).toContain('stages: Waiting for Approval → Completed');
    });

    it('numbers steps top to bottom, each activity once (End is a marker)', () => {
        const numbers = text.split('\n').map(l => /^\s*(\d+)\. /.exec(l)?.[1]).filter(Boolean).map(Number);
        expect(numbers).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    });

    it('lets a side branch skip ahead to steps the main path shows', () => {
        expect(text).toContain('  on No:\n    → continue at step 13 (Close complete)\n  on Yes ↓\n6. Prepare order [Run Script]');
        expect(text).toContain('13. Close complete [Set Values]  (stage: Completed)\n');
    });

    it('reads short branches as guard clauses and carries on with the main path', () => {
        expect(text).toContain('  on Skipped: (no transition — the workflow stops here)\n  on Rejected:\n    3. Close rejected [Set Values]');
        expect(text).toContain('  on Approved ↓\n4. Provision account [Workflow] [WAIT]');
    });

    it('closes parallel branches at their Join and points loops back', () => {
        expect(text).toContain('7. Order and account [Branch]\n  in parallel:\n    branch 1:');
        expect(text).toContain('↻ on Continue: back to step 9 (Create the account)');
        expect(text).toContain('↳ paths rejoin:\n12. All done [Join] [WAIT]');
        expect(text).toContain('on Incomplete:\n    → continue at step 11 (Notify failure)');
    });

    it('marks waits from the activity type, honouring wait_for_completion', () => {
        for (const step of ['Manager approval [Approval - User] [WAIT]', 'Order laptop [Catalog Task] [WAIT]', 'Provision account [Workflow] [WAIT]', 'All done [Join] [WAIT]']) {
            expect(text).toContain(step);
        }
        expect(text).toContain('14. Heads-up task [Create Task]\n');
        expect(text).toContain('[Create AD User] [DESIGNER]');
    });

    it('shows what was configured, not the defaults', () => {
        expect(text).toContain('- users = ${requested_for.manager}');
        expect(text).toContain('- condition = variables.needs_laptop=true^EQ  (catalog variables named)');
        expect(text).toContain('- task_fulfillment_group = c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2  (Hardware Desk)');
        expect(text).toContain('| workflow.scratchpad.ticket = current.number;');
        expect(text).toContain('- input.UserName = ${current.variables.user}');
        expect(text).toContain('- runs workflow "Child provisioning" (wf-child)');
        expect(text).not.toContain('approver_script');
        expect(text).not.toContain('relative_duration');
    });

    it('brings the defaults back with allValues', () => {
        const all = renderWorkflowOutline(LAPTOP, { allValues: true });
        expect(all).toContain('approver_script');
        expect(all).toContain('relative_duration');
    });

    it('lists unreachable activities separately', () => {
        expect(text).toContain('UNREACHABLE — nothing transitions here from Begin:\n  15. Old log step [Log Message]');
    });

    it('annotates likely Flow Designer constructs only when asked', () => {
        const hinted = renderWorkflowOutline(LAPTOP, { flowHints: true });
        expect(hinted).toContain('Manager approval [Approval - User] [WAIT]  (stage: Waiting for Approval)  ≈ Ask For Approval');
        expect(hinted).toContain('[Create AD User] [DESIGNER]  ≈ IntegrationHub / spoke action');
        expect(text).not.toContain('≈');
    });

    it('calls out parallel branches that rejoin without a Join', () => {
        const merge = renderWorkflowOutline(MERGE);
        expect(merge).toContain('↳ paths rejoin WITHOUT a Join — what follows runs once per branch:\n5. Send summary');
        expect(merge).toContain('TRIGGER condition = priority=1^EQ; condition type = run_match');
    });

    it('cuts long scripts unless asked for them in full', () => {
        const long = structuredClone(LAPTOP);
        const prep = long.activities.find(a => a.sysId === 'prep');
        prep.variables.find(v => v.element === 'script').value = Array.from({ length: 40 }, (_, i) => `line${i};`).join('\n');
        expect(renderWorkflowOutline(long)).toContain('| … 15 more lines (full scripts)');
        expect(renderWorkflowOutline(long, { fullScripts: true })).toContain('| line39;');
    });
});

describe('analyzeWorkflow / renderWorkflowAnalysis', () => {
    it('reports structure problems and data flow', () => {
        const text = renderWorkflowAnalysis(LAPTOP);
        expect(text).toContain('PATHS Begin → end (ignoring loops): 7');
        expect(text).toContain('Order and account (Always) → Order laptop, Create the account   — rejoin at All done [Join]');
        expect(text).toContain('Retry account? (Continue) ↻ back to Create the account   — capped by Turnstile Retry account?');
        expect(text).toContain('EXITS WITH NO TRANSITION (the workflow can stop there; a validation warning):\n  Manager approval: Skipped');
        expect(text).toContain('UNREACHABLE (no path from Begin — never runs): Old log step');
        expect(text).toContain('  ticket: set by Prepare order; used by Order laptop');
        expect(text).toContain('CATALOG VARIABLES read: laptop_model (Prepare order); needs_laptop (Needs a laptop?); user (Create the account)');
        expect(text).toContain('Close complete [Set Values] values: stage, state');
        expect(text).toContain('SUBFLOWS CALLED: Provision account → "Child provisioning"');
    });

    it('lists activity types by count, ties by name', () => {
        expect(renderWorkflowAnalysis(LAPTOP)).toContain('ACTIVITIES 16: Set Values ×2, Approval - User ×1, Begin ×1, Branch ×1,');
    });

    it('reports merges without a Join after a parallel split', () => {
        expect(renderWorkflowAnalysis(MERGE)).toContain('MERGES WITHOUT A JOIN after a parallel split (these run once per arriving branch):\n  Send summary [Notification] — branches from Split');
        expect(analyzeWorkflow(MERGE).mergesWithoutJoin).toEqual([{ activity: expect.any(String), splitAt: expect.any(String) }]);
    });

    it('returns activity references as sys_ids', () => {
        const a = analyzeWorkflow(LAPTOP);
        expect(a.unreachable).toEqual(['old']);
        expect(a.loops).toEqual([{ from: 'retry', exit: 'Continue', to: 'acct', cappedBy: 'retry' }]);
        expect(a.deadExits).toEqual([{ activity: 'appr', exit: 'Skipped' }]);
        expect(a.designerActivities).toEqual(['acct']);
        expect(a.scratchpad).toEqual([{ key: 'ticket', setBy: ['prep'], usedBy: ['order'] }]);
    });
});

describe('renderWorkflowNodes', () => {
    it('lists every activity with its exits and where it is reached from', () => {
        const text = renderWorkflowNodes(LAPTOP);
        expect(text).toContain('Retry account? [Turnstile]   retry');
        expect(text).toContain('     from: Create the account (Failure)');
        expect(text).toContain('     Continue → Create the account ↻');
        expect(text).toContain('     Skipped → (no transition)');
        expect(text).toContain('Old log step [Log Message]   old   UNREACHABLE');
    });
});

describe('renderWorkflowMermaid', () => {
    it('draws decisions, loops and dead exits', () => {
        const text = renderWorkflowMermaid(LAPTOP);
        expect(text.startsWith('flowchart TD')).toBe(true);
        expect(text).toMatch(/n\d+\{"⏸ Manager approval<br\/>\[Approval - User\]"\}/);
        expect(text).toMatch(/-\.->\|Continue ↻\|/);
        expect(text).toContain('(("no transition"))');
    });
});

describe('WorkflowStructure', () => {
    it('finds loops from Begin and the step numbers of the outline', () => {
        const s = new WorkflowStructure(LAPTOP);
        expect(s.begin).toBe('begin');
        expect([...s.backEdges]).toEqual([expect.stringMatching(/^retry\|.+\|acct$/)]);
        expect(buildOutline(s).numbers.get('join')).toBe(12);
    });

    it('rejoins parallel branches at their Join', () => {
        expect(new WorkflowStructure(LAPTOP).mergeOf('fan')).toBe('join');
    });
});

describe('helpers', () => {
    it('trivialCondition recognises plain exit conditions', () => {
        expect(trivialCondition('Approved', "activity.result == 'approved'")).toBe(true);
        expect(trivialCondition('Always', 'true')).toBe(true);
        expect(trivialCondition('Big', 'current.price > 100')).toBe(false);
    });

    it('lineCount ignores a final line break', () => {
        expect(lineCount('a\nb\n')).toBe(2);
        expect(lineCount('a\r\nb')).toBe(2);
        expect(lineCount('')).toBe(1);
    });
});

describe('structure edge cases (code review)', () => {
    it('gives a shared tail to the main path, not to the first side branch', () => {
        const data = buildExport({
            activities: [
                { id: 'begin', type: 'Begin' },
                { id: 'route', type: 'Switch', vars: { type: 'field', field: 'priority' }, exits: ['Low', 'Mid', 'High'] },
                { id: 'notify', type: 'Log Message' }, { id: 'done', type: 'Log Message' }, { id: 'other', type: 'Log Message' },
                { id: 'end', type: 'End' },
            ],
            edges: [['begin', 'Always', 'route'], ['route', 'Low', 'notify'], ['route', 'Mid', 'done'], ['route', 'High', 'other'],
                ['notify', 'Always', 'done'], ['done', 'Always', 'end'], ['other', 'Always', 'end']],
        });
        const text = renderWorkflowOutline(data);
        expect(text).toContain('  on Mid:\n    → continue at step 5 (done)');
        expect(text).toContain('  on Low ↓\n4. notify [Log Message]\n5. done [Log Message]\n■ End');
    });

    it('rejoins parallel lines where they meet, not at a later Join', () => {
        const data = buildExport({
            activities: [
                { id: 'begin', type: 'Begin' }, { id: 'split', type: 'Branch' },
                { id: 'left', type: 'Log Message' }, { id: 'right', type: 'Log Message' }, { id: 'shared', type: 'Log Message' },
                { id: 'join', type: 'Join' }, { id: 'end', type: 'End' },
            ],
            edges: [['begin', 'Always', 'split'], ['split', 'Always', 'left'], ['split', 'Always', 'right'], ['left', 'Always', 'shared'],
                ['right', 'Always', 'shared'], ['shared', 'Always', 'join'], ['join', 'Complete', 'end'], ['join', 'Incomplete', 'end']],
        });
        expect(renderWorkflowOutline(data)).toContain('↳ paths rejoin WITHOUT a Join — what follows runs once per branch:\n5. shared [Log Message]\n6. join [Join] [WAIT]');
    });

    it('shows a cycle nothing leads to, and reports its loop', () => {
        const data = buildExport({
            activities: [{ id: 'begin', type: 'Begin' }, { id: 'end', type: 'End' }, { id: 'a', type: 'Log Message' }, { id: 'b', type: 'Log Message' }, { id: 'stray', type: 'Log Message' }],
            edges: [['begin', 'Always', 'end'], ['a', 'Always', 'b'], ['b', 'Always', 'a']],
        });
        const text = renderWorkflowOutline(data);
        expect(text).toContain('UNREACHABLE — nothing transitions here from Begin:\n  2. stray [Log Message]');
        expect(text).toContain('  3. a [Log Message]\n  4. b [Log Message]\n    ↻ on Always: back to step 3 (a)');
        expect(text.match(/UNREACHABLE/g)).toHaveLength(1);
        expect(analyzeWorkflow(data).loops).toEqual([{ from: 'b', exit: 'Always', to: 'a' }]);
    });

    it('reads an export with missing optional parts', () => {
        const data = buildExport({ activities: [{ id: 'begin', type: 'Begin' }, { id: 'run', type: 'Run Script' }, { id: 'end', type: 'End' }],
            edges: [['begin', 'Always', 'run'], ['run', 'Always', 'end']] });
        delete (data.activities[1] as Partial<typeof data.activities[1]>).variables;
        delete (data as Partial<WorkflowExport>).version;
        expect(() => renderWorkflowOutline(data)).not.toThrow();
        expect(() => renderWorkflowAnalysis(data)).not.toThrow();
    });
});
