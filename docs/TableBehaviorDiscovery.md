# Table behavior discovery

`TableBehaviorDiscovery` reads configuration associated with a table. It complements `SchemaDiscovery`; it does not execute scripts, flows, transitions, or evaluate conditions against records.

```typescript
import { TableBehaviorDiscovery } from '@sonisoft/now-sdk-ext-core';

const discovery = new TableBehaviorDiscovery(instance);
const inventory = await discovery.discoverTableBehavior('incident');
const focused = await discovery.discoverTableBehavior('change_request', {
    categories: ['business_rules', 'ui_policies', 'data_policies'],
    details: ['scripts'],
});
const details = await discovery.getBehaviorDetails([
    { kind: 'flows', sourceTable: 'sys_hub_flow', sysId: flowSysId },
], { details: ['definitions', 'dependencies'], dependencyDepth: 1 });
```

## Defaults and controls

- Categories: `business_rules`, `ui_actions`, `client_scripts`, `ui_policies`, `data_policies`, `workflows`, `flows`, `state_models`.
- Active configuration and applicable ancestors are included. `includeInactive` includes inactive versions and designer triggers; `includeInherited: false` restricts associations to the requested table.
- `name` filters metadata names. `sysIds` filters source metadata IDs (flow discovery IDs identify trigger records; direct detail calls also accept flow IDs).
- `details` selects `scripts`, `definitions`, and/or `dependencies`. Conditions and declarative UI/data-policy field actions are included in summaries. `scriptFields` names schema-supported script fields, not proof that a nonempty script is accessible.
- `dependencyDepth: 1` requires `details: ['dependencies']`. Expansion makes at most 50 unique dependency attempts. Explicit references and inferred literal script references are distinguished; dynamic calls are not exhaustively resolved.
- `limit`: 50 items per category by default, maximum 200. Detail batches accept 1–50 references.
- `maxBytes`: 65,536 bytes by default, configurable from 4,096 to 1,048,576. Oversized scripts/definitions are omitted whole with `omittedDetails` and a reference for a smaller batch or larger budget.
- `scope`: optional transaction scope for existing ProcessFlow definition readers.

Pass a category's `nextCursor` back in `cursors[category]`, retaining the table and filters. For example, `{ categories: ['business_rules'], cursors: { business_rules: previous.categories[0].nextCursor } }`. Tokens are stateless offsets, not snapshot isolation: concurrent instance edits can change pages. Batched details expose `remainingReferences` when the response budget is reached.

## Interpretation

Results describe `accessible_configuration`. An empty category is not evidence that no behavior exists outside the account's ACL/domain visibility. Inspect category status and warnings, including child-record failures and missing requested fields.

If failure or continuation metadata alone exceeds the byte budget, the call fails with instructions to increase `maxBytes` or narrow the request; it never returns an oversized JSON result.

Configuration preserves ServiceNow field names and values. This retains encoded conditions, role restrictions, execution order, operation flags, and policy tri-state values such as `ignore`. UI policy field actions, server data policies, and state transition gates remain separate sources of requirements. Do not equate a client mandatory field with server enforcement.

Source table, scope, record ID, ancestor association, and override references are retained. Override links on the returned page are annotated; this is not a universal execution ordering or visibility simulator. Legacy workflows and state models use their configured target table; script-started workflows and flows without a table trigger are not inferred as table associations.

## Flows and state models

Runtime record triggers are read from `sys_flow_record_trigger` and joined to `sys_hub_flow.remote_trigger_id`. The summary also joins the selected flows' designer trigger inputs to expose repeat strategy and other configuration. Runtime and design-time sources are labeled separately. Designer definitions can differ from the active compiled version.

With `includeInactive`, the additional designer inventory reads at most 200 record-trigger candidates per page from `sys_hub_trigger_instance_v2`. Its table selection lives inside compressed `trigger_inputs`, so filtering happens after bounded decoding. A page may contain no matching items and still have a continuation. Only record trigger types are scanned; scheduled/application triggers are not inferred as table behavior. Decoding is bounded to 1 MiB.

Flow detail reuses existing ProcessFlow readers. Dependencies resolve snapshot references to canonical action/subflow IDs where the definition supplies that relationship; `snapshotSysId` preserves the referenced version. Expanded definitions are current design-time content, not a claim about the snapshot that executed.

Generic state discovery handles `sys_state_model`/`sys_state_transition` and `sttrm_model` with its states, transitions, condition records and required-field records. Queries target the requested table and matching parent IDs. There is no unconditional change-model lookup.

Legacy workflow detail includes activities, transition conditions and variable values, preserving reference IDs. Related collections are bounded to 2,000 records; larger collections report truncation and require narrower parent requests.

## Compatibility and validation

Intended families: Zurich and Australia. Readers check table hierarchy and dictionary fields before issuing metadata filters; unavailable layouts or permissions are reported explicitly. All queries use the existing authenticated HTTP layer and respect its policy gate. Metadata reads are reused within a call, with at most four concurrent metadata probes; no persistent result cache is added.

The checked-in Australia dictionary fixture was captured through read-only queries on 2026-09-05. Live validation covered all eight categories, flow/state detail, inherited configuration and non-change tables. Zurich validation remains a release gate; the Australia fixture is not presented as Zurich evidence.

Primary references: [State Management](https://www.servicenow.com/docs/main/markdown/platform-administration/state-management/state-model), [flow runtime trigger linkage](https://support.servicenow.com/kb?id=KB2606177), and installed ServiceNow SDK trigger/state-model/data-policy serializers. `now-sdk explain trigger-api` and `now-sdk explain statemodel-api` describe the configuration semantics.

Read-only integration checks require an explicit alias:

```bash
NEX_BEHAVIOR_TEST_ALIAS=dev206299 npm run test:integration -- --runTestsByPath test/integration/sn/behavior/TableBehaviorDiscovery_IT.test.ts
```
