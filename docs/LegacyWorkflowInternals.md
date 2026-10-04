# Legacy Workflow Internals

How ServiceNow's legacy workflows (the Workflow Editor, `wf_*` tables — not Flow Designer)
work underneath, as needed to read and change them programmatically. This is the reference
behind [`WorkflowManager`](./WorkflowManager.md)'s editor-parity methods and
[`FormRecordWriter`](./FormRecordWriter.md).

Sources: browser captures of the Workflow Editor creating, publishing, checking out and
editing workflows (including the editor's own client code, `WorkflowIncludes.jsx`); the
instance's tables, business rules and ACLs; the product documentation; and live experiments
against a development instance. Statements marked **verified** were confirmed by experiment.

## Mental model

```
wf_workflow ─────────────┐  (the workflow: name, table)
  └─ wf_workflow_version  ×N  (one is published; at most one is a checked-out draft)
       ├─ wf_activity        (node on the canvas; type = activity_definition)
       │    ├─ wf_condition  (an exit, e.g. Always / Approved / Rejected / Yes / No)
       │    └─ sys_variable_value  (the activity's configuration; document=wf_activity)
       ├─ wf_transition      (line: from activity, via condition, to activity)
       └─ wf_stage           (stages for stage-driven tables)
```

- Every edit happens on a **draft version**. Publishing makes the draft the published
  version and retires the old one.
- An activity's configuration (a Timer's duration, a script, an approver list) is **not** on
  the activity record: it is a set of **variables** stored in `sys_variable_value`.
- Lines are drawn from an exit: `wf_transition.condition` is the exit, and `from` is derived
  from it.

## Tables

| Table | Key fields |
|---|---|
| `wf_workflow` (extends sys_metadata) | `name`, `table`, `description`, `access`, `template`, `vars` (workflow inputs). Update name `wf_workflow_<sys_id>`. |
| `wf_workflow_version` | `workflow`, `name`, `table`, `start`→wf_activity (Begin), `published`, `active`, `checked_out`, `checked_out_by`, `condition`, `condition_type` (`run_match`, `''`, …), `order`, `run_multiple`, `after_business_rules`, `stage_field`, `stage_order`, `column_renderer`, `expected_time`, `on_cancel`; computed at publish: `full_sequences`, `expected_sequences`, `activity_stages` |
| `wf_activity` | `workflow_version`, `activity_definition`→**wf_element_definition**, `name`, `x`, `y`, `width`, `height`, `stage`, `parent`, `is_parent`, `timeout`, `vars` (glide_var), `input` (Activity Designer JSON), `databus_lookup_id` |
| `wf_condition` | `activity`, `name`, `condition` (JavaScript, e.g. `activity.result == 'approved'`), `order`, `else_flag`, `error`, `event`, `event_name`, `skip_during_generate`, `is_positive`, `condition_default` |
| `wf_transition` | `from`, `to`, `condition` — no position or order fields |
| `wf_stage` | `workflow_version`, `name`, `value`, `order` |
| `wf_element_definition` | Activity types. Subclasses: `wf_activity_definition` (core: Begin, Timer, Run Script, Approval…) and `wf_element_activity` (Activity Designer / Orchestration / spokes). `name`, `category` (string), `attributes` (e.g. `begin=true`, `end=true`, `generate=approval`). Names are **not** unique. |
| `wf_condition_default` | The exits a new activity of a type starts with: `activity_definition`, `name`, `condition`, `order`, `else_flag`, `error`, `skip_during_generate` |
| `wf_activity_variable` (extends var_dictionary) | Variable definitions: `name` = model `var__m_<activity definition sys_id>`, `element`, `column_label`, `internal_type`, `default_value`, `reference`, `choice`, `order`, `mandatory` |
| `sys_variable_value` | `document` (`wf_activity`), `document_key` (activity sys_id), `variable`→var_dictionary, `value`, `order` |
| `sys_choice` | Variable choices: `name` = the model, `element`, `value`, `label`, `language`. `NULL_OVERRIDE` means "none" and is stored as `''`. |
| `v_wf_validation_report` | Results of the editor's validation: `workflow_version`, `type`, `level` (Info/Warn/Critical), `message`, `details` |
| Runtime | `wf_context`, `wf_executing`, `wf_history`, `wf_transition_history` |

## Activity types

Activity types are records (`wf_element_definition`), and instances customize them: extra
variables, changed defaults and exits, whole custom types. **Read them from the instance you are
working on** rather than relying on a fixed list:

