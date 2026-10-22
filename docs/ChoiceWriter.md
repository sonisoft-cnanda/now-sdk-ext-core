# Change a choice list, verified

`ChoiceWriter` adds, changes and removes a column's choices through the choice form
(`/sys_choice.do`), as the UI's New and Edit on a choice do, in a given application and update
set. It then checks the saved choice, the list's application file and the one capture that holds
the whole list.

```typescript
import { ChoiceWriter } from '@sonisoft/now-sdk-ext-core';

const choices = new ChoiceWriter(instance);

// Read the list (one language; 'en' by default), with the column's dictionary setting
const list = await choices.getChoices('x_acme_ticket', 'severity');
// list.column.choice: '1' dropdown with -- None --, '3' without, '2' suggestion, '0'/'' none
// list.choiceSet: the list's application file, absent when the table has no list of its own

// Add a choice, or change the one with that value: label, sequence (order), inactive, hint
const result = await choices.setChoice('x_acme_ticket', 'severity', {
    value: '4',
    label: 'Severity 4',                                    // required to add
    sequence: 4,                                            // optional
    // inactive: true,                                      // hide it from new selections, keep it for records
    scope: { scope: 'x_acme' },                             // the list's application
    updateSet: setId,                                       // In progress, same application
    // storeCustomization: { acknowledgeUpgradeSkip: true }, // only for an installed Store application
});
// result.action is 'insert' or 'update'; result.previous the row before an update; result.choices the list after

// Remove a choice; refused while records hold the value unless confirmInUse is set
await choices.removeChoice('x_acme_ticket', 'severity', { value: '4', scope: { scope: 'x_acme' }, updateSet: setId });
```

## What the platform does (seen on dev206299)

**A choice has no application; its list does.** `sys_choice` rows carry the table, column,
language, value, label, sequence, inactive flag and hint, and no `sys_scope`. The list's
application file is its `sys_choice_set`, one per table and column, which the platform creates
with the list's first choice, in the form's application.

**One capture holds the whole list.** Every change rewrites `sys_choice_<table>_<element>`
(type Choice list): the choice set and every choice of the list (seen with one language). It goes to the
update set posted with the form, which need not be the user's current set: a second set of the
same application, never made current, received its own capture of the list. Removing the list's
last choice keeps the choice set, and the capture then holds it with no choices.

**The form's Table field only offers the application's own tables** (and tables it may alter).
Loaded in another application, the field comes back empty, and posting it saves a choice with no
table, captured as `sys_choice__<element>` in Global. The writer refuses before posting when the
loaded form does not name the table, the column and the language.

**The Table API is not used.** It inserts in the session's current application and refuses
another application's table ("Invalid 'Table' selected on the Choice record"), so it would depend
on, or change, the user's current application. The form takes the application per request.

**Choices show on the form only for a choice column.** The column's dictionary Choice setting
(`column.choice`) decides that; a column added with type `choice` gets '1' (dropdown with
-- None --). Choices on a column set to none are kept and captured, but the form shows a plain
field.

## Before the save

Each of these is checked before anything is posted. A failure throws `MetadataScopeError` and
nothing is sent; a change to the user's preferences while the form loads is
`MetadataVerificationError` `session_changed` with `writeAttempted: false`.

- The table, column, language and update set are well formed, and the value, label, sequence,
  inactive flag and hint are ones the platform keeps as given (`invalid_input`, with
  `detail.field`). A value is 1 to 4000 characters, with no `^`, no `javascript:`, no control
  characters and no surrounding spaces; it fits the column's maximum length, and an integer column's value is an integer. A
  label is at most 100 characters, a hint 255.
- The table exists and is not one of the platform's schema tables (`table_not_supported`); the
  column is defined on it or on a table it extends (`column_not_found`).
- The scope resolves to one application; an installed Store application needs
  `storeCustomization.acknowledgeUpgradeSkip` (`store_scope`), and a list whose Store policy is
  read-only or protected is refused (`protected_record`).
- The list belongs to that application (`scope_mismatch`). A table with no list of its own takes
  the column's application, and a column defined on a table it extends is refused
  (`choice_list_inherited`, naming that table): the table shows that table's list, and a list of its
  own would replace it there. Change the defining table's list instead.
- To add, a label is given; to change, something differs (`choice_unchanged`); to remove, the value
  exists (`choice_not_found`). Two choices with the value in one language are refused
  (`choice_ambiguous`). Dependent lists (choices told apart by `dependent_value`) are therefore
  not a write target, and the writer never sets `dependent_value`.
- The update set is In progress in the same application (`invalid_input`, with its state and
  application).
- To remove, the records holding the value are counted (Stats API, the table and the tables
  extending it). Any count refuses the removal (`choice_in_use`, with `detail.records`) unless
  `confirmInUse` is set; those records keep the value. The count is taken again just before the
  post, so a record that took the value while the form loaded counts too. Inactivating keeps the label and hides the
  choice from new selections.
- The form loads for that table, column and language in that scope (`scope_not_applied`,
  `form_redirected`), offers each field the writer posts (`field_not_supported`), offers Update to
  change and Delete to remove (`not_permitted`), and its Delete is the platform's own
  (`delete_not_supported`).

## After the save

The form is submitted once (insert-and-stay, update or delete) and never replayed. A failure after
it throws `MetadataVerificationError` with `writeAttempted: true` and the choice's sys_id:

- An added or changed choice exists with the table, column, language, value and the posted fields
  (`write_not_applied`; `csrf_rejected` when the instance refused the form's token), and no other
  choice in the list has the value (`verification_unavailable`). A removed one is gone
  (`delete_not_applied`).
- The list has one choice set, in the application (`scope_not_applied`), named
  `sys_choice_<table>_<element>` (`not_captured`).
- Exactly one changed capture of that name, in the set and the application (`not_captured`,
  `captured_elsewhere`, `mixed_scope_capture`; two changed rows is `verification_unavailable`),
  `INSERT_OR_UPDATE` (`DELETE` only if no choice set is left). A commit replaces the target's
  list with the capture's, so the capture must be the list as it now is: every choice, in every
  language, with the value, label, sequence, inactive flag, hint, language and dependent value read
  back (`not_captured`; an unreadable capture is `verification_unavailable`). That holds this
  save's choice as saved, and no longer holds a removed one.
- The user's preferences are unchanged, apart from the current set becoming the posted one, which
  `preferencesUnchanged: false` and `currentUpdateSet` report (`session_changed`).

For a Store application, `capture.customization` reports `replaceOnUpgrade` and the baseline
version of the capture when they can be read (best effort).

Taking a change back is another change: set the old label or sequence, or remove an added choice.
A list changed in a set that never ships is better taken back by setting that set to Ignore and
removing the choices it added.
