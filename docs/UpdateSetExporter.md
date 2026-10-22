# Export an update set to XML, verified

`UpdateSetExporter` produces the same XML unload as the platform's own **Export to XML** buttons, checks
that the file holds exactly the sets and records it should, and leaves nothing behind on the instance.

```typescript
import { writeFile } from 'node:fs/promises';
import { UpdateSetExporter, UpdateSetExportError } from '@sonisoft/now-sdk-ext-core';

try {
    const result = await new UpdateSetExporter(instance).exportUpdateSet('0123456789abcdef0123456789abcdef');
    await writeFile('STORY-123.xml', result.xml, 'utf8');
    console.log(result.kind, result.recordCount, result.sets, result.cleanup);
} catch (error) {
    if (error instanceof UpdateSetExportError) console.error(error.code, error.detail);
    else throw error;
}
```

The file holds every record's full payload. Treat it like a copy of the instance's configuration: do not
take one from a customer instance without the owner's say-so.

## What it exports, and how

The sys_id can be a local update set (`sys_update_set`) or a Retrieved Update Set (`sys_remote_update_set`).
The exporter follows the UI action the platform would offer for that record.

| Record | Platform UI action | What the exporter does |
| --- | --- | --- |
| Local set, not in a batch | **Export to XML** (`sys_update_set`) | `UpdateSetExport.exportUpdateSet` in a background script, then `export_update_set.do` |
| Local batch base (`base_update_set` is itself) | **Export Update Set Batch to XML** | `UpdateSetExport.exportHierarchy`, then `export_base_update_set.do`; the file holds the base and its children |
| Local batch member | none | refused with `batch_member`; `detail.base` is the set to export |
| Retrieved set, Loaded | **Export to XML** (`sys_remote_update_set`) | a plain GET of `export_update_set.do?sysparm_is_remote=true` |
| Retrieved batch base, Loaded | none in the UI | a plain GET of `export_base_update_set.do`, which returns the base and its members |
| Retrieved batch member, or not Loaded | none | refused with `batch_member` or `retrieved_state` |

The platform offers Export to XML only for a **Complete** set. The exporter refuses any other state with
`update_set_incomplete` unless you pass `{ includeIncomplete: true }`. The file is then a snapshot of
unfinished work, and `messages` says so. For a batch, `includeIncomplete` also includes children that are not
Complete, as `UpdateSetExport.onlyIncludeCompletedChildren = false` does. Without it, any such child and its
own children are reported in `excluded`.

In practice the platform keeps a batch consistent: reopening a child reopens its base, completing a base
completes its children, and setting a child to Ignore detaches it from the batch.

### The temporary copy

A local export copies the set, and for a batch every included child, into a temporary Retrieved Update Set
in state Loaded. The download (`sysparm_delete_when_done=true`) then deletes it. A copy left behind would sit
under Retrieved Update Sets, ready to preview and commit, so the exporter:

1. reads the copy back after the download;
2. waits for the platform to finish deleting it. The platform's delete runs after the download returns: on
   dev206299 a batch's copies, and a set's copied sys_update_xml rows, were still readable at first and gone
   within a few seconds;
3. deletes whatever is still there after about 15 seconds, or at once if the download failed;
4. throws `cleanup_unverified` with `detail.temporary` (sys_remote_update_set sys_ids) while any copy or any
   of its rows remains.

`result.cleanup.removedBy` is `platform` or `nex`. If the script's result cannot be read, the exporter does
not delete anything. It reports any new copy of the set in `detail.temporary`, because another session may
be exporting the same set.

A Retrieved Update Set export creates and deletes nothing, so it works with writes and execution denied.

## What is checked in the file

- The response is 200 and not empty. The processors answer an unknown sys_id with an empty 200.
- The document parses, and its root is `<unload>` holding only `sys_remote_update_set` and `sys_update_xml`.
- It holds exactly one `sys_remote_update_set` per planned set. For a local export these are matched by
  `remote_sys_id` to the source set. The batch processor writes the base twice; it is the same row.
- Each set has exactly as many `sys_update_xml` rows as the Stats API counts for it, and there are no others.

A mismatch throws `export_mismatch` with `detail.expected` and `detail.actual` (record counts).

## Result

```typescript
interface UpdateSetExportResult {
    xml: string;
    source: 'local' | 'retrieved';
    kind: 'single' | 'batch';
    updateSet: { sysId: string; name: string; state: string; application: string };
    sets: Array<{ sysId: string; name: string; state: string; records: number }>;  // requested set first
    excluded: Array<{ sysId: string; name: string; state: string }>;
    recordCount: number;
    cleanup?: { temporarySysId: string; removedBy: 'platform' | 'nex' };              // local exports
    messages: string[];
}
```

## Errors

`UpdateSetExportError.code`:

| Code | Meaning |
| --- | --- |
| `invalid_input` | Not a 32-character hex sys_id. |
| `update_set_not_found` | No local or retrieved set has that sys_id. |
| `update_set_incomplete` | The local set is not Complete; pass `includeIncomplete` to export a snapshot. |
| `batch_member` | The set belongs to a batch; export `detail.base`. |
| `retrieved_state` | The Retrieved Update Set is not Loaded (`detail.state`). |
| `evidence_unavailable` | A read did not return complete evidence. Nothing was copied. |
| `script_result_unavailable` | The background script's result could not be read; see `detail.temporary`. |
| `export_failed` | The download was not a 200 with content (`detail.status`). The copy was cleaned up. |
| `export_mismatch` | The file does not hold exactly the expected sets and records. |
| `cleanup_unverified` | A temporary copy or its rows remain: delete `detail.temporary` from sys_remote_update_set. |

## Permissions and policy

The processors require `admin`, `delegated_developer` or `update_set_admin`. A local export runs a
background script (execute) and its download deletes records (write), so `--read-only`, `--deny-execute` and
`NEX_POLICY_DENY` refuse it before anything is copied. A Retrieved Update Set export is a read.

`UpdateSetManager.exportUpdateSet(sysId)` is deprecated. It now calls this exporter with
`includeIncomplete: true` and returns `result.xml`.
