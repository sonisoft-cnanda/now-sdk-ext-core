# WorkflowManager

`WorkflowManager` works with legacy ServiceNow workflows — the Workflow Editor's `wf_*`
records, not Flow Designer. It can find and read workflows, check them out, add and edit
activities (including their variables), wire transitions, validate, and publish, all with
the same server-side behaviour as the Workflow Editor.

For how legacy workflows work underneath — tables, business rules, the editor's endpoints,
variable storage, checkout and publish semantics — see
[Legacy Workflow Internals](./LegacyWorkflowInternals.md).

## Table of Contents

- [Overview](#overview)
- [Constructor](#constructor)
- [Editing workflows like the Workflow Editor](#editing-workflows-like-the-workflow-editor)
  - [Reading](#reading)
  - [Lifecycle](#lifecycle)
  - [Editing a draft](#editing-a-draft)
  - [Activity variables](#activity-variables)
  - [Errors](#errors)
  - [Example: check out, add an approval, publish](#example-check-out-add-an-approval-publish)
- [Record methods (direct inserts)](#record-methods-direct-inserts)
- [Interfaces](#interfaces)
- [Examples](#examples)
- [Best Practices](#best-practices)
- [Related](#related)

## Overview

There are two families of methods:

| Family | Methods | How they write |
|---|---|---|
| **Editor parity** (recommended) | `newWorkflow`, `checkout`, `addActivity`, `updateActivity`, `removeActivity`, `addTransition`, `publish`, … | The Workflow Editor's diagram processor (`/xmlhttp.do`, `WorkflowDiagramProcessor`) for structure and lifecycle, and the `wf_activity` classic form for activity configuration |
| **Record methods** (original) | `createWorkflow`, `createWorkflowVersion`, `createActivity`, `createTransition`, `createCondition`, `publishWorkflow`, `createCompleteWorkflow` | Direct Table API inserts |

Editor parity matters because much of a legacy workflow's behaviour lives on the server:
checkout is a deep copy of the published version, publish validates, computes the
workflow's paths, retires the previous version and records the workflow in the current
update set, and activity variables are only written correctly through the activity form.

## Constructor

```typescript
constructor(instance: ServiceNowInstance)
```

### Example

```typescript
import { ServiceNowInstance, WorkflowManager } from '@sonisoft/now-sdk-ext-core';

const workflowManager = new WorkflowManager(instance);
```

## Editing workflows like the Workflow Editor

Edits always happen on a **draft**: a version checked out to the current user. Published
versions are read-only, exactly as in the editor. Every editing method checks this first
and throws a clear error otherwise.

```
checkout(workflow)          → draft version (a copy of the published one)
addActivity / updateActivity / removeActivity / addTransition / …   on the draft
validateWorkflow(draft)     → optional dry run of publish's validation
publish(draft)              → draft becomes the published version
discardCheckout(draft)      → throw the draft away instead
```

Requirements: the user needs `admin` or `workflow_admin` (the instance's
`WorkflowAccess` check; `snc_required_script_writer_permission` also satisfies it). Publishing
writes to the user's **current update set**.

### Reading

| Method | Returns |
|---|---|
| `findWorkflows({ name?, table?, query?, limit? })` | `WorkflowSummary[]` — each with `publishedVersionSysId` and `checkedOutVersion` (`byCurrentUser` tells you if it is yours) |
| `resolveWorkflow(nameOrSysId)` | `WorkflowSummary` — accepts a name, a wf_workflow sys_id or any version sys_id |
| `getWorkflowVersions(workflowSysId)` | `WorkflowVersionSummary[]`, newest first |
| `getWorkflowDefinition(versionSysId, { includeVariables?, includeStatus? })` | `WorkflowDefinition` — activities (with `variables` by element name and their exits), transitions, stages, and the current user's permissions |
| `getWorkflowGraph(versionSysId)` | `WorkflowGraph` — the version exactly as the editor's diagram processor reports it |
| `listActivityDefinitions({ name?, category?, includeDesigner? })` | Activity types |
| `getActivityDefinition(nameOrSysId, { includeScript? })` | `ActivityDefinitionDetail` — the type as the instance defines it: its description, attributes, variables (type, default, choices, reference, hint) or Activity Designer inputs/outputs, starting exits, and with `includeScript` its implementation |
| `getActivityUsage(nameOrSysId, { sampleSize?, examplesPerField?, maxValueLength? })` | `ActivityUsage` — how published workflows on the instance configure the type: per variable/input, how often it is set and its most common values (`isDefault` marks untouched defaults) |
| `exportWorkflow(workflow, { version? })` | `WorkflowExport` — one complete, self-contained JSON definition of a version: properties, trigger, inputs, stages, activities with labelled variables (defaults marked, choices and references named) and exits, transitions, the activity types used (with whether they wait), subflows called and what uses it. `nex workflow export`; the `legacy-workflow` skill's `workflow-graph.sh` turns it into an outline, analysis or Mermaid graph. |
| `validateWorkflow(versionSysId)` | `WorkflowValidationReport` — the editor's "Validate Workflow" report |
| `getDraftVersion(workflow)` | The sys_id of the current user's draft, or a clear error |

### Lifecycle

| Method | Notes |
|---|---|
| `newWorkflow({ name, table, description?, condition?, conditionType?, fields? })` | Creates the workflow with Begin → End, checked out to you. Names must be unique. |
| `checkout(workflow, { force? })` | Creates your draft from the published version. Returns your existing draft if you already have one (`alreadyCheckedOut: true`). Another user's checkout is refused unless `force` (the editor's Force Checkout). |
| `publish(versionSysId, { allowWarnings? })` | Validates, then publishes. Warnings stop it unless `allowWarnings`; critical findings always do. Returns accepted warnings and `fullSequences`. |
| `discardCheckout(versionSysId)` | Deletes your draft, keeping the published version. Refuses if the draft is the only version. |
| `deleteWorkflow(workflow)` | Deletes every version, and with the last one the workflow. |
| `setWorkflowActive(versionSysId, active)` | The editor's Set Active / Set Inactive. |
| `updateWorkflowProperties(versionSysId, { name?, description?, condition?, conditionType?, fields? })` | Changes the draft's properties. |

### Editing a draft

| Method | Notes |
|---|---|
| `addActivity(versionSysId, options)` | See below. |
| `updateActivity(activitySysId, { name?, variables?, input?, stage?, x?, y? })` | Variables you omit keep their values. |
| `removeActivity(activitySysId, { reconnect? })` | Removes the activity with its exits and variables. `reconnect` joins its single incoming and outgoing transitions. Begin and End cannot be removed. |
| `moveActivities([{ sysId, x, y }])` | Repositions activities. |
| `addTransition({ from, to, condition? })` | `condition` is the exit's name or sys_id; required when `from` has several exits. Duplicate paths are refused. |
| `retargetTransition(transitionSysId, toActivitySysId)` | Points a transition at another activity. |
| `removeTransition(transitionSysId)` | |
| `addCondition` / `updateCondition` / `removeCondition` | Manage an activity's exits. Removing an exit also removes the transitions leaving from it. |

`addActivity` options:

| Option | Description |
|---|---|
| `definition` | Activity type: sys_id or exact name (`"Timer"`, `"Approval - User"`). A core activity wins over same-named Activity Designer ones; true ambiguity is an error listing the candidates. |
| `name` | The activity's name |
| `variables` | Variable values by element name — see [Activity variables](#activity-variables) |
| `input` | Activity Designer input mapping (object or JSON text) |
| `insertOn` | Transition sys_id to drop the activity onto, like dropping onto a line in the editor: the transition is re-pointed at the new activity and a new one runs from it to the original target |
| `connectFrom` | `{ activity, condition? }` — add a transition into the new activity |
| `connectTo` | Activity sys_id — add a transition out of the new activity |
| `exitCondition` | Which of the new activity's exits feeds `insertOn` / `connectTo` (default: its first exit, as the editor does) |
| `x`, `y`, `stage` | Position (defaults to the middle of `insertOn`, or right of `connectFrom`) and stage (sys_id, name or value) |

### Activity variables

Activity configuration (a Timer's duration, a Run Script's script, an approval's approvers)
is stored as variables — `sys_variable_value` rows — not on the activity record. They are
written by posting the activity form, through [`FormRecordWriter`](./FormRecordWriter.md),
which is what the editor does.

- Discover what a type accepts with `getActivityDefinition('Timer')`, how it behaves with
  `{ includeScript: true }`, and how the instance already configures it with
  `getActivityUsage('Timer')`. Types are instance data — read them rather than hard-coding.
- Unknown variables are rejected before anything is written, with the list of valid ones.
- Choice values are checked; a label (`'Script'`) is accepted for its value (`'script'`).
- Durations accept seconds (`90`), `{ days, hours, minutes, seconds }`, `'D HH:MM:SS'` or the
  stored `'1970-01-01 HH:MM:SS'`.
- Booleans accept `true`/`false`; lists accept arrays.
- On insert, variables you omit get the type's defaults; on update, they keep their values.
- Values come back from `getWorkflowDefinition` in stored form (durations as
  `1970-01-01 00:01:30`, booleans as `1`/`0`).

### Errors

| Error | When |
|---|---|
| `WorkflowValidationError` | `publish` blocked by validation. `level` is `'warning'` or `'critical'`; `items` holds each finding (with the offending activity in `details`). |
| `FormSubmitError` | The instance rejected an activity form submit; `messages` holds its error messages. |
| `InvalidParameterException` | Bad input: unknown variable or choice, ambiguous name, activity from another version, … |
| `Error` | Not checked out / checked out by someone else, missing records. |

### Example: check out, add an approval, publish

```typescript
import { ServiceNowInstance, WorkflowManager, WorkflowValidationError } from '@sonisoft/now-sdk-ext-core';

const wm = new WorkflowManager(instance);

const { versionSysId: draft } = await wm.checkout('Laptop Request');
const definition = await wm.getWorkflowDefinition(draft);
const begin = definition.activities.find(a => a.definitionName === 'Begin');
const firstLine = definition.transitions.find(t => t.from === begin.sysId);

// Drop a manager approval onto the first line
const approval = await wm.addActivity(draft, {
    definition: 'Approval - User',
    name: 'Manager approval',
    insertOn: firstLine.sysId,
    exitCondition: 'Approved',
    variables: { approver_script: 'answer = [current.request.requested_for.manager];', advanced: true },
});

// Send Rejected to End
const end = definition.activities.find(a => a.definitionName === 'End');
await wm.addTransition({ from: approval.activitySysId, condition: 'Rejected', to: end.sysId });

try {
    await wm.publish(draft);
} catch (error) {
    if (error instanceof WorkflowValidationError && error.level === 'warning') {
        console.warn(error.items.map(i => i.message));
        await wm.publish(draft, { allowWarnings: true });
    } else {
        throw error;
    }
}
```

## Record methods (direct inserts)

These insert wf_* records directly through the Table API. They predate the editor-parity
methods and are kept for compatibility. Prefer `newWorkflow` / `addActivity` for new code:
a direct `createActivity` without `variables` writes no variables.


### createWorkflow

Create a new workflow record.

```typescript
async createWorkflow(options: CreateWorkflowOptions): Promise<CreateWorkflowResult>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `options` | `CreateWorkflowOptions` | Workflow creation options |

#### CreateWorkflowOptions

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | `string` | Yes | Name of the workflow |
| `description` | `string` | No | Description of the workflow |
| `template` | `boolean` | No | Whether this is a template workflow |
| `access` | `string` | No | Access level (e.g., `"public"`, `"package_private"`) |

#### Returns

`Promise<CreateWorkflowResult>` containing:
- `workflowSysId`: The sys_id of the created workflow
- `name`: The name of the created workflow

#### Example

```typescript
const result = await workflowManager.createWorkflow({
    name: 'Incident Escalation',
    description: 'Escalates high-priority incidents automatically',
    access: 'public'
});

console.log(`Workflow created: ${result.workflowSysId}`);
```

---

### createWorkflowVersion

Create a new workflow version tied to a parent workflow and a target table.

```typescript
async createWorkflowVersion(options: CreateWorkflowVersionOptions): Promise<CreateWorkflowVersionResult>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `options` | `CreateWorkflowVersionOptions` | Workflow version creation options |

#### CreateWorkflowVersionOptions

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | `string` | Yes | Name of the workflow version |
| `workflowSysId` | `string` | Yes | The sys_id of the parent workflow |
| `table` | `string` | Yes | The table this version applies to (e.g., `"incident"`) |
| `description` | `string` | No | Description of the workflow version |
| `active` | `boolean` | No | Whether the version is active |
| `published` | `boolean` | No | Whether the version is published |
| `condition` | `string` | No | Condition expression for triggering the workflow |
| `order` | `number` | No | Execution order |

#### Returns

`Promise<CreateWorkflowVersionResult>` containing:
- `versionSysId`: The sys_id of the created workflow version
- `name`: The name of the created workflow version

#### Example

```typescript
const version = await workflowManager.createWorkflowVersion({
    name: 'Incident Escalation v1',
    workflowSysId: result.workflowSysId,
    table: 'incident',
    active: true,
    condition: 'priority=1'
});

console.log(`Version created: ${version.versionSysId}`);
```

---

### createActivity

Create a new workflow activity within a workflow version.

```typescript
async createActivity(options: CreateActivityOptions): Promise<CreateActivityResult>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `options` | `CreateActivityOptions` | Activity creation options |

#### CreateActivityOptions

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | `string` | Yes | Name of the activity |
| `workflowVersionSysId` | `string` | Yes | The sys_id of the workflow version |
| `activityDefinitionSysId` | `string` | No | The sys_id of the activity definition (type) |
| `x` | `number` | No | X position on the workflow canvas |
| `y` | `number` | No | Y position on the workflow canvas |
| `width` | `number` | No | Width on the workflow canvas |
| `height` | `number` | No | Height on the workflow canvas |
| `script` | `string` | No | Script content for the activity |
| `vars` | `string` | No | Activity variables (JSON string or comma-separated key=value pairs). Not written to `sys_variable_value`; use `variables`. |
| `variables` | `Record<string, FormValueInput>` | No | Variable values by element name. Creates the activity through the `wf_activity` form so the variables are actually saved; requires `activityDefinitionSysId`. |

#### Returns

`Promise<CreateActivityResult>` containing:
- `activitySysId`: The sys_id of the created activity
- `name`: The name of the created activity

#### Example

```typescript
const activity = await workflowManager.createActivity({
    name: 'Send Notification',
    workflowVersionSysId: version.versionSysId,
    x: 200,
    y: 100,
    script: 'gs.eventQueue("incident.escalated", current, current.assigned_to);'
});

console.log(`Activity created: ${activity.activitySysId}`);
```

---

### createTransition

Create a transition between two activities.

```typescript
async createTransition(options: CreateTransitionOptions): Promise<CreateTransitionResult>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `options` | `CreateTransitionOptions` | Transition creation options |

#### CreateTransitionOptions

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `fromActivitySysId` | `string` | Yes | The sys_id of the source activity |
| `toActivitySysId` | `string` | Yes | The sys_id of the target activity |
| `conditionSysId` | `string` | No | The sys_id of an optional condition record |
| `order` | `number` | No | Execution order of this transition |

#### Returns

`Promise<CreateTransitionResult>` containing:
- `transitionSysId`: The sys_id of the created transition

#### Example

```typescript
const transition = await workflowManager.createTransition({
    fromActivitySysId: startActivity.activitySysId,
    toActivitySysId: notifyActivity.activitySysId
});

console.log(`Transition created: ${transition.transitionSysId}`);
```

---

### createCondition

Create a condition on an activity for branching logic.

```typescript
async createCondition(options: CreateConditionOptions): Promise<CreateConditionResult>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `options` | `CreateConditionOptions` | Condition creation options |

#### CreateConditionOptions

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `activitySysId` | `string` | Yes | The sys_id of the activity this condition belongs to |
| `name` | `string` | Yes | Name of the condition |
| `description` | `string` | No | Description of the condition |
| `condition` | `string` | No | Condition expression |
| `order` | `number` | No | Execution order |
| `elseFlag` | `boolean` | No | Whether this is an else condition |

#### Returns

`Promise<CreateConditionResult>` containing:
- `conditionSysId`: The sys_id of the created condition
- `name`: The name of the created condition

#### Example

```typescript
const condition = await workflowManager.createCondition({
    activitySysId: checkActivity.activitySysId,
    name: 'Is P1 Incident',
    condition: 'current.priority == 1'
});

console.log(`Condition created: ${condition.conditionSysId}`);
```

---

### publishWorkflow

Set a version's start activity and publish it. Publishing goes through the Workflow
Editor's publish without its validation step (this method never validated), so the
previous version is retired, paths are computed and the workflow is recorded in the
current update set. Use [`publish`](#lifecycle) when you want validation.

```typescript
async publishWorkflow(options: PublishWorkflowOptions): Promise<void>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `options` | `PublishWorkflowOptions` | Publish options |

#### PublishWorkflowOptions

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `versionSysId` | `string` | Yes | The sys_id of the workflow version to publish |
| `startActivitySysId` | `string` | Yes | The sys_id of the start activity |

#### Example

```typescript
await workflowManager.publishWorkflow({
    versionSysId: version.versionSysId,
    startActivitySysId: startActivity.activitySysId
});

console.log('Workflow published successfully');
```

---

### createCompleteWorkflow

Create a complete workflow from a single specification. Orchestrates all steps: create workflow, create version, create activities, create transitions, and optionally publish.

Activity references in transitions use the activity's `id` field (if set) or its index in the `activities` array (as a string like `"0"`, `"1"`, etc.).

```typescript
async createCompleteWorkflow(
    spec: CompleteWorkflowSpec,
    onProgress?: (message: string) => void
): Promise<CompleteWorkflowResult>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `spec` | `CompleteWorkflowSpec` | The complete workflow specification |
| `onProgress` | `(message: string) => void` | Optional progress callback |

#### Returns

`Promise<CompleteWorkflowResult>` containing:
- `workflowSysId`: The sys_id of the created workflow
- `versionSysId`: The sys_id of the created workflow version
- `activitySysIds`: Map of activity id/index keys to their created sys_ids
- `transitionSysIds`: Array of created transition sys_ids
- `published`: Whether the workflow was published
- `startActivity`: The start activity key, if published

#### Example

```typescript
const result = await workflowManager.createCompleteWorkflow({
    name: 'Incident Triage',
    table: 'incident',
    description: 'Auto-triage incoming incidents',
    activities: [
        { id: 'start', name: 'Begin', x: 100, y: 50 },
        { id: 'check', name: 'Check Priority', x: 100, y: 150 },
        { id: 'notify', name: 'Notify On-Call', x: 100, y: 250, script: 'gs.eventQueue("notify", current);' }
    ],
    transitions: [
        { from: 'start', to: 'check' },
        { from: 'check', to: 'notify' }
    ],
    publish: true,
    startActivity: 'start'
}, (message) => console.log(message));

console.log(`Workflow: ${result.workflowSysId}`);
console.log(`Published: ${result.published}`);
```

## Interfaces

### CreateWorkflowOptions

```typescript
interface CreateWorkflowOptions {
    name: string;
    description?: string;
    template?: boolean;
    access?: string;
}
```

### CreateWorkflowResult

```typescript
interface CreateWorkflowResult {
    workflowSysId: string;
    name: string;
}
```

### CreateWorkflowVersionOptions

```typescript
interface CreateWorkflowVersionOptions {
    name: string;
    workflowSysId: string;
    table: string;
    description?: string;
    active?: boolean;
    published?: boolean;
    condition?: string;
    order?: number;
}
```

### CreateWorkflowVersionResult

```typescript
interface CreateWorkflowVersionResult {
    versionSysId: string;
    name: string;
}
```

### CreateActivityOptions

```typescript
interface CreateActivityOptions {
    name: string;
    workflowVersionSysId: string;
    activityDefinitionSysId?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    script?: string;
    vars?: string;
    variables?: Record<string, FormValueInput>;  // saved through the wf_activity form
}
```

### CreateActivityResult

```typescript
interface CreateActivityResult {
    activitySysId: string;
    name: string;
}
```

### CreateTransitionOptions

```typescript
interface CreateTransitionOptions {
    fromActivitySysId: string;
    toActivitySysId: string;
    conditionSysId?: string;
    order?: number;
}
```

### CreateTransitionResult

```typescript
interface CreateTransitionResult {
    transitionSysId: string;
}
```

### CreateConditionOptions

```typescript
interface CreateConditionOptions {
    activitySysId: string;
    name: string;
    description?: string;
    condition?: string;
    order?: number;
    elseFlag?: boolean;
}
```

### CreateConditionResult

```typescript
interface CreateConditionResult {
    conditionSysId: string;
    name: string;
}
```

### PublishWorkflowOptions

```typescript
interface PublishWorkflowOptions {
    versionSysId: string;
    startActivitySysId: string;
}
```

### ActivitySpec

```typescript
interface ActivitySpec {
    id?: string;
    name: string;
    script?: string;
    activityType?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    vars?: string;
    variables?: Record<string, FormValueInput>;  // saved through the wf_activity form
}
```

### TransitionSpec

```typescript
interface TransitionSpec {
    from: string;
    to: string;
    conditionSysId?: string;
    order?: number;
}
```

### CompleteWorkflowSpec

```typescript
interface CompleteWorkflowSpec {
    name: string;
    description?: string;
    table: string;
    template?: boolean;
    access?: string;
    active?: boolean;
    condition?: string;
    activities: ActivitySpec[];
    transitions?: TransitionSpec[];
    publish?: boolean;
    startActivity?: string;
}
```

### CompleteWorkflowResult

```typescript
interface CompleteWorkflowResult {
    workflowSysId: string;
    versionSysId: string;
    activitySysIds: Record<string, string>;
    transitionSysIds: string[];
    published: boolean;
    startActivity?: string;
}
```

## Examples

### Example 1: Build a Workflow Step by Step

```typescript
async function buildWorkflowStepByStep() {
    const wfManager = new WorkflowManager(instance);

    // Step 1: Create the workflow
    const workflow = await wfManager.createWorkflow({
        name: 'Change Approval Flow',
        description: 'Routes change requests through approval'
    });

    // Step 2: Create a version
    const version = await wfManager.createWorkflowVersion({
        name: 'Change Approval Flow v1',
        workflowSysId: workflow.workflowSysId,
        table: 'change_request',
        active: true
    });

    // Step 3: Create activities
    const begin = await wfManager.createActivity({
        name: 'Begin',
        workflowVersionSysId: version.versionSysId,
        x: 100, y: 50
    });

    const approve = await wfManager.createActivity({
        name: 'Manager Approval',
        workflowVersionSysId: version.versionSysId,
        x: 100, y: 200
    });

    const end = await wfManager.createActivity({
        name: 'End',
        workflowVersionSysId: version.versionSysId,
        x: 100, y: 350
    });

    // Step 4: Create transitions
    await wfManager.createTransition({
        fromActivitySysId: begin.activitySysId,
        toActivitySysId: approve.activitySysId
    });

    await wfManager.createTransition({
        fromActivitySysId: approve.activitySysId,
        toActivitySysId: end.activitySysId
    });

    // Step 5: Publish
    await wfManager.publishWorkflow({
        versionSysId: version.versionSysId,
        startActivitySysId: begin.activitySysId
    });

    console.log('Workflow published successfully');
}
```

### Example 2: Create a Complete Workflow in One Call

```typescript
async function createIncidentEscalation() {
    const wfManager = new WorkflowManager(instance);

    const result = await wfManager.createCompleteWorkflow({
        name: 'P1 Incident Escalation',
        table: 'incident',
        description: 'Automatically escalates P1 incidents',
        condition: 'priority=1',
        activities: [
            { id: 'start', name: 'Begin', x: 100, y: 50 },
            { id: 'assign', name: 'Assign to On-Call', x: 100, y: 150,
              script: 'current.assigned_to = getOnCallUser(); current.update();' },
            { id: 'notify', name: 'Send Page', x: 100, y: 250 },
            { id: 'end', name: 'End', x: 100, y: 350 }
        ],
        transitions: [
            { from: 'start', to: 'assign' },
            { from: 'assign', to: 'notify' },
            { from: 'notify', to: 'end' }
        ],
        publish: true,
        startActivity: 'start'
    });

    console.log(`Workflow sys_id: ${result.workflowSysId}`);
    console.log(`Version sys_id: ${result.versionSysId}`);
    console.log(`Activities created: ${Object.keys(result.activitySysIds).length}`);
    console.log(`Transitions created: ${result.transitionSysIds.length}`);
    console.log(`Published: ${result.published}`);
}
```

### Example 3: Workflow with Branching Conditions

```typescript
async function createBranchingWorkflow() {
    const wfManager = new WorkflowManager(instance);

    // Create workflow and version
    const workflow = await wfManager.createWorkflow({ name: 'Triage Router' });
    const version = await wfManager.createWorkflowVersion({
        name: 'Triage Router v1',
        workflowSysId: workflow.workflowSysId,
        table: 'incident'
    });

    // Create activities
    const check = await wfManager.createActivity({
        name: 'Check Category',
        workflowVersionSysId: version.versionSysId
    });

    const hwRoute = await wfManager.createActivity({
        name: 'Route to Hardware',
        workflowVersionSysId: version.versionSysId
    });

    const swRoute = await wfManager.createActivity({
        name: 'Route to Software',
        workflowVersionSysId: version.versionSysId
    });

    // Create conditions on the check activity
    const hwCondition = await wfManager.createCondition({
        activitySysId: check.activitySysId,
        name: 'Is Hardware',
        condition: 'current.category == "hardware"',
        order: 100
    });

    const elseCondition = await wfManager.createCondition({
        activitySysId: check.activitySysId,
        name: 'Otherwise',
        elseFlag: true,
        order: 200
    });

    // Create conditional transitions
    await wfManager.createTransition({
        fromActivitySysId: check.activitySysId,
        toActivitySysId: hwRoute.activitySysId,
        conditionSysId: hwCondition.conditionSysId
    });

    await wfManager.createTransition({
        fromActivitySysId: check.activitySysId,
        toActivitySysId: swRoute.activitySysId,
        conditionSysId: elseCondition.conditionSysId
    });

    console.log('Branching workflow created');
}
```

## Best Practices

1. **Edit through a checkout**: `checkout` → edit → `publish` mirrors the editor and keeps the published version intact until you publish
2. **Discover variables first**: `getActivityDefinition(type)` lists every variable a type accepts, with choices and defaults
3. **Mind the update set**: `publish` records the whole workflow in the current update set — select the right one first
4. **Use `createCompleteWorkflow` for New Workflows** (record methods): The orchestration method handles all steps and provides a cleaner API than building step by step
5. **Assign Activity IDs**: Always set the `id` field on `ActivitySpec` entries for readable transition references instead of relying on array indices
6. **Validate Before Publishing**: `validateWorkflow` runs the editor's checks without publishing
7. **Track Progress**: Pass an `onProgress` callback to `createCompleteWorkflow` for visibility into long-running orchestrations
8. **Handle Errors Gracefully**: All methods throw on failure; wrap calls in try/catch to handle partial creation scenarios
9. **Use Conditions for Branching**: Pair `createCondition` with conditional transitions rather than embedding logic in activity scripts

## Related

- [Legacy Workflow Internals](./LegacyWorkflowInternals.md)
- [FormRecordWriter](./FormRecordWriter.md)
- [Getting Started Guide](./GettingStarted.md)
- [ATF Test Executor](./ATFTestExecutor.md)
- [Application Manager](./ApplicationManager.md)
- [API Reference](./APIReference.md)
- [Examples](./Examples.md)
