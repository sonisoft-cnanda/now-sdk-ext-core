# Update sets for any application, verified

`WorkingSetManager` runs the update-set lifecycle for a change in any application: your own,
an installed Store application, or Global. Every step reads its outcome back from the instance,
and a step that did not take effect throws `WorkingSetError` with a code and identifiers.

```typescript
import { FormLayoutWriter, WorkingSetError, WorkingSetManager } from '@sonisoft/now-sdk-ext-core';

const sets = new WorkingSetManager(instance);
const set = await sets.createUpdateSet({
    application: 'sn_compliance',           // 'global', a sys_scope sys_id, or a unique active scope name
    name: 'STORY-123 Policy form',
    description: 'Customizes GRC sn_compliance_policy form; upgrades skip sys_ui_section',
});
const { previous } = await sets.useUpdateSet(set.sysId);
try {
    // ... MetadataFormWriter / FormLayoutWriter writes with updateSet: set.sysId ...
    await sets.completeUpdateSet(set.sysId, { expectedCaptures: 1 });
} finally {
    await sets.restoreWorkingSet(previous);
}
```

## What decides where a change lands

Three per-user preferences decide which set captures a change: `apps.current_app`,
`sys_update_set` and `updateSetForScope<application>`. Sessions reconcile the set to the
current application. So setting only the current set, as the picker call in
`UpdateSetManager.setCurrentUpdateSet` does, is undone by the next session for a set of another
application. `useUpdateSet` saves all three and reads them back.

## Methods

| Method | Does | Refuses (code) |
|---|---|---|
| `getWorkingSet()` | reads `apps.current_app` and `sys_update_set` | |
| `getUpdateSet(sysId)` | name, state, application, `isDefault` | `update_set_not_found` |
| `createUpdateSet({ application, name, description? })` | creates an In progress set with `application` written server-side (the Table API drops that field) and reads it back | `update_set_exists` (same name open in that application), `application_not_found`, `application_not_applied`, `create_not_applied` |
| `useUpdateSet(sysId, { allowDefault? })` | makes the set the working set for every later session; returns `previous` | `update_set_closed`, `default_update_set` (unless `allowDefault`, for restoring only), `working_set_not_applied` |
| `restoreWorkingSet(previous)` | puts `previous` back; if that set has closed, uses the application's single In progress Default (`fallback: 'application_default'`) | `no_single_default` |
| `moveCapture({ capture, sourceSet, targetSet, reason })` | moves one `sys_update_xml` row between In progress sets of its own application, appends the reason to `comments`, reads the move back | `capture_not_in_source`, `update_set_closed`, `default_update_set`, `scope_mismatch`, `duplicate_capture`, `newer_capture_exists`, `move_not_applied` |
| `completeUpdateSet(sysId, { expectedCaptures })` | sets Complete after checking the set and reads the state back | `update_set_closed`, `default_update_set`, `capture_count_mismatch`, `mixed_scope_capture`, `duplicate_capture`, `update_set_in_use` (another user's current set), `complete_not_applied` |

`WorkingSetError.detail` holds only sys_ids, states and counts. It never holds names,
descriptions or payloads.

## Notes

- Creating a set and saving preferences run as short global background scripts (`execute` in the
  policy ladder). Moves and completion use the Table API (`write`). Reads are `READ_ONLY`.
- `completeUpdateSet` leaves your own preferences on the completed set. A closed set is not
  captured into, and the next session falls back to the application's Default. Call
  `restoreWorkingSet` straight after it.
- `completeUpdateSet` does not compare captures with the live records, or look for ATF schedule
  rows. The `update-sets` skill's `complete-update-set.js` adds those checks.
- Seen end to end on dev206299 (Australia patch 3) on 2026-10-20 for GRC (`sn_compliance`, an
  installed Store application) and for Global.