| What | Where it lives | Read it with |
|---|---|---|
| What the type does, the results it produces, caveats | `wf_element_definition.description` | `getActivityDefinition(type)` / `nex workflow definitions <type>` |
| Engine hints (`begin=true`, `end=true`, `generate=approval`, `container=…`) | `attributes` | same |
| Variables (core types): element, internal type, label, hint, default, reference, choices | `var_dictionary` rows named `var__m_<definition sys_id>`, choices in `sys_choice` | same |
| Inputs and outputs (Activity Designer types) | `wf_element_activity.input_meta` / `output_meta` (JSON) | same |
| Starting exits | `wf_condition_default` | same |
| Implementation: which variables are read, which `activity.result` values drive the exits | `wf_activity_definition.script` (handler class extending `WFActivityHandler`); `wf_element_activity.output_process_script` | `getActivityDefinition(type, { includeScript: true })` / `--script` |
| How the instance actually configures it | `sys_variable_value` (core) or `wf_activity.input` (Designer) of activities in published versions | `getActivityUsage(type)` / `--usage` |

Out-of-box examples, for orientation only: Begin (`c7a5e32c0a0a0b3a002377c24ed8ea76`, exit
Always) and End (`c7a66f7d0a0a0b3a004544a6d2f14076`, no exits) are created by the "Workflow
initialize" rule; Approval - User starts with Approved / Rejected / Skipped; If with Yes / No;
Join with Complete / Incomplete; a Switch's exits are generated from its variables.

Activity Designer activities (`wf_element_activity`) have no variables: their configuration
is the `wf_activity.input` JSON keyed by the input names in `input_meta`, usually `${…}`
expressions (`${current.variables.user}`, `${workflow.scratchpad.dc}`).

The engine's runtime behaviour — joins, ends, waits, approvals that skip when no approver
resolves, Set Values timing, error exits — is summarized in the `legacy-workflow` skill's
`reference/runtime-semantics.md` (servicenow-skills).

## Variable storage and encodings

- One `sys_variable_value` row per non-layout variable of the model (elements starting with
  `.` are layout only). Older activities can lack rows for variables added in later releases;
  a missing row behaves as the default.
- Stored encodings: booleans `1`/`0`; durations `1970-01-01 HH:MM:SS` (day *n* is
  `1970-01-(n+1)`); glide_list comma-separated sys_ids; choices their value (`''` for
  NULL_OVERRIDE); templates `field=value^…^EQ`; conditions encoded queries.
- **Reading**: query `sys_variable_value` with `document=wf_activity^document_keyIN<ids>` and
  dot-walk `variable.element`. The Table API also returns `vars.<element>` dot-walks on
  `wf_activity`, but not `vars` itself.
- **Writing**: post the `wf_activity` form with `wf_activity.vars.var__m_<definition>.<element>`
  fields (see below). Direct REST writes to `sys_variable_value` run into ACLs.
- Form-post encodings (**verified**): durations must be posted as `D HH:MM:SS` (the stored
  format, plain seconds and the `ni.…dur_*` pieces are ignored or misread); booleans as
  `true`/`false` in the main field (the `ni.` field alone is ignored); lists comma-separated.

## Business rules that do the work

These fire for Table API and form writes alike.

| Table | Rule | Effect |
|---|---|---|
| wf_workflow_version | **Workflow initialize** (before insert, when `workflow` is empty) | Creates the wf_workflow, Begin (20,20) and End (400,150), Begin's "Always" exit, the Begin → End transition, and sets `start`. This is how a new workflow is created. |
| wf_workflow_version | Unpublish other workflow versions (after, `published` true) | Sets `published=false` on every other version of the workflow |
| wf_workflow_version | Unload Workflow Version (after update, published false→true) | `gs.updateSave(current)`: records the whole workflow in the current update set and unloads the cached model |
| wf_workflow_version | Delete Activity Variables / Delete parent workflow | Cleanup on delete; deleting the last version deletes the workflow |
| wf_activity | Set info from activity definition (before insert) | Width/height defaults, `is_parent` for containers |
| wf_activity | WFApplyDatabusID (before insert) | `databus_lookup_id` = max + 1 |
| wf_activity | **Create default conditions** (after insert) | Copies `wf_condition_default` rows to exits, or creates "Always" |
| wf_activity | Create Switch conditions (after insert) | One exit per choice — needs the variables present **at insert**, which the form post provides (**verified**: `type=field`, `field=state` on incident produced 12 exits) |
| wf_condition | Mark Positive Paths | `is_positive` for Approved/Yes/Always/… |
| wf_transition | Set from field | `from = condition.activity` |
| wf_activity, wf_condition, wf_transition | Update workflow version | Bumps the version's `sys_mod_count` |

## ACLs

- Create/write/delete on wf_* require `WorkflowAccess.userHasWorkflowAccess()` — `admin`,
  `workflow_admin`, or `snc_required_script_writer_permission`.
