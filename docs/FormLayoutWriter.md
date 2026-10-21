# Change a form layout, verified

`FormLayoutWriter` reads and replaces one form section's layout (`sys_ui_section`) through the
classic Form Layout page (`/slushbucket.do`), as the UI does. The platform captures the whole
section as one Form Layout file, `sys_ui_section_<section sys_id>`, so a layout change is not
made by inserting `sys_ui_element` rows.

```typescript
import { FormLayoutWriter } from '@sonisoft/now-sdk-ext-core';

const layouts = new FormLayoutWriter(instance);
const before = await layouts.getFormLayout(sectionId);   // { section, table, view, caption, scope, elements }
const result = await layouts.setFormLayout(sectionId, {
    elements: [...before.elements, 'url'],                // the whole section, in order
    scope: { sysId: before.scope },
    updateSet: setId,                                      // In progress, same application, and the working set
    storeCustomization: { acknowledgeUpgradeSkip: true },  // only for an installed Store application
});
// result.previousElements puts it back; result.capture.customization reports the upgrade skip
```

A non-default view is opened by its `sys_ui_view` name; the Default view is `''`. Elements use the page's own values: a field name (dot-walked names allowed), `.begin_split`,
`.split`, `.end_split`, or `.formatter.<sys_ui_formatter sys_id>`. `getFormLayout` shows an
annotation as `.annotation.<id>`, a chart as `.chart.<id>`, and an embedded related list as
`.list.<relationship>` (for example `.list.12M.<table>.<field>.<suffix>`). Their stored
`sys_ui_element.element` would otherwise look like a field name. `setFormLayout` cannot write
them back, and the Form Layout page does not even offer an embedded list. So it refuses any
section that holds one with `section_not_supported` (`detail.field` is `annotation`, `chart` or
`list`) before posting. Leaving them out of the list would delete them. Change such
a section in the Form Layout UI. The section order of the form (`sys_ui_form_sections_<form id>`) is a separate file,
and this writer does not change it.

## Before the save

Each of these is checked before anything is posted. A failure throws `MetadataScopeError` and
nothing is sent:

- The ids and elements are valid, with no duplicate fields (`invalid_input`). Every field is
  offered by the page (`field_not_supported`, with `detail.field`).
- The scope resolves to one application, and the section belongs to it (`scope_mismatch`).
- An installed Store application needs `storeCustomization.acknowledgeUpgradeSkip`
  (`store_scope`). A vendor-locked section (`sys_policy`) is refused with `protected_record`.
- The update set is In progress in the same application (`invalid_input`, with the state and
  application in `detail`), and it is the working set (`update_set_not_current`). Use
  `WorkingSetManager.useUpdateSet` first.
- The page loads in that scope, for that section, with a Save button (`scope_not_applied`,
  `not_permitted`, `form_redirected`).

## After the save

The single POST is never replayed. The writer then checks the following, and a failure throws
`MetadataVerificationError` with `writeAttempted: true`:

- The section's elements read back in the requested order (`write_not_applied`).
- Exactly one capture `sys_ui_section_<id>` changed, in the expected set and application
  (`not_captured`, `captured_elsewhere`, `mixed_scope_capture`; more than one changed row is
  `verification_unavailable`).
- The user's preferences are unchanged (`session_changed`).

For a Store application, `capture.customization` reports `replaceOnUpgrade` and
`baselineVersion`. `replaceOnUpgrade: false` means the next upgrade of that application skips the
section. Reverting the layout afterwards does not clear that. Record it with the change.

Seen on dev206299 (Australia patch 3) on 2026-10-20: adding and removing `url` on GRC's
`sn_compliance_policy` Default view left one Form Layout capture in the GRC set.
