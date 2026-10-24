# Add a column, verified

`ColumnWriter` adds a column to a table through the dictionary form (`/sys_dictionary.do`), as
the UI's New column does, in a given application and update set. The platform then creates the
column, its label and, on some tables, a place for it on the form. The writer checks each of
those and every capture they made.

```typescript
import { ColumnWriter } from '@sonisoft/now-sdk-ext-core';

const columns = new ColumnWriter(instance);
const result = await columns.addColumn('x_acme_ticket', {
    column: 'triage_note',                                   // lower case; the platform's prefix is added when missing
    label: 'Triage note',
    type: 'string',                                          // a sys_glide_object name: string, integer, boolean, reference, ...
    maxLength: 100,                                          // optional
    // reference: 'sys_user',                                // required for type reference
    scope: { scope: 'x_acme' },                              // the application the column belongs to
    updateSet: setId,                                        // In progress, same application, and the working set
    // storeCustomization: { acknowledgeUpgradeSkip: true }, // only when the application is an installed Store application
});
// result.column is the name as saved; result.formSections the sections the platform placed it on;
// result.captures every capture verified in the set
```

## What the platform does (seen on dev206299)

**It names the column.** The writer applies the same rule before the save and checks the saved
row has the name it predicted:

| The application adding it | The table | Column name |
| --- | --- | --- |
| Global | any | `u_<name>` |
| An installed Store application | its own table (seen); other tables get the same rule, not yet seen | `u_<name>` |
| A scoped application | its own table | `<name>`, unchanged |
| A scoped application | another application's table | `<scope>_<name>` |

A name that already carries the prefix keeps it, so `u_cost_code` in Global stays `u_cost_code`.
The form's record keeps its sys_id, so if the platform ever saves a different name the writer
finds that record and fails with `write_not_applied`, naming the column it saved in `messages`.
The Store row was seen on the application's own table (GRC `sn_grc_indicator`).

Once on dev206299 a submit in a Store scope saved nothing and the form showed no message; the
writer reports that as `write_not_applied` with the form's sys_id and nothing to clean up. The
same add succeeded when repeated.

**It captures the column and its label** in the application's set: Dictionary
`sys_dictionary_<table>_<column>` and Field Label `sys_documentation_<table>_<column>_<language>`.

**It places the field on the form** when the column is added to a Global table in Global, or to an
application's own table (a Store application's included): the field is appended to the end of the Default view's main section,
captured as that section's Form Layout (`sys_ui_section_<sys_id>`). On a section with splits the
field lands after the last one, inside its second column (seen on GRC). A column added to another
application's table is placed nowhere (`formSections: []`). Moving the field is a form-layout
change ([FormLayoutWriter](./FormLayoutWriter.md)).

