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
There is no default scope. Installed Store applications are refused.
The table must extend `sys_metadata` and must pass the table deny list.
Caller fields must exist on the form. Caller `sys_*` fields are refused.
An initial query accepts equality terms for ordinary fields. It cannot override system fields.

Pass `initialQuery`, `variables`, `variableField` and `view` as with `FormRecordWriter`.
For example, an ATF step can use `initialQuery` to select its test and step configuration.
The encoded form state carries those values. Unknown variables fail before the POST.

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
If needed, the caller can restore its original set explicitly with `UpdateSetManager.setCurrentUpdateSet`.
Resolve the original set's name and pass `{ name, sysId }`. Coordinate that operation with other session users.
Avoid concurrent metadata writes and picker changes in one session.

Each POST runs once. A 401 or uncertain response is never replayed.
On `MetadataVerificationError`, use `table`, `sysId`, `writeAttempted`, `capture` and sanitized `messages` to inspect the result.
The record can exist even when verification fails. Read it before any cleanup or retry decision.
Capture and delete verification use the client's UTC start time and reject unchanged capture versions.
Keep the client clock synchronized with the instance. A client clock that runs ahead can reject a successful write as unverified.
A backward time margin is not applied because it could admit older evidence. Do not repeat a write to resolve a clock error.
Sanitized messages can omit legitimate long identifiers or text that matches submitted values.
Use the typed error and record/capture read-back when a message lacks detail.
Delete requires exact confirmation and a global Delete action that calls `confirmAndDeleteFromForm()`.
The writer checks record absence, a DELETE capture and metadata-delete evidence.
It never uses a second deletion path.

Form endpoints and action names are platform behavior, rather than a documented integration contract.
The governing evidence covers Australia patch 3 on dev206299.
Run the committed integration lifecycle before claiming support for another family or table.
This API does not publish an application, complete an update set or promote a change.
