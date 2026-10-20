# UpdateSetManager

The `UpdateSetManager` class provides operations for managing ServiceNow update sets programmatically.

## Table of Contents

- [Overview](#overview)
- [Constructor](#constructor)
- [Methods](#methods)
- [Interfaces](#interfaces)
- [Examples](#examples)
- [Best Practices](#best-practices)
- [Related](#related)

## Overview

The `UpdateSetManager` enables you to:

- Set and get the current update set for a session
- List update sets from the `sys_update_set` table with filtering
- Create new update sets with optional description, application, and state
- Move `sys_update_xml` records between update sets
- Clone an entire update set and its records into a new update set
- Inspect an update set to see its contents grouped by component type

## Constructor

```typescript
constructor(instance: ServiceNowInstance)
```

### Example

```typescript
import { ServiceNowInstance, UpdateSetManager } from '@sonisoft/now-sdk-ext-core';

const updateSetManager = new UpdateSetManager(instance);
```

## Methods

### setCurrentUpdateSet

Sets the current update set for the session using the concoursepicker API.

```typescript
async setCurrentUpdateSet(options: SetUpdateSetOptions): Promise<void>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `options` | `SetUpdateSetOptions` | The update set name and sysId to set as current |

#### SetUpdateSetOptions

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Name of the update set |
| `sysId` | `string` | sys_id of the update set |

#### Throws

- `Error` if `name` or `sysId` is empty
- `Error` if the PUT request fails

#### Example

```typescript
await updateSetManager.setCurrentUpdateSet({
    name: 'My Feature Update Set',
    sysId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'
});

console.log('Current update set changed successfully');
```

---

### getCurrentUpdateSet

Retrieves the currently active update set using the concoursepicker API.

```typescript
async getCurrentUpdateSet(): Promise<UpdateSetRecord | null>
```

#### Returns

`Promise<UpdateSetRecord | null>` -- the current update set record with `sys_id`, `name`, `state` and `application`. The picker reports only the name and sys_id; the state and application are read from `sys_update_set`.

#### Throws

- `Error` if the API call fails or returns a non-200 status

#### Example

```typescript
const current = await updateSetManager.getCurrentUpdateSet();

if (current) {
    console.log(`Current update set: ${current.name}`);
    console.log(`sys_id: ${current.sys_id}`);
    console.log(`State: ${current.state}`);
}
```

---

### listUpdateSets

Lists update sets from the `sys_update_set` table using the Table API.

```typescript
async listUpdateSets(options?: ListUpdateSetsOptions): Promise<UpdateSetRecord[]>
```

#### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `options` | `ListUpdateSetsOptions` | `{}` | Optional query, limit, and fields options |

#### ListUpdateSetsOptions

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `encodedQuery` | `string` | - | Encoded query string for filtering (ServiceNow encoded query syntax) |
| `limit` | `number` | `100` | Maximum number of records to return |
| `fields` | `string` | - | Comma-separated list of fields to return |

#### Returns

`Promise<UpdateSetRecord[]>` -- an array of update set records.

#### Throws

- `Error` if the API call fails or returns a non-200 status

#### Example

```typescript
// List all update sets
const allSets = await updateSetManager.listUpdateSets();
console.log(`Found ${allSets.length} update sets`);

// List only "in progress" update sets with specific fields
const inProgress = await updateSetManager.listUpdateSets({
    encodedQuery: 'state=in progress',
    limit: 50,
    fields: 'sys_id,name,state,description,sys_created_on'
});

inProgress.forEach(us => {
    console.log(`${us.name} (${us.state}) - created: ${us.sys_created_on}`);
});
```

---

### createUpdateSet

Creates a new update set in the `sys_update_set` table.

```typescript
async createUpdateSet(options: CreateUpdateSetOptions): Promise<UpdateSetRecord>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `options` | `CreateUpdateSetOptions` | The update set name and optional configuration |

#### CreateUpdateSetOptions

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `name` | `string` | - | Name of the update set (required) |
| `description` | `string` | - | Description of the update set |
| `application` | `string` | - | `global`, a sys_scope sys_id, or a unique active scope name. With an In progress state the set is created through `WorkingSetManager.createUpdateSet`, which writes the application server-side and reads it back (the Table API silently drops this field) |
| `state` | `string` | `"in progress"` | State of the update set |

#### Returns

`Promise<UpdateSetRecord>` -- the created update set record.

#### Throws

- `Error` if `name` is empty
- `Error` if the API call fails or returns a non-200/201 status

#### Example

```typescript
const newSet = await updateSetManager.createUpdateSet({
    name: 'FEAT-1234 Login Page Redesign',
    description: 'Update set for login page UI changes',
    state: 'in progress'
});

console.log(`Created: ${newSet.name} (${newSet.sys_id})`);
```

---

### moveRecordsToUpdateSet

Moves `sys_update_xml` records to a target update set. Records can be selected by explicit sys_ids, by source update set, by time range, or by a combination of source update set and time range.

```typescript
async moveRecordsToUpdateSet(
    targetUpdateSetId: string,
    options?: MoveRecordsOptions
): Promise<MoveRecordsResult>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `targetUpdateSetId` | `string` | The sys_id of the target update set |
| `options` | `MoveRecordsOptions` | Options for selecting which records to move |

#### MoveRecordsOptions

| Property | Type | Description |
|----------|------|-------------|
| `recordSysIds` | `string[]` | Specific record sys_ids to move |
| `timeRange` | `{ start: string; end: string }` | Time range to select records by `sys_created_on` |
| `sourceUpdateSet` | `string` | Source update set sys_id to move records from |
| `onProgress` | `(message: string) => void` | Callback for progress updates |

Provide `recordSysIds` or `sourceUpdateSet`. A `timeRange` narrows a source set; on its own it is refused, because it would select every local capture on the instance in that window. Each move is read back, and a move the platform aborted (for example "Cannot move update to a set for a different scope") is counted as failed with `Move not applied`. To move one capture with scope and duplicate checks, use `WorkingSetManager.moveCapture`.

#### Returns

`Promise<MoveRecordsResult>` containing:
- `moved`: Number of records successfully moved
- `failed`: Number of records that failed to move
- `records`: Details of each record processed (sys_id, name, type, status)
- `errors`: Details of errors encountered (sys_id, error message)

#### Throws

- `Error` if `targetUpdateSetId` is empty
- `Error` if no selection criteria is provided, or only `timeRange`

#### Example

```typescript
// Move specific records by sys_id
const result = await updateSetManager.moveRecordsToUpdateSet(
    'target-update-set-sys-id',
    {
        recordSysIds: ['record-1-sys-id', 'record-2-sys-id'],
        onProgress: (msg) => console.log(msg)
    }
);

console.log(`Moved: ${result.moved}, Failed: ${result.failed}`);

// Move all records from a source update set
const bulkResult = await updateSetManager.moveRecordsToUpdateSet(
    'target-update-set-sys-id',
    { sourceUpdateSet: 'source-update-set-sys-id' }
);
```

---

### cloneUpdateSet

Clones an update set by creating a new update set and copying all `sys_update_xml` records from the source.

```typescript
async cloneUpdateSet(
    sourceUpdateSetId: string,
    newName: string,
    onProgress?: (message: string) => void
): Promise<CloneUpdateSetResult>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `sourceUpdateSetId` | `string` | The sys_id of the source update set to clone |
| `newName` | `string` | The name for the new cloned update set |
| `onProgress` | `(message: string) => void` | Optional callback for progress updates |

#### Returns

`Promise<CloneUpdateSetResult>` containing:
- `newUpdateSetId`: sys_id of the newly created update set
- `newUpdateSetName`: Name of the newly created update set
- `sourceUpdateSetId`: sys_id of the source update set
- `sourceUpdateSetName`: Name of the source update set
- `recordsCloned`: Number of records cloned
- `totalSourceRecords`: Total number of records in the source

#### Throws

- `Error` if `sourceUpdateSetId` or `newName` is empty
- `Error` if the source update set is not found
- `Error` if the new update set cannot be created

#### Example

```typescript
const cloneResult = await updateSetManager.cloneUpdateSet(
    'source-update-set-sys-id',
    'My Feature v2 - Clone',
    (msg) => console.log(msg)
);

console.log(`Cloned "${cloneResult.sourceUpdateSetName}" -> "${cloneResult.newUpdateSetName}"`);
console.log(`Records cloned: ${cloneResult.recordsCloned}/${cloneResult.totalSourceRecords}`);
```

---

### inspectUpdateSet

Inspects an update set by querying its `sys_update_xml` records and grouping them by component type.

```typescript
async inspectUpdateSet(updateSetSysId: string): Promise<InspectUpdateSetResult>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `updateSetSysId` | `string` | The sys_id of the update set to inspect |

#### Returns

`Promise<InspectUpdateSetResult>` containing:
- `updateSet`: Summary of the update set (sys_id, name, state, description)
- `totalRecords`: Total number of records in the update set
- `components`: Array of component groups, each with a `type`, `count`, and `items` list

#### Throws

- `Error` if `updateSetSysId` is empty
- `Error` if the update set is not found

#### Example

```typescript
const inspection = await updateSetManager.inspectUpdateSet('update-set-sys-id');

console.log(`Update Set: ${inspection.updateSet.name} (${inspection.updateSet.state})`);
console.log(`Total Records: ${inspection.totalRecords}`);
console.log('\nComponents:');

inspection.components.forEach(comp => {
    console.log(`  ${comp.type}: ${comp.count} records`);
    comp.items.forEach(item => console.log(`    - ${item}`));
});
```

## Interfaces

### UpdateSetRecord

A record from the `sys_update_set` table.

```typescript
interface UpdateSetRecord {
    /** System ID */
    sys_id: string;

    /** Name of the update set */
    name: string;

    /** Description of the update set */
    description?: string;

    /** State of the update set (e.g., "in progress", "complete") */
    state: string;

    /** Application scope reference */
    application?: string;

    /** Created timestamp */
    sys_created_on?: string;

    /** Updated timestamp */
    sys_updated_on?: string;

    /** Created by user */
    sys_created_by?: string;

    /** Additional fields */
    [key: string]: unknown;
}
```

### UpdateXmlRecord

A record from the `sys_update_xml` table.

```typescript
interface UpdateXmlRecord {
    /** System ID */
    sys_id: string;

    /** Name of the update XML record */
    name?: string;

    /** Type of the record (e.g., "sys_script_include") */
    type?: string;

    /** Target name of the record */
    target_name?: string;

    /** Reference to the parent update set */
    update_set: string;

    /** XML payload */
    payload?: string;

    /** Category of the update */
    category?: string;

    /** Created timestamp */
    sys_created_on?: string;

    /** Additional fields */
    [key: string]: unknown;
}
```

### SetUpdateSetOptions

Options for setting the current update set.

```typescript
interface SetUpdateSetOptions {
    /** Name of the update set */
    name: string;

    /** sys_id of the update set */
    sysId: string;
}
```

### ListUpdateSetsOptions

Options for listing update sets.

```typescript
interface ListUpdateSetsOptions {
    /** Encoded query string for filtering */
    encodedQuery?: string;

    /** Maximum number of records to return */
    limit?: number;

    /** Comma-separated list of fields to return */
    fields?: string;
}
```

### CreateUpdateSetOptions

Options for creating a new update set.

```typescript
interface CreateUpdateSetOptions {
    /** Name of the update set */
    name: string;

    /** Description of the update set */
    description?: string;

    /** Application scope sys_id */
    application?: string;

    /** State of the update set (defaults to "in progress") */
    state?: string;
}
```

### MoveRecordsOptions

Options for moving records between update sets.

```typescript
interface MoveRecordsOptions {
    /** Specific record sys_ids to move */
    recordSysIds?: string[];

    /** Time range to select records */
    timeRange?: {
        start: string;
        end: string;
    };

    /** Source update set sys_id to move records from */
    sourceUpdateSet?: string;

    /** Callback for progress updates */
    onProgress?: (message: string) => void;
}
```

### MoveRecordsResult

Result of moving records between update sets.

```typescript
interface MoveRecordsResult {
    /** Number of records successfully moved */
    moved: number;

    /** Number of records that failed to move */
    failed: number;

    /** Details of each record processed */
    records: Array<{
        sys_id: string;
        name?: string;
        type?: string;
        status: string;
    }>;

    /** Details of errors encountered */
    errors: Array<{
        sys_id: string;
        error: string;
    }>;
}
```

### CloneUpdateSetResult

Result of cloning an update set.

```typescript
interface CloneUpdateSetResult {
    /** sys_id of the newly created update set */
    newUpdateSetId: string;

    /** Name of the newly created update set */
    newUpdateSetName: string;

    /** sys_id of the source update set */
    sourceUpdateSetId: string;

    /** Name of the source update set */
    sourceUpdateSetName: string;

    /** Number of records cloned */
    recordsCloned: number;

    /** Total number of records in the source update set */
    totalSourceRecords: number;
}
```

### InspectUpdateSetResult

Result of inspecting an update set.

```typescript
interface InspectUpdateSetResult {
    /** The update set record */
    updateSet: {
        sys_id: string;
        name: string;
        state: string;
        description?: string;
    };

    /** Total number of records in the update set */
    totalRecords: number;

    /** Components grouped by type */
    components: Array<{
        type: string;
        count: number;
        items: string[];
    }>;
}
```

## Examples

### Example 1: Create and Activate an Update Set

```typescript
import { ServiceNowInstance, UpdateSetManager } from '@sonisoft/now-sdk-ext-core';

async function createAndActivateUpdateSet(instance: ServiceNowInstance) {
    const usm = new UpdateSetManager(instance);

    // Create a new update set
    const newSet = await usm.createUpdateSet({
        name: 'FEAT-5678 Incident Form Changes',
        description: 'Custom fields and UI policies for the incident form',
        state: 'in progress'
    });

    console.log(`Created update set: ${newSet.name} (${newSet.sys_id})`);

    // Set it as the current update set
    await usm.setCurrentUpdateSet({
        name: newSet.name,
        sysId: newSet.sys_id
    });

    console.log('Update set is now active');

    // Verify
    const current = await usm.getCurrentUpdateSet();
    console.log(`Active update set: ${current?.name}`);
}
```

### Example 2: Inspect Before Promoting

```typescript
async function reviewUpdateSet(instance: ServiceNowInstance, updateSetId: string) {
    const usm = new UpdateSetManager(instance);

    const inspection = await usm.inspectUpdateSet(updateSetId);

    console.log(`\n=== Update Set Review ===`);
    console.log(`Name: ${inspection.updateSet.name}`);
    console.log(`State: ${inspection.updateSet.state}`);
    console.log(`Description: ${inspection.updateSet.description || 'N/A'}`);
    console.log(`Total Records: ${inspection.totalRecords}`);
    console.log(`\nComponent Breakdown:`);

    inspection.components
        .sort((a, b) => b.count - a.count)
        .forEach(comp => {
            console.log(`  ${comp.type}: ${comp.count}`);
            comp.items.forEach(item => console.log(`    - ${item}`));
        });

    if (inspection.totalRecords === 0) {
        console.warn('\nWarning: Update set is empty -- nothing to promote.');
    }
}
```

### Example 3: Move Records Between Update Sets

```typescript
async function consolidateUpdateSets(
    instance: ServiceNowInstance,
    sourceId: string,
    targetId: string
) {
    const usm = new UpdateSetManager(instance);

    console.log('Moving all records from source to target update set...');

    const result = await usm.moveRecordsToUpdateSet(targetId, {
        sourceUpdateSet: sourceId,
        onProgress: (msg) => console.log(`  ${msg}`)
    });

    console.log(`\n=== Move Summary ===`);
    console.log(`Moved: ${result.moved}`);
    console.log(`Failed: ${result.failed}`);

    if (result.errors.length > 0) {
        console.error('\nErrors:');
        result.errors.forEach(e => {
            console.error(`  ${e.sys_id}: ${e.error}`);
        });
    }
}
```

### Example 4: Clone an Update Set for Testing

```typescript
async function cloneForTesting(instance: ServiceNowInstance, updateSetId: string) {
    const usm = new UpdateSetManager(instance);

    const result = await usm.cloneUpdateSet(
        updateSetId,
        `TEST - ${new Date().toISOString().slice(0, 10)} Clone`,
        (msg) => console.log(msg)
    );

    console.log(`\n=== Clone Complete ===`);
    console.log(`Source: ${result.sourceUpdateSetName}`);
    console.log(`Clone: ${result.newUpdateSetName} (${result.newUpdateSetId})`);
    console.log(`Records: ${result.recordsCloned}/${result.totalSourceRecords}`);

    // Optionally set the clone as current
    await usm.setCurrentUpdateSet({
        name: result.newUpdateSetName,
        sysId: result.newUpdateSetId
    });

    console.log('Clone is now the active update set');
}
```

### Example 5: List and Filter Update Sets

```typescript
async function findRecentUpdateSets(instance: ServiceNowInstance) {
    const usm = new UpdateSetManager(instance);

    // Find in-progress update sets created in the last 7 days
    const recentSets = await usm.listUpdateSets({
        encodedQuery: 'state=in progress^sys_created_on>=javascript:gs.daysAgoStart(7)',
        limit: 25,
        fields: 'sys_id,name,state,description,sys_created_on,sys_created_by'
    });

    console.log(`\n=== Recent Update Sets (${recentSets.length}) ===`);
    recentSets.forEach(us => {
        console.log(`  ${us.name}`);
        console.log(`    Created: ${us.sys_created_on} by ${us.sys_created_by}`);
        console.log(`    Description: ${us.description || 'N/A'}`);
    });

    return recentSets;
}
```

## Best Practices

1. **One Feature Per Update Set**: Create a dedicated update set for each feature or fix to keep changes organized and easy to review.
2. **Inspect Before Promoting**: Always use `inspectUpdateSet` to review the contents before promoting to higher environments.
3. **Use Descriptive Names**: Include ticket numbers or feature names in update set names (e.g., `"FEAT-1234 Login Redesign"`) for traceability.
4. **Monitor Move Operations**: Use the `onProgress` callback when moving or cloning records to track progress on large update sets.
5. **Check Move Results**: Always inspect the `errors` array in `MoveRecordsResult` -- partial failures are possible when moving records in bulk.
6. **Clone for Safety**: Use `cloneUpdateSet` to create a backup before performing destructive operations on an update set.
7. **Verify Current Update Set**: After calling `setCurrentUpdateSet`, use `getCurrentUpdateSet` to confirm the change took effect.
8. **Filter with Encoded Queries**: Use ServiceNow encoded query syntax in `listUpdateSets` for efficient server-side filtering rather than fetching all records and filtering client-side.

## Related

- [Getting Started Guide](./GettingStarted.md)
- [ScopeManager](./ScopeManager.md)
- [Application Manager](./ApplicationManager.md)
- [API Reference](./APIReference.md)
- [Examples](./Examples.md)
