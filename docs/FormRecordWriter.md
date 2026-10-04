# FormRecordWriter

`FormRecordWriter` writes a record through its classic UI form (`/<table>.do`) exactly as a
browser does: load the form, then submit it with the form's tokens.

> **When to use it.** This is a low-level tool for writing *directly* to an instance when the
> record is **not** authored in a now-sdk application. Records that belong in an app — ATF
> tests, flows, script includes — should be authored there. `WorkflowManager` uses this
> class to write legacy workflow activities.

## Why a form post?

Some records keep part of their configuration in **variables**: a `glide_var` column
(`wf_activity.vars`, `sys_atf_step.inputs`, `sys_pd_activity.type_vals`, …) whose values
live in `sys_variable_value` rows. Writing those rows directly over REST runs into ACLs. The
form submit is the path the platform itself uses, and it writes them — with the record's
business rules seeing the variables at insert (a Switch activity's exits, for example, are
generated from its variables):

```
wf_activity.vars.var__m_3961a1da0a0a0b5c00ecd84822f70d85.timer_type = script
└─table─┘ └var┘ └──────────── variable model ────────────┘ └element┘
          column
```

The **variable model** (`var__m_<id>`, a `var_dictionary` table name) is chosen by the record
itself (for an activity, its activity definition), which is why a new record's form must be
loaded first:

- Values set at load time through `sysparm_query` (e.g. `activity_definition=…`) travel in the
  signed `sysparm_encoded_record`, not as form inputs.
- A submit without that encoded record still inserts the record, but **silently drops every
  variable** (verified against a live instance).

## Usage

```typescript
import { FormRecordWriter } from '@sonisoft/now-sdk-ext-core';

const forms = new FormRecordWriter(instance);

// Insert: the initial query picks the variable model, just as the UI's "new" link does
const { sysId } = await forms.insert('wf_activity', {
    view: 'diagrammer',
    initialQuery: `workflow_version=${versionSysId}^activity_definition=${timerDefinitionSysId}`,
    fields: { name: 'Wait a minute', x: 200, y: 80 },
    variables: { timer_type: 'script', script: 'answer = 60;' },
});

// Update: only what you pass is posted; everything else keeps its value
await forms.update('wf_activity', sysId, { view: 'diagrammer', variables: { script: 'answer = 120;' } });

// Inspect a form before writing: field and variable names, types, choices, current values
const snapshot = await forms.loadForm('wf_activity', sysId, { view: 'diagrammer' });
console.log(Object.keys(snapshot.variables));            // ['vars.run_during_upgrade', 'vars.timer_type', …]
console.log(snapshot.variables['vars.timer_type'].choices);  // [{ value: '', label: 'A user specified duration' }, …]
```

## API

| Method | Description |
|---|---|
| `loadForm(table, sysId = '-1', { view?, initialQuery? })` | Load and parse a form. Returns a `FormSnapshot`: tokens, action ids, every field and variable control with its form value, type (when the form declares one), mandatory flag and choices. |
| `insert(table, options)` | Load the new-record form, submit `sysverb_insert`, then confirm the record exists. |
| `update(table, sysId, options)` | Load the record's form and submit `sysverb_update`. |
| `submit(snapshot, action, options)` | Submit a form you already loaded. |

`FormWriteOptions`:

| Option | Description |
|---|---|
| `fields` | Column values by column name (no dot-walking) |
| `variables` | Variable values by element name. Unknown elements are rejected with the list of valid ones. |
| `variableField` | The glide_var column, when a form shows more than one (e.g. ATF `inputs` and `outputs`) |
| `view` | Form view (`sysparm_view`). Variables only appear on views that show them. |
| `initialQuery` | Insert only: `sysparm_query` applied at load |

## Values

| Input | Posted as |
|---|---|
| `true` / `false` | `true` / `false` (stored as `1` / `0` for boolean variables) |
| `['a', 'b']` | `a,b` (glide_list) |
| `null` | empty |
| Duration (`glide_duration` field): `90`, `'90'`, `{ minutes: 1, seconds: 30 }`, `'1970-01-01 00:01:30'` | `0 00:01:30` — the form only understands `D HH:MM:SS` |
| Choice field: a value or a label | the value; anything else is rejected with the allowed values |
| Anything else | its string form, verbatim (dates must be in the user's display format) |

Choice validation uses the options the form rendered. Dependent choice lists are filtered by
the current value of the field they depend on, so change the parent field first if needed.

## Errors

| Error | When |
|---|---|
| `FormSubmitError` | The submit was not accepted. `messages` holds the instance's error messages (e.g. "Invalid insert", a data policy or ACL message). |
| `InvalidParameterException` | Unknown variable, invalid choice, bad table/field name or sys_id |
| `Error` | The page was not the expected form (login page, missing record) |

## How it works

1. `GET /<table>.do?sys_id=<id|-1>&sysparm_view=…&sysparm_query=…` (read-only under the request policy).
2. Parse the page with `htmlparser2`: `sys_uniqueValue` (pre-assigned for new records),
   `sysparm_encoded_record`, `sys_modCount`, the `gsft_id` of the `sysverb_insert` /
   `sysverb_update` buttons, and every `<table>.*` control. Display mirrors (`sys_display.*`,
   `sys_select.*`, `sys_original.*`) are ignored — posting a `sys_select` value is how the UI
   ends up storing a reference it merely displayed.
3. `POST /<table>.do` with the tokens, `sysparm_ck` (the session token), your values only, and
   `sysparm_goto_url=modal_dialog_form_response.do?…`, a small page that echoes back the
   action and sys_id — that echo is how success is recognised.
4. For inserts, confirm the record through the Table API.

All three requests share one session (`SessionManager`), since a submit's token must belong
to the session that loaded the form.
