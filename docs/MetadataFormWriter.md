# Write scoped application metadata through forms

`MetadataFormWriter` inserts, updates and deletes application files in an explicit scope.
It uses Studio forms and checks the record scope, update-set capture and user preferences.
The existing `FormRecordWriter` keeps its public behavior.

```typescript
import { MetadataFormWriter, MetadataVerificationError } from '@sonisoft/now-sdk-ext-core';

const writer = new MetadataFormWriter(instance);
const scope = { scope: 'x_example_app' };
const created = await writer.insert('sys_script_include', {
    scope,
    fields: { name: 'ExampleUtil', script: 'var ExampleUtil = Class.create();', active: false },
    // Optional: choose an In progress set that belongs to the target application.
    updateSet: '0123456789abcdef0123456789abcdef',
});
await writer.update(created.table, created.sysId, { scope, fields: { active: false } });
await writer.delete(created.table, created.sysId, {
    scope, confirm: { table: created.table, sysId: created.sysId },
});
```

Scope accepts `{ sysId: '...' }`, `{ scope: 'x_example_app' }`, or literal `'global'`.
There is no default scope.

An installed Store application's files can be changed only with an explicit acknowledgement:
`storeCustomization: { acknowledgeUpgradeSkip: true }` and an explicit `updateSet`. Without them
the writer refuses with `store_scope` or `update_set_required` before anything is sent. Changing
a Store file marks it as customized, and upgrades of that application then skip it. The result's
`capture.customization` reports `replaceOnUpgrade` and whether a vendor `baselineVersion` exists.
Files the vendor locked (`sys_policy` read or protected) are refused with `protected_record`.
The table must extend `sys_metadata` and must pass the table deny list.
Caller fields must exist on the form. Caller `sys_*` fields are refused.
An initial query accepts equality terms for ordinary fields. It cannot override system fields.

Pass `initialQuery`, `variables`, `variableField` and `view` as with `FormRecordWriter`.

Catalog variable references are checked by the writer, not by the form. These are
`catalog_script_client.cat_variable` and `catalog_ui_policy_action.catalog_variable`. The server
renders them with only "-- None --", and the page's script adds the variables. The value must be
`IO:<item_option_new sys_id>`, and the variable must belong to the record's catalog item or
variable set. A UI policy action names neither; it is resolved through its `ui_policy`, which you
pass as `initialQuery: 'ui_policy=<sys_id>'`, as the policy's related list does. The field is read
back after the save (`write_not_applied` if it was not kept). A value any form control refuses is
reported as `field_not_supported`, with `detail.field`.
For example, an ATF step can use `initialQuery` to select its test and step configuration.
The encoded form state carries those values. Unknown variables fail before the POST.

`capture.updateName` is the captured file's name: `<table>_<sys_id>`, or the platform's coalescing
name for labels (`sys_documentation_<table>_<element>_<language>`) and choices
(`sys_choice_<table>_<element>`). Capture verification looks for that name. An insert into those tables must
supply the name parts (`name`, `element`, and `language` for labels) in `fields`, so that the name is known
before the POST. Otherwise it is refused with `invalid_input` and `detail.field`.

The capture prediction comes from `updateSetForScope<scope sys_id>` in the authenticated user's preferences.
An explicit `updateSet` overrides this prediction. The writer checks the actual capture against that set.
`allowMixedScopeCapture: true` permits a capture whose application differs from the record's scope.
It does not disable the expected-set check.

A cross-scope write can move the session's current update set to the target application's set.
The writer reports this in `capture.currentUpdateSet`: `before`, `after` and `switched`.
An allowed switch makes `preferencesUnchanged` false. Any other preference change fails with `session_changed`.
Equal preference values with replaced row IDs pass and appear in `preferenceRowsReplaced`.
The result never includes the full preference snapshot.

The writer never selects an application or update set. It never repairs preferences or capture rows.
Make the set current, and restore the original afterwards, with `WorkingSetManager`
(`useUpdateSet` and `restoreWorkingSet`; see [WorkingSetManager](./WorkingSetManager.md)).
Coordinate that operation with other session users.
Avoid concurrent metadata writes and picker changes in one session.

Each POST runs once. A 401 or uncertain response is never replayed.
On `MetadataVerificationError`, use `table`, `sysId`, `writeAttempted`, `capture` and sanitized `messages` to inspect the result.
The record can exist even when verification fails. Read it before any cleanup or retry decision.
Capture and delete verification use the client's UTC start time and reject unchanged capture versions.
Keep the client clock synchronized with the instance. A client clock that runs ahead can reject a successful write as unverified.
A backward time margin is not applied because it could admit older evidence. Do not repeat a write to resolve a clock error.
Sanitized messages can omit legitimate long identifiers or text that matches submitted values.
Use the typed error and record/capture read-back when a message lacks detail.
`MetadataScopeError.detail` names what was refused, using identifiers only: `field`, `table`, the set's `updateSetState`
and `updateSetApplication`, or a form's `redirectPath`.
Delete requires exact confirmation and a global Delete action that calls `confirmAndDeleteFromForm()`.
The writer checks record absence, a DELETE capture and metadata-delete evidence.
It never uses a second deletion path.

Form endpoints and action names are platform behavior, rather than a documented integration contract.
The governing evidence covers Australia patch 3 on dev206299.
Run the committed integration lifecycle before claiming support for another family or table.
This API does not publish an application or promote a change. Form layouts use
[FormLayoutWriter](./FormLayoutWriter.md); creating, completing and restoring sets use
[WorkingSetManager](./WorkingSetManager.md).
