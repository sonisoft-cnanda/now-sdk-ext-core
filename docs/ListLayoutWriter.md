# Change a list layout, verified

`ListLayoutWriter` reads and replaces the columns of a table's list for one view through the
classic List Layout page (`/slushbucket.do?sysparm_form=list`), as the UI does. The platform
captures the list as one List Layout file, `sys_ui_list_<table>_<view>` (`null` for the Default
view), so a column change is not made by editing `sys_ui_list_element` rows.

```typescript
import { ListLayoutWriter } from '@sonisoft/now-sdk-ext-core';

const lists = new ListLayoutWriter(instance);
const before = await lists.getListLayout('cmn_cost_center');   // { table, view, exists, sysId, scope, updateName, columns }
const result = await lists.setListLayout('cmn_cost_center', {
    columns: [...before.columns, 'manager'],                    // the whole list, in order
    view: '',                                                   // '' or omitted: the Default view
    scope: 'global',                                            // the list's own application
    updateSet: setId,                                           // In progress, same application, and the working set
    storeCustomization: { acknowledgeUpgradeSkip: true },       // only for an installed Store application
});
// result.previousColumns puts it back; result.created says the table had no list of its own;
// result.sysId is the new sys_ui_list record (previousSysId the one it replaced)
```

Only a table's own list for a view is handled: not a related list (`parent` or `relationship`
set) and not a user's personalized list (`sys_user` set, never shipped). Lists are domain data:
only the global domain is handled. A list or a user in another domain is refused with
`domain_not_supported`, because the save would create a new list in the session's domain and
leave the one read unchanged. A view is given by its
`sys_ui_view` name. Columns are field names, dot-walked as `field.field`; each must be offered
by the page, so a dot-walked column not already on the list is refused (`field_not_supported`).

**A save replaces the record.** The page deletes the list's `sys_ui_list` row and inserts a new
one with a new sys_id (seen on dev206299, each save), keeping the update name. The writer
therefore finds the list by table and view, never by sys_id. Column aggregates (sum, average,
minimum, maximum) on columns that stay were kept across a save (seen).

**A table with no list of its own** shows its parent's. `getListLayout` reports
`exists: false`, and `setListLayout` creates the table's own list in the given application
(`created: true`, `previousColumns: []`). Undo that by deleting the new `sys_ui_list` row
(`result.sysId`), not by saving the old columns, which would keep a list of its own.

## Before the save

Each of these is checked before anything is posted. A failure throws `MetadataScopeError` and
nothing is sent:

- The table, view, columns and set are valid, with no duplicate columns (`invalid_input`); an
  unknown view is `invalid_input`. Every column is offered by the page (`field_not_supported`,
  with `detail.field`, dot-walked names included).
- The scope resolves to one application, and an existing list belongs to it (`scope_mismatch`).
  More than one matching list is `evidence_unavailable`.
- An installed Store application needs `storeCustomization.acknowledgeUpgradeSkip`
  (`store_scope`). A vendor-locked list (`sys_policy` read or protected) is refused with
  `protected_record`, in any application.
- The update set is In progress in the same application (`invalid_input`) and is the working
  set (`update_set_not_current`). Use `WorkingSetManager.useUpdateSet` first.
- The list and the user are in the global domain (`domain_not_supported`).
- The page loads in that scope, for that table, as a list and not a related list (no collection
  or relationship), with a Save
  button (`scope_not_applied`, `not_permitted`, `form_redirected`), and shows the columns read
  from the instance (`evidence_unavailable` otherwise, so a save cannot rewrite another list).

## After the save

The single POST is never replayed. The writer then checks the following, and a failure throws
`MetadataVerificationError` with `writeAttempted: true`:

- The table's list for the view exists, with the requested columns in order
  (`write_not_applied`), in the requested application and the global domain
  (`scope_not_applied`), and with the expected update name (`not_captured`). More than one list
  for the table and view after the save is `verification_unavailable`: `sysId` is the newest and
  `messages` names every row, so the extra one can be removed. The page does not render the view
  it is showing, so these checks are what confirm the save wrote the requested view.
- Exactly one capture of that name changed, `INSERT_OR_UPDATE`, in the expected set and
  application (`not_captured`, `captured_elsewhere`, `mixed_scope_capture`; more than one
  changed row is `verification_unavailable`).
- The user's preferences are unchanged (`session_changed`).

For a Store application, `capture.customization` reports `replaceOnUpgrade` and the baseline
version: upgrades skip a customized list.