- **wf_condition writes require the version to be checked out** (no admin override). A Table
  API insert into wf_condition on a checked-out draft works (**verified**).
- Only the user in `checked_out_by` may change it.

## Versions, checkout and publish

| State | published | checked_out / checked_out_by |
|---|---|---|
| New (just created) | false | set to the creator |
| Published | true | empty |
| Draft (checked out) | false | set |
| Superseded | false | empty |

`active` means "the workflow is enabled", not "the current version".

- **Checkout** creates a new version: a deep copy of activities, exits, transitions,
  variables and stages (with new sys_ids), checked out to the user. The published version
  stays published until the draft is published. Only one user can hold a checkout.
- **Which version runs**: the published one — except for the user holding a checkout, whose
  own records run the draft. Running contexts keep their version.
- **Publish** validates, sets the draft published, clears its checkout, computes
  `full_sequences` / `activity_stages`, and the rules above retire the previous version and
  write the update set record.
- **Update sets**: individual edits are never captured. Each publish writes one
  `sys_update_xml` named `wf_workflow_<wf sys_id>` (type "Workflow") holding the whole version
  — version, workflow, activities with their variables, exits, transitions — and an
  `update_multiple` that unpublishes other versions on commit. Committing update sets out of
  order can roll a workflow back.
- **Discarding a draft** = deleting that version through the processor (**verified**: only
  the draft and its records go; the published version is untouched).

## The Workflow Editor's endpoints

### Diagram processor

Everything structural goes through one processor, with the session's `X-UserToken` header:

```
POST /xmlhttp.do
  sysparm_processor=com.glideapp.workflow.ui.WorkflowDiagramProcessor
  sysparm_scope=global
  sysparm_type=<command>
  …parameters
```

| `sysparm_type` | Parameters | Effect |
|---|---|---|
| `get` | `id` = version | The version as GraphML (below), with permissions |
| `getnode` | `id` = activity | One node and its ports |
| `checkout` | `sys_id` = published version, `name` | Creates the draft; returns its GraphML (`graph id` = new version) |
| `forcecheckout` | `sys_id` | Takes over another user's checkout |
| `publish` / `publish_novalidate` | `sys_id` = draft | Publishes. `publish` returns `<validation_warning>` or `<validation_critical>` instead when validation finds problems; the editor then offers `publish_novalidate` for warnings. |
| `movenodes` | `id` = version, `xml` = nodes with x/y | Reposition |
| `newedge` / `changeedge` / `deleteedge` | `xml` = one edge | Add / re-point / remove a transition. The edge id becomes the wf_transition sys_id (any 32-hex id; the editor gets one from `GlideSystemAjax.newGuid`). |
| `newedgecontrolnode` | `xml` = node, `changed_edges`, `new_edges` | "Drop onto a line": re-point the existing edge at the node and add one from the node's first exit to the old target |
| `deletenode` | `xml` = node, `delete_edges`, `changed_edges`, `new_edges` | Deletes the activity with its exits and variables (**verified**) and applies the edge changes |
| `delete` | `sys_id` = version | Deletes a version (the workflow goes with its last one) |
| `copy` | `sys_id`, `name` | Copies the workflow |
| `activate` / `inactivate` | `sys_id` | Set Active / Set Inactive |
| `updatestages` | `id` = version | Recomputes stage assignments (the editor calls it after every activity save) |
| `newport` / `changeport` / `deleteport`, `copynode`, `updatenode`, `pinnode`, `get_sys_mod_count` | | Port edits, copying an activity, refreshing an outdated one, pinning, change detection |

Errors come back inside the response: `<validation_critical>`, `<validation_warning>`,
`<duplicate_name>`, `<different_domain>`.

### GraphML

```xml
<graphml><graph id="<version sys_id>">
  <data key="published">true</data> <data key="can_checkout">true</data> …
  <data key="activity_<definition sys_id>">Timer</data> …        <!-- the palette -->
  <node id="<activity sys_id>">
    <data key="name">Timer</data>            <!-- the TYPE name -->
    <data key="description">Wait 1 day</data> <!-- the activity's own name -->
    <data key="x">190</data><data key="y">60</data>
    <data key="activity_definition">3961a1da…</data> …
  </node>
  <port id="<wf_condition sys_id>" node="<activity sys_id>">
    <data key="name">Always</data><data key="order">0</data> …
  </port>
  <edge id="<wf_transition sys_id>" source="<activity>" source_port="<condition>" target="<activity>"/>
</graph></graphml>
```

For writes the editor sends its whole copy of the graph data. The processor needs only the
graph id and the elements being changed (**verified**):
`<graphml><graph id="…"><node id="…"><data key="x">190</data><data key="y">60</data></node></graph></graphml>`.