**Removing a column** is `removeColumn`, explicitly confirmed: see [Remove a column](#remove-a-column).

## Before the save

Each of these is checked before anything is posted. A failure throws `MetadataScopeError` and
nothing is sent. The exception is a change to the user's preferences while the form loads:
`MetadataVerificationError` `session_changed` with `writeAttempted: false`.

- The column, label, type, maximum length and reference are valid (`invalid_input`, with
  `detail.field` naming the option). The type is a `sys_glide_object`; `reference` is required for
  type `reference`, optional for `glide_list`, refused otherwise. The final name is at most 80
  characters.
- The table and the referenced table exist (`table_not_supported`). The platform's own schema
  tables, and tables extending one, are refused (`sys_metadata`, `sys_dictionary`, `sys_db_object`,
  `sys_documentation`, `sys_choice`, the update set and application tables, user preferences).
- The table and the tables it extends have no column of that name (`column_exists`, with the
  table that has it).
- The scope resolves to one application; an installed Store application needs
  `storeCustomization.acknowledgeUpgradeSkip` (`store_scope`).
- The update set is In progress in the same application (`invalid_input`) and is the user's set
  for it (`update_set_not_current`): the form placement is captured there, whatever the dictionary
  form is told. Use `WorkingSetManager.useUpdateSet` first.
- The dictionary form loads for that table in that scope (`scope_not_applied`, `form_redirected`)
  and offers each field the writer posts (`field_not_supported`).

## After the save

The form is submitted once, with insert-and-stay, and never replayed. A failure after it throws
`MetadataVerificationError` with `writeAttempted: true` and the dictionary record's sys_id:

- The submitted form's dictionary record exists (`write_not_applied`; `csrf_rejected` when the
  instance refused the form's token) and no other row has that table and column
  (`verification_unavailable`). It has the requested column name, type, length and reference
  (`write_not_applied`), in the application (`scope_not_applied`), named
  `sys_dictionary_<table>_<column>` (`not_captured`).
- A label with the requested text; every label row in the application and named for its language.
- Every field the platform placed is on one of the table's sections. A form element of that name
  left behind by an earlier, deleted column is not counted as this save's placement.
- Exactly one changed capture of each name (Dictionary, each Field Label, each placed section's Form
  Layout), `INSERT_OR_UPDATE`, in the set and the application (`not_captured`,
  `captured_elsewhere`, `mixed_scope_capture`; two changed rows of one name is
  `verification_unavailable`).
- The user's preferences are unchanged (`session_changed`).

For a Store application, `capture.customization` reports `replaceOnUpgrade` and the baseline
version of the Dictionary capture when they can be read (best effort: a failed read leaves the
field out rather than failing a verified add).

## Remove a column

`removeColumn` deletes a column through the dictionary form's **Delete Column** action
(`drop_table_element`), the platform's own path, and verifies what the platform did. It deletes
the column's data wherever its DELETE capture is committed, so it is gated:

```typescript
const removed = await columns.removeColumn('x_acme_ticket', 'triage_note', {
    confirm: { table: 'x_acme_ticket', column: 'triage_note' }, // must name both exactly
    // acknowledgeDataLoss: true,            // required when rows hold a value (removed.records)
    // acknowledgeDependentDeletes: true,    // required when the platform will delete client scripts / UI policy actions
    scope: { scope: 'x_acme' },             // the column's application
    updateSet: setId,                       // In progress, same application; need not be the working set
    // storeCustomization: { acknowledgeUpgradeSkip: true }, // a u_ column in an installed Store application
});
// removed.records: rows that held a value; removed.createdInThisSet; removed.deleted; removed.leftovers
```

### What the platform does (seen on dev206299)

- **It drops the column and its data**, deletes its labels (every language), and deletes the
  onChange and onCellEdit client scripts and the UI policy actions that name the column (its Field
  Deletion Cleanup rule). Each deletion is captured as a DELETE in the posted set and recorded in
  `sys_metadata_delete`. A capture already in that set turns into a DELETE in place; a column
  created in another set gets a new DELETE in the posted set, and the other set keeps its
  INSERT_OR_UPDATE. The posted set need not be the user's current set.
- **It leaves behind** the column's choices and choice set, its form elements and its list
  elements, pointing at a column that no longer exists. `leftovers` lists them; their captures
  are unchanged.
- **It offers Delete Column only for a deletable column** (`DictionaryUtils.isDeletable`): a `u_`
  column (in Global or an installed Store application), or a scoped application's own column
  loaded in that application. A vendor column (Global or Store without `u_`) has no Delete Column,
  and neither does an application's own column loaded in another application.

### Before the save

Each of these is checked before anything is posted (`MetadataScopeError`):

- The confirmation names the table and column exactly (`confirmation_required`); the column name
  and update set are well formed (`invalid_input`).
- The table is not one of the platform's schema tables (`table_not_supported`); the column is
  defined on the table itself (`column_not_found`; remove an inherited column from the table that
  defines it).
- The scope resolves to one application, with the Store opt-in when needed (`store_scope`); the
  column belongs to it (`scope_mismatch`); the platform deems it deletable (`column_not_deletable`).
- The update set is In progress in the same application (`invalid_input`).
- The rows holding a value are counted (Stats API, `<column>ISNOTEMPTY`, the table and the tables
  extending it). Any count refuses the removal (`column_has_data`, with `detail.records`) unless
  `acknowledgeDataLoss` is set.
- The client scripts and UI policy actions the platform would delete are read. Another
  application's refuse the removal (`column_referenced`, with `detail.table` the record's table,
  `sys_script_client` or `sys_ui_policy_action`); the column's own application's need
  `acknowledgeDependentDeletes` (`column_has_dependents`, with their count).
- The row count and the dependents are read again just before the post, so a value saved or a
  dependent created while the form loaded is gated too; dependents that changed in between refuse
  the removal (`column_has_dependents`).
- The form loads for that column in that scope (`scope_not_applied`), offers Delete Column
  (`column_not_deletable` when not), and that action is the platform's own: its table, name and
  server script are the ones seen on dev206299 (`delete_not_supported`).

### After the save

The action is posted once and never replayed. A failure after it throws
`MetadataVerificationError` with `writeAttempted: true`:

- The dictionary record, the labels and every dependent read before are gone
  (`delete_not_applied`; `csrf_rejected` when the instance refused the form's token).
- Exactly one changed capture of each (Dictionary, each Field Label, each deleted dependent), a
  DELETE in the set and the application (`not_captured`, `captured_elsewhere`,
  `mixed_scope_capture`, `delete_not_captured`; two changed rows is `verification_unavailable`).
- A `sys_metadata_delete` row for the dictionary record, in the application, created by this
  removal (`delete_not_captured`).
- The user's preferences are unchanged apart from the current set becoming the posted one
  (`session_changed`).

`createdInThisSet` is true when the column's only capture was the given set's and its version
history exists and comes only from that set (no history at all is not taken as evidence): the column was created in this set and the DELETE replaced its capture there.
That set never needs a DELETE for it. Move the DELETE captures to a set that never ships (and
Ignore it), or Ignore the set if it holds nothing else, rather than shipping a DELETE for a column
the target never had.

