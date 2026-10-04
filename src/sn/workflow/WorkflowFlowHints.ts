import { WorkflowStructure } from "./WorkflowStructure";

/** Likely Flow Designer construct per out-of-box activity type — a hint, not a mapping. */
const FLOW_HINTS: Record<string, string> = {
    'Approval - User': 'Ask For Approval (user rules)',
    'Approval - Group': 'Ask For Approval (group rules)',
    'Approval Coordinator': 'Ask For Approval with several rule sets',
    'Manual Approvals': 'Wait For Condition on the approvals',
    'Approval Action': 'Update Record (approval field)',
    'Catalog Task': 'Create Catalog Task',
    'Create Task': 'Create Task',
    'Set Values': 'Update Record',
    'Run Script': 'custom action with a script step (or Update Record / Set Flow Variables if it only sets values)',
    'If': 'If / Else',
    'Switch': 'If / Else If',
    'Timer': 'Wait For a Duration',
    'Wait for condition': 'Wait For Condition',
    'Wait for WF Event': 'Wait For Message',
    'Notification': 'Send Email',
    'Log Message': 'Log',
    'Create Event': 'Fire Event',
    'Branch': 'Do the following in Parallel',
    'Join': '(end of the parallel block)',
    'Rollback To': 'loop back: Do the following until',
    'Turnstile': 'loop counter (flow variable)',
    'Workflow': 'subflow call',
    'Return Value': 'Assign Subflow Outputs',
    'Parallel Flow Launcher': 'For Each with subflows',
    'Lock': '(no equivalent — redesign)',
    'Unlock': '(no equivalent — redesign)',
};

/** The likely Flow Designer construct for an activity, for outline annotations. */
export function flowHintFor(s: WorkflowStructure, sysId: string): string | undefined {
    if (s.isDesigner(sysId)) return 'IntegrationHub / spoke action';
    return FLOW_HINTS[s.activity(sysId)?.type];
}