Useful graph properties: `can_checkout`, `can_force_checkout`, `can_publish`, `can_delete`,
`read_only` (false only on your own draft), `status_display` ("Published", "Checked out by
me"), `published`, `workflow`, `full_sequences`.

### Creating a workflow

The editor's "New Workflow" dialog is the `wf_workflow_version` form in view `new_workflow`,
submitted with `name`, `table`, `condition_type=run_match`, `stage_order=computed` and
`column_renderer`; the "Workflow initialize" rule builds the rest. A Table API insert of a
version without `workflow` does the same (**verified**).

### Adding or editing an activity: the form post

The activity dialog is the classic `wf_activity` form, view `diagrammer`:

1. **Load**: `/wf_activity.do?sys_id=-1&sysparm_query=workflow_version=<v>^activity_definition=<def>&sysparm_view=diagrammer`
   (GET works the same as the editor's POST — **verified**). The page (~1.4 MB) carries a
   pre-assigned `sys_uniqueValue`, the signed `sysparm_encoded_record`, `sysparm_ck`, and the
   `sysverb_insert` button's `gsft_id`.
2. **Submit**: `POST /wf_activity.do` with `sys_target`, `sys_uniqueValue`, `sys_action`
   (the gsft_id, or simply `sysverb_insert` — **verified**), `sysparm_ck`,
   `sysparm_encoded_record`, `wf_activity.name`, `wf_activity.input`, and
   `wf_activity.vars.var__m_<def>.<element>` for each variable.
3. Success redirects to `sysparm_goto_url` (the editor uses `modal_dialog_form_response.do`,
   which echoes the action and new sys_id).

**Verified** behaviour:

- `workflow_version` and `activity_definition` are not form inputs — they travel only in the
  encoded record. A submit without the load step creates the activity under a new sys_id
  but with **no variables at all**.
- Posting only the variables you change is enough: on insert the instance fills in every
  other variable's default (16/16 Timer rows); on update the others keep their values.
- `wf_activity.x` / `wf_activity.y` (and `input`) can be posted with the insert; the editor
  instead positions the node afterwards with `newedgecontrolnode` / `movenodes`.
- Updates use the record's form (`sys_id=<activity>`) and `sysverb_update`.

### Validation without publishing

`GET /validate_workflow.do?sysparm_sys_id=<version>` renders the editor's report and refreshes
`v_wf_validation_report`, which the Table API can then read (a Table API read alone returns the
previous run's rows — **verified**). Checks include ValidateTransitionIn/Out (exits without
lines, activities without inputs), ValidateSingleEnd, ValidateDanglingTransition,
ValidateSubflows, and stage checks; `details` names the offending activity.

## Gotchas

- Names are not unique: activity types (three "Add User to Group"), activities within a
  version, even workflows. Prefer sys_ids; `WorkflowManager` resolves names only when they are
  unambiguous.
- After a checkout every activity, exit and transition has a **new sys_id**. Re-read the
  draft (`getWorkflowDefinition`) before editing; never reuse the published version's ids.
- A condition can feed several transitions (parallel paths), and an exit with no transition is
  a validation warning, not an error.
- Approval activities show as disabled in the editor's palette for tables with approval
  engines enabled (e.g. incident). They are meant for tables where the approval engine is
  turned off; check that before adding one programmatically.
- Variable defaults can be `javascript:` expressions evaluated by the form, which is one more
  reason to write through the form rather than replicate defaults.

## Exporting and reading a whole workflow

`WorkflowManager.exportWorkflow` / `nex workflow export <workflow>` produce one JSON document
(`format: now-sdk-ext/legacy-workflow@1`) with everything above resolved for one version. Whether
an activity type pauses the workflow (`waits`) is read from its handler script — it sets
`activity.state` or `executing.state` to `'waiting'`, itself or in the handler it extends
(Catalog Task inherits Create Task's) — not from a list. The `legacy-workflow` skill's
`workflow-graph.sh` turns the export into a nested outline (decisions, guard clauses, parallel
blocks closed at their Join, loops, waits), a flat node list, a structural analysis or Mermaid.

## Querying with nex

```bash
nex workflow list --name "Laptop" -a <alias>
nex workflow show "Laptop Request" -a <alias>                  # your draft if you have one, else published
nex workflow definitions Timer -a <alias>                      # variables, choices, defaults, exits
nex query -t sys_variable_value -q "document_key=<activity>^ORDERBYorder" -f variable.element,value -a <alias>
nex query -t sys_update_xml -q "name=wf_workflow_<wf sys_id>" -f update_set.name,sys_updated_on -a <alias>
```
