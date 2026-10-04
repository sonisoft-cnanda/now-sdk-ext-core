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

    it('reads short branches as guard clauses and carries on with the main path', () => {
        expect(text).toContain('  on Skipped: (no transition — the workflow stops here)\n  on Rejected:\n    3. Close rejected [Set Values]');
        expect(text).toContain('  on Approved ↓\n4. Provision account [Workflow] [WAIT]');
    });

    it('closes parallel branches at their Join and points loops back', () => {
        expect(text).toContain('9. Order and account [Branch]\n  in parallel:\n    branch 1:');
        expect(text).toContain('↻ on Continue: back to step 11 (Create the account)');
        expect(text).toContain('↳ paths rejoin:\n14. All done [Join] [WAIT]');
        expect(text).toContain('on Incomplete:\n    → continue at step 13 (Notify failure)');
    });

    it('marks waits from the activity type, honouring wait_for_completion', () => {
        for (const step of ['Manager approval [Approval - User] [WAIT]', 'Order laptop [Catalog Task] [WAIT]', 'Provision account [Workflow] [WAIT]', 'All done [Join] [WAIT]']) {
            expect(text).toContain(step);
        }
        expect(text).toContain('7. Heads-up task [Create Task]\n');
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
        expect(buildOutline(s).numbers.get('join')).toBe(14);
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
