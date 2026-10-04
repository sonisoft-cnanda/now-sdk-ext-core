# Legacy Workflow → Flow Designer

Tools for understanding an existing legacy workflow and moving it to Flow Designer:
structural views an agent or a person can reason on, a conversion **plan**, and a
**Fluent (now-sdk) skeleton** that builds as is and marks every step that needs design work.

None of this writes to the instance. Everything after the export is a pure function of the
exported JSON, so it runs equally on a live workflow or a saved `nex workflow export` file.

```
WorkflowManager.exportWorkflow / nex workflow export      → WorkflowExport (JSON)
WorkflowStructure + buildOutline                           → block tree: decisions, parallel lines, loops, gotos
renderWorkflowOutline / Analysis / Nodes / Mermaid         → views
planFlowConversion  (+ renderFlowPlan)                     → FlowConversionPlan (JSON, or text)
generateFluentFlow                                         → src/fluent/flows/<name>.now.ts
WorkflowManager.convertToFlow                              → export + plan + skeleton in one read-only call
```

## Table of Contents

- [Usage](#usage)
- [Views](#views)
- [The plan](#the-plan)
- [What maps to what](#what-maps-to-what)
- [Open decisions](#open-decisions)
- [The Fluent skeleton](#the-fluent-skeleton)
- [Runtime semantics the mapping relies on](#runtime-semantics-the-mapping-relies-on)
- [Limits](#limits)

## Usage

```typescript
import {
    WorkflowManager, planFlowConversion, renderFlowPlan, generateFluentFlow, renderWorkflowOutline,
} from '@sonisoft/now-sdk-ext-core';

const wm = new WorkflowManager(instance);

// one call: export the published version, plan, generate
const { export: data, plan, files } = await wm.convertToFlow('Laptop Request', { version: 'published' });
console.log(renderFlowPlan(plan));          // readable plan
// files[0] = { path: 'src/fluent/flows/laptop-request.now.ts', content: '...' }

// or step by step, from a saved export
const saved = JSON.parse(readFileSync('laptop-request.json', 'utf8'));
console.log(renderWorkflowOutline(saved, { flowHints: true }));
const [file] = generateFluentFlow(planFlowConversion(saved), { directory: 'src/fluent/converted' });
```

With the `nex` CLI:

```bash
nex workflow export "Laptop Request" -a <alias> -o laptop.json      # read-only
nex workflow outline --file laptop.json [--analysis|--nodes|--mermaid] [--flow-hints]
nex workflow convert --file laptop.json --plan laptop.plan.json --fluent ./my-app
```

## Views

| Function | Shows |
|---|---|
| `renderWorkflowOutline(data, { allValues?, fullScripts?, flowHints? })` | The workflow as nested, numbered steps in reading order: decisions with an indented block per exit (short exits laid out as guard clauses so the main path reads straight down), parallel lines closed at their Join, loops (`↻`), waits (`[WAIT]`), gotos to steps shown elsewhere, merges without a Join, dead exits and unreachable activities. Settings show only what differs from the type's defaults. |
| `renderWorkflowNodes(data, opts)` | Every activity with its settings, where it is reached from and where each exit leads. |
| `analyzeWorkflow(data)` / `renderWorkflowAnalysis(data)` | Paths, waits, decisions, parallel splits and where they rejoin, loops (and the Turnstile capping them), dead exits, unreachable steps, scratchpad values (who sets, who reads), catalog variables read, scripts, template fields, subflows, Activity Designer activities. `analyzeWorkflow` returns it as data, activity references as sys_ids. |
| `renderWorkflowMermaid(data)` | A Mermaid flowchart: decisions as diamonds, waits marked, loops dashed, dead exits drawn. |
| `WorkflowStructure` / `buildOutline` | The model under all of it: back edges by depth-first search from Begin, immediate post-dominators for where paths rejoin (parallel splits rejoin at the Join they all reach), and the block tree. |

## The plan

`planFlowConversion(data)` returns a `FlowConversionPlan` (`format: now-sdk-ext/flow-conversion-plan@1`):

| Field | |
|---|---|
| `kind` | `flow`, or `subflow` when another workflow calls this one, it has inputs, or nothing starts it by condition |
| `trigger` | `serviceCatalog` for `sc_req_item` workflows (record: `params.trigger.request_item`), `record` (created) with the start condition for table workflows (`params.trigger.current`), or the subflow's inputs (`params.inputs.record`; none for `global` workflows) |
| `flowVariables` | `workflow.scratchpad` values set by one step and read by another, typed from their literal assignments |
| `steps` | The flow body: `action`, `waitForADuration`, `setFlowVariables`, `if` (branches + `otherwise`), `parallel` (lanes), `endFlow`, `todo` — each with its `source` (legacy activity, type and outline step number), a `confidence` (`direct`, `partial`, `manual`) and notes |
| `openDecisions` | What needs a person, by topic |
| `coverage` | Activities carried over directly, partly, or to design by hand |

Every setting a mapping did not use is listed on its step ("Not carried over: …"), so nothing
is dropped silently. Values are data pills (`{ kind: 'pill', expr: 'params.trigger.request_item.requested_for.manager' }`),
text with pills, `TemplateValue` field maps or approval rules — the generator writes them as Fluent.

## What maps to what

| Legacy activity | Flow Designer | Notes |
|---|---|---|
| Begin, Branch, Join | structure | A Join's Complete / Incomplete exits become an `if` only when they lead different ways |
| End | `endFlow` | Only inside a branch; the end of the main path is the end of the flow |
| Approval - User / Group | Ask For Approval | Users and groups as sys_ids or `${field}` data pills; Anyone → `Any`, Everyone → `All`; outputs captured when the workflow branches on the result, exits become conditions on `approval_state`. Approver scripts, script-decided approvals, "wait for other responses" and approval conditions are flagged; due-date settings are noted for `wfa.approvalDueDate()` |
| If | if / else | Condition AND script, as the handler evaluates them: encoded queries on the record become data-pill conditions; scripts that only compare one scratchpad value or field with a literal are read as a condition (flagged to check); catalog-variable conditions and other scripts are left to write |
| Switch | if / else if | On a field: each exit `field=value`; on a catalog variable: left to write. An Else exit becomes `else`; exits comparing `current.<field>` with a literal are read |
| Set Values | Update Record | `TemplateValue` from the encoded values; `javascript:` and `${…}` values flagged |
| Catalog Task | Create Catalog Task | Field mode, Values mode (`task_set_values`) or template; priority; advanced script (only when "advanced" is on) and task variables noted. When the workflow branches on how the task closed: **Create Task on `sc_task`** (with `request_item` and `parent`) so the flow can branch on `Record.state` |
| Create Task | Create Task | `parent` = the record, as the handler sets it |
| Timer | Wait For a Duration | Explicit durations directly; relative, field and script timers flagged |
| Wait for condition | Wait For Condition | Script conditions flagged |
| Notification | Send Email | Recipients as sys_ids, addresses or pills; `${field}` in the subject as pills; `${…}` in the body flagged |
| Log Message | Log | `${field}` as pills |
| Create Event | Fire Event | Scripted parameters flagged |
| Run Script | custom action (TODO) | Scripts that only set `current.<field>` literals → Update Record; only `workflow.scratchpad.<key>` literals → Set Flow Variables |
| Workflow (subflow) | subflow call (TODO) | Convert the child workflow first |
| Return Value | Assign Subflow Outputs (TODO) | |
| Activity Designer / spoke activities | IntegrationHub action (TODO) | Inputs attached |
| Anything else (Turnstile, Rollback To, Lock, …) | TODO | Settings attached |

Loops (exits back to an earlier step) and gotos (a second path continuing at a step the flow
already has) are TODOs in place, plus one open decision per loop and per shared step.

## Open decisions

| Topic | Raised when |
|---|---|
| `script` | A Run Script to port; scratchpad values written or read only once |
| `task` | A task's advanced script sets values |
| `approval` | Approvers come from a script |
| `catalogVariable` | Steps read catalog variables (not data pills of the requested item — Get Catalog Variables or a script step) |
| `loop` | An exit loops back (rebuild as Do the following until; with a counter if a Turnstile capped it) |
| `goto` | A step is shared by several paths (repeat it, move it into a subflow, or restructure) |
| `mergeWithoutJoin` | A step reached by several parallel lines without a Join ran once per line |
| `deadExit` | An exit leads nowhere (the workflow stopped there) |
| `unreachable` | Activities nothing leads to (not carried over) |
| `subflow`, `spoke` | Subflow calls and Activity Designer activities |
| `stage` | The workflow drives a stage field (set it with Update Record, or declare flow stages) |
| `other` | Unplanned activity types; parallel blocks nested in parallel blocks |

## The Fluent skeleton

`generateFluentFlow(plan, { directory? })` writes one `.now.ts` file (default
`src/fluent/flows/<name>.now.ts`) for a now-sdk app:

- A header comment: source workflow and version, coverage, trigger notes, custom fields used,
  and every open decision.
- `Flow(...)` with `wfa.trigger(...)`, or `Subflow(...)` with a `ReferenceColumn` record input;
  flow variables as `StringColumn` / `BooleanColumn` / `IntegerColumn`.
- One statement per planned step with `annotation: 'Legacy step N: <name>'`; approvals and
  branchable tasks captured as `const` for the conditions that follow.
- `// TODO(convert): …` wherever design work remains, with the legacy script or settings in a
  block comment beneath; conditions that could not be derived are `''` with the legacy test
  in the TODO.

It builds as generated with `now-sdk build` (verified with @servicenow/sdk 4.13 on real
catalog, change and subflow workflows), with one caveat: data pills on **custom fields**
(`u_…`) are typed from the app's table dependencies — list the table in `now.config.json`
and run `now-sdk dependencies` (the header names the fields).

Constraints of Fluent the generator works within (SDK 4.13):

- `doInParallel` cannot be nested: a parallel split inside a parallel line is written line
  by line, flagged.
- `wfa.dataPill` needs a property access, so Create Catalog Task's `"Catalog Task"` output
  cannot be a pill; Create Task's `Record` output can (`task.Record.state`).
- A flow body may not declare unused parameters: `params` is left out when nothing uses it.
- `goBackTo` exists in the SDK's internals but is not exposed on `wfa.flowLogic`, so loops stay TODOs.

## Runtime semantics the mapping relies on

Read from the activity handlers on the instance, not assumed:

- **If**: `yes` when the condition (if set) matches **and** the script (only when "advanced"
  is on and non-empty) returns `true` or `'yes'`. A script left as the commented default
  returns nothing, so advanced-on with the default script always answers `no`.
- **Switch**: the result is `current.variables.<item_variable>` (type variable) or
  `current.<field>` (type field); exits compare it.
- **Create Task / Catalog Task**: `parent` = current; due date from the timer settings;
  values from Fields mode (assignment group, assigned to, short description, instructions),
  a template, or Values mode (`task_set_values` via `applyEncodedQuery`); priority if still
  empty; `request_item` / `change_request` / `problem` set for those task tables; then the
  advanced script with `task` in scope, only when "advanced" is on. The activity's result is
  the task's state when it closes.
- **Set Values**: `current.applyEncodedQuery(workflow.strEval(values))`.
- **Approval - User**: `wait_for` is `any`, `all`, `first` (first response) or `script`;
  `reject_handling` `reject` or `wait`.
- **Timer**: `timer_type` empty (a duration), `relative_duration`, `field` or `script`.

## Limits

- A plan is a starting point. Workflows with many shared steps (several paths converging on
  one rejection step, say) become flows with repeated TODOs: decide the structure first, then
  fill in.
- Catalog variables are not resolved to data pills.
- Stages are reported, not generated.
- Only out-of-box activity types are recognised (by name); custom types are planned as TODOs
  with their settings.

## Related

- [WorkflowManager](./WorkflowManager.md)
- [Legacy Workflow Internals](./LegacyWorkflowInternals.md)
- The servicenow-skills `legacy-workflow` and `workflow-migration` skills
