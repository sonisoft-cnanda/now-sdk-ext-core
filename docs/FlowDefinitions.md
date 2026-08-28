# Flow, Subflow and Action Definitions

`FlowManager` can retrieve the **design-time definition** of a Flow Designer
artifact — what it *is*, not what it *did*. The definition comes back as the raw,
JSON-serializable payload ServiceNow returns, so a consumer can save it, review
it, or diff it without this library standing between them and the data.

These operations are read-only. They issue `GET`s to the ProcessFlow definition
routes and nothing else: no script execution, no test run, no copy, no publish,
no mutation, and no flow context is accepted or created.

## Table of Contents

- [Operations](#operations)
- [Serializing a definition to JSON](#serializing-a-definition-to-json)
- [Result contracts](#result-contracts)
- [Failure handling](#failure-handling)
- [Type safety across artifact types](#type-safety-across-artifact-types)
- [Scope](#scope)
- [Relationship to the older methods](#relationship-to-the-older-methods)
- [Endpoints used](#endpoints-used)

## Operations

```typescript
import { ServiceNowInstance, FlowManager } from '@sonisoft/now-sdk-ext-core';
import { getCredentials } from '@servicenow/sdk-cli/dist/auth';

const credential = await getCredentials('my-instance-alias');
const instance = new ServiceNowInstance({ alias: 'my-instance-alias', credential });
const flows = new FlowManager(instance);
```

| Method | Returns | Notes |
| --- | --- | --- |
| `getFlowArtifactDefinition(sysId, options?)` | `FlowArtifactDefinitionResult` | A flow **or** a subflow; reports which one it got |
| `getFlowDesignDefinition(sysId, options?)` | `FlowArtifactDefinitionResult` | Must be a flow, otherwise `type_mismatch` |
| `getSubflowDefinition(sysId, options?)` | `FlowArtifactDefinitionResult` | Must be a subflow, otherwise `type_mismatch` |
| `getActionDefinition(sysId, options?)` | `ActionDefinitionResult` | Action metadata **and** ordered steps |

### Flow or subflow

```typescript
const result = await flows.getFlowArtifactDefinition('ae20de1b83a79210e84dcba2722bc06e');

if (result.success) {
    console.log(result.artifactType);        // 'flow' | 'subflow'
    console.log(result.summary?.name);       // 'Change - Conflict Detection'
    console.log(result.summary?.actionCount);
    // result.definition holds triggers, actions, subflows, flow logic,
    // inputs and outputs exactly as ServiceNow returned them.
}
```

### Complete action

A complete action needs two reads — its metadata and its step instances — which
are composed into one result. `success` is `true` only when both parts arrived,
so an action never comes back looking as though it simply has no steps.

```typescript
const action = await flows.getActionDefinition('1df3d0cb534e2010c232ddeeff7b12e1');

if (action.success) {
    console.log(action.summary?.name);       // 'Add a Pause'
    console.log(action.summary?.state);      // 'published'
    console.log(action.steps?.length);       // ordered ascending by `order`

    for (const step of action.summary!.steps) {
        console.log(`${step.order}. ${step.label} (${step.stepTypeName})`);
    }
}
```

## Serializing a definition to JSON

`definition`, `metadata` and `steps` are plain data, so they serialize directly.
Nothing needs to be unwrapped or converted first.

```typescript
import { writeFile } from 'node:fs/promises';

const result = await flows.getFlowArtifactDefinition(flowSysId);
if (!result.success) throw new Error(result.errorMessage);

await writeFile(
    `${result.summary!.internalName}.flow.json`,
    JSON.stringify(result.definition, null, 2),
    'utf8'
);
```

For an action, save both halves together so the file describes the whole
artifact:

```typescript
const action = await flows.getActionDefinition(actionSysId);
if (!action.success) throw new Error(action.errorMessage);

await writeFile(
    `${action.summary!.internalName}.action.json`,
    JSON.stringify({ metadata: action.metadata, steps: action.steps }, null, 2),
    'utf8'
);
```

Where the JSON is written, and under what name, is the caller's decision — this
library deliberately does no file persistence.

## Result contracts

### `FlowArtifactDefinitionResult`

| Field | Type | Description |
| --- | --- | --- |
| `success` | `boolean` | Whether the definition was retrieved |
| `sysId` | `string` | The trimmed sys_id that was requested |
| `artifactType` | `'flow' \| 'subflow'` | Set only when ServiceNow reported a type this library recognises |
| `reportedType` | `string` | The raw `type` ServiceNow reported, including values not recognised here |
| `definition` | `Record<string, unknown>` | The untouched definition payload |
| `summary` | `FlowArtifactSummary` | Name, internal name, scope, status and collection counts |
| `errorMessage` | `string` | Actionable failure description |
| `failureReason` | `FlowDefinitionFailureReason` | Machine-readable failure classification |
| `errorCode` | `number` | Numeric code from the processflow API, when it reported one |

### `ActionDefinitionResult`

| Field | Type | Description |
| --- | --- | --- |
| `success` | `boolean` | True only when metadata **and** steps were retrieved |
| `sysId` | `string` | The trimmed sys_id that was requested |
| `artifactType` | `'action'` | Present on success |
| `metadata` | `Record<string, unknown>` | Untouched action-type record |
| `steps` | `Array<Record<string, unknown>>` | Untouched step instances, sorted ascending by `order` |
| `summary` | `ActionDefinitionSummary` | Identity, state, input/output counts and ordered step projections |
| `errorMessage`, `failureReason`, `errorCode` | | As above |

The `summary` fields are a small, stable projection. The full payload stays on
`definition` / `metadata` untouched, because ServiceNow evolves that schema
between families and normalising it here would make family upgrades breaking.

## Failure handling

Neither operation throws for bad input or an unhappy instance — both return a
typed failure. Branch on `failureReason`, not on message text.

| `failureReason` | Means |
| --- | --- |
| `invalid_identifier` | Blank, or not a 32-character hex sys_id. No request is sent. |
| `type_mismatch` | The artifact exists but is not the type this operation retrieves |
| `not_found` | No such artifact, or ServiceNow returned an empty payload for it |
| `permission_denied` | The session may not read the artifact (HTTP 401/403) |
| `api_error` | ServiceNow answered with an error code or message |
| `malformed_response` | The body did not match the expected wrapper |
| `request_failed` | Transport error, or an unclassified HTTP status |

```typescript
const result = await flows.getSubflowDefinition(sysId);

if (!result.success) {
    switch (result.failureReason) {
        case 'type_mismatch':
            console.error(`${sysId} is a ${result.reportedType}, not a subflow`);
            break;
        case 'permission_denied':
            console.error('This account cannot read that subflow');
            break;
        default:
            console.error(result.errorMessage);
    }
}
```

`errorMessage` never carries a response body. A failing ProcessFlow request can
return record data, scripts or field values in its body, so only the status and a
description survive into the result.

## Type safety across artifact types

Flows and subflows are served by the *same* endpoint and are told apart only by
the `type` field in the payload. The type-specific operations therefore verify it
rather than assume it:

```typescript
// sys_id belongs to a subflow
const result = await flows.getFlowDesignDefinition(subflowSysId);

result.success;        // false
result.failureReason;  // 'type_mismatch'
result.reportedType;   // 'subflow'
result.definition;     // undefined — nothing is returned under the wrong label
```

Use `getFlowArtifactDefinition` when either is acceptable; it reports what it
found instead of failing. An artifact type this library does not recognise comes
back as `success: true` with `reportedType` set and `artifactType` left
`undefined`, rather than being mapped onto the nearest known type.

## Scope

All four operations accept an optional scope, sent as
`sysparm_transaction_scope`:

```typescript
await flows.getFlowArtifactDefinition(sysId, { scope: 'global' });
```

It is optional; ServiceNow resolves the artifact's own scope when it is omitted.
`getActionDefinition` passes it to both of its reads.

## Relationship to the older methods

- `getFlowDefinition(flowSysId, scope?)` still works exactly as before. It
  reports neither the artifact type nor a machine-readable failure reason, and it
  throws for a blank sys_id. Prefer `getFlowArtifactDefinition`.
- `getFlowActions(actionSysId, scope?)` is **deprecated**. Despite the name it
  returns only step instances, never the action's own metadata, so it cannot
  describe an action on its own. It keeps working with an unchanged signature;
  use `getActionDefinition` instead.

## Endpoints used

| Operation | Request |
| --- | --- |
| Flow / subflow | `GET /api/now/processflow/flow/{sys_id}` |
| Action metadata | `GET /api/now/processflow/action/action_types/{sys_id}` |
| Action steps | `GET /api/now/processflow/action/action_types/{sys_id}/step_instances` |

These are the routes Workflow Studio itself uses. They are observed UI APIs
rather than a documented public REST contract, which is why every response is
validated before it is reported as a success and why `definition` is kept opaque.

## Related

- [Getting Started Guide](./GettingStarted.md)
- [API Reference](./APIReference.md)
