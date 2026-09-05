# ServiceNow SDK Extensions Core

[![npm version](https://img.shields.io/npm/v/@sonisoft/now-sdk-ext-core.svg)](https://www.npmjs.com/package/@sonisoft/now-sdk-ext-core)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D26.0.0-brightgreen)](https://nodejs.org)

A comprehensive TypeScript library that extends the ServiceNow SDK with powerful features for application management, automated testing, log monitoring, and more. Perfect for CI/CD pipelines, development automation, and DevOps workflows.

## ✨ Features

- 🚀 **Application Management** - Install, upgrade, and manage ServiceNow applications programmatically
- 🏪 **Store Application Management** - Search, install, and update apps from the ServiceNow Store
- 🧪 **ATF Test Execution** - Run automated tests and get detailed results
- 📊 **Real-time Log Monitoring** - Tail ServiceNow logs with two efficient methods
- 🔄 **AMB (Asynchronous Message Bus)** - WebSocket-based real-time event monitoring
- 📝 **Background Script Execution** - Execute server-side scripts programmatically
- 📋 **Scope Management** - Set/get current application scope programmatically
- 📦 **Update Set Management** - Create, clone, inspect, and manage update sets
- 🔍 **Code Search** - Search across platform code, apps, and tables
- 🗄️ **Schema Discovery** - Discover table schemas, explain fields, validate catalogs
- **[Table Behavior](docs/TableBehaviorDiscovery.md)** - Discover automation, field requirements, and related artifact details
- 📎 **Attachment Management** - Upload, list, and retrieve file attachments
- ⚡ **Batch Operations** - Bulk create/update with variable substitution and query-based bulk operations
- 🔧 **Workflow Management** - Create complete workflows programmatically
- 📌 **Task Operations** - Add comments, assign tasks, resolve/close incidents
- 🔗 **Script Sync** - Bidirectional sync of scripts between local files and instance
- 📈 **Aggregate Queries** - COUNT, AVG, MIN, MAX, SUM with GROUP BY via Stats API
- 🏥 **Instance Health** - Version, cluster, stuck jobs, semaphore monitoring
- 🗺️ **CMDB Relationships** - Query and traverse CI relationship graphs
- 🔎 **Instance Discovery** - List tables, scoped apps, store apps, and plugins
- 🔐 **Authentication** - Seamless integration with ServiceNow CLI authentication
- 📡 **Table API** - Full CRUD operations on ServiceNow tables
- 🛠️ **Type-Safe** - Complete TypeScript definitions for all APIs

## 📦 Installation

```bash
npm install @sonisoft/now-sdk-ext-core
```

### Prerequisites

- Node.js 26.x or higher
- ServiceNow CLI configured with instance credentials
- TypeScript 5.x or higher (optional, for TypeScript projects)

### ServiceNow CLI Setup

```bash
# Install ServiceNow CLI globally
npm install -g @servicenow/sdk

# Configure your instance credentials
now-sdk auth --add https://dev12345.service-now.com --alias dev --type oauth
```

## ⚠️ Breaking Change — v3.0.0 (ServiceNow SDK 4.3.0)

> **If you are upgrading from v2.x, read this first.**
>
> This version upgrades the underlying ServiceNow SDK dependencies from **4.2.x to 4.3.0**. ServiceNow 4.3.0 **changed how credential aliases are stored**, replacing the previous `keytar`-based credential store with a new implementation.
>
> **What this means for you:**
> - Credential aliases created with ServiceNow SDK 4.2.x **cannot be read** by SDK 4.3.x
> - You **must re-create all instance aliases** after upgrading
>
> **Migration steps:**
> ```bash
> # 1. Update the global CLI
> npm install -g @servicenow/sdk@4.3.0
>
> # 2. Re-add each instance alias
> npx @servicenow/sdk auth --add https://dev12345.service-now.com --alias dev --type oauth
>
> # 3. Verify your aliases work
> npx @servicenow/sdk auth --list
> ```
>
> All API surfaces in this library remain unchanged — only the underlying authentication storage has changed.

## 🚀 Quick Start

### Basic Connection

```typescript
import { ServiceNowInstance } from '@sonisoft/now-sdk-ext-core';
import { getCredentials } from '@servicenow/sdk-cli/dist/auth/index.js';

// Get credentials from ServiceNow CLI
const credential = await getCredentials('your-instance-alias');

// Create instance connection
const instance = new ServiceNowInstance({
    alias: 'your-instance-alias',
    credential: credential
});
```

### Inspect Table Behavior

Use `SchemaDiscovery` for fields, choices and references, and `TableBehaviorDiscovery` for the configuration that can affect a record. Table behavior discovery is available from core **6.4.0**; **6.4.1** also fixes file-log flushing during shutdown. The same API powers [`nex behavior`](https://github.com/sonisoft-cnanda/now-sdk-ext-cli#table-behavior-discovery) and the [MCP behavior tools](https://github.com/sonisoft-cnanda/now-sdk-ext-mcp#table-behavior-discovery).

Using the authenticated `instance` from the connection example:

```typescript
import { TableBehaviorDiscovery } from '@sonisoft/now-sdk-ext-core';

const behavior = new TableBehaviorDiscovery(instance);
const inventory = await behavior.discoverTableBehavior('change_request');

for (const section of inventory.categories) {
    console.log(section.category, section.status, section.items.length);
}
```

The eight categories expose different sources of functional requirements:

| Category | Configuration to inspect |
| --- | --- |
| `business_rules` | Before/after/async timing, operation flags, order, conditions and optional scripts (`sys_script`) |
| `ui_actions` | Form/list/workspace placement, visibility conditions, roles and optional scripts (`sys_ui_action`) |
| `client_scripts` | Client event type, target field, view and inherited applicability (`sys_script_client`) |
| `ui_policies` | Conditions and field actions such as mandatory, visible and read-only (`sys_ui_policy`, `sys_ui_policy_action`) |
| `data_policies` | Server field requirements and enforcement settings (`sys_data_policy2`, `sys_data_policy_rule`) |
| `workflows` | Legacy workflow versions, start conditions and optional activity/transition definitions (`wf_workflow_version`) |
| `flows` | Record triggers, operation/condition settings and optional current flow definitions (`sys_flow_record_trigger`, `sys_hub_flow`) |
| `state_models` | State fields, transition conditions and required-field records in supported generic state-model layouts |

Request detail immediately when you already know what you need:

```typescript
const automation = await behavior.discoverTableBehavior('change_request', {
    categories: ['business_rules', 'flows', 'state_models'],
    details: ['scripts', 'definitions', 'dependencies'],
    dependencyDepth: 1,
    maxBytes: 262144,
});
```

Or retrieve up to 50 known references without repeating discovery. References retain their `kind`, `sourceTable` and `sysId`:

```typescript
const references = inventory.categories
    .flatMap(section => section.items.map(item => item.reference))
    .slice(0, 50);

if (references.length > 0) {
    const details = await behavior.getBehaviorDetails(references, {
        details: ['scripts', 'definitions', 'dependencies'],
        dependencyDepth: 1,
        maxBytes: 262144,
    });
    console.log(details.items, details.remainingReferences);
}
```

Direct detail calls also accept known flows (`kind: 'flows'`, `sourceTable: 'sys_hub_flow'`), subflows, actions, Script Includes and decision tables. Use source IDs from your instance; a discovery flow reference can identify its trigger record rather than the flow itself.

**Defaults and output controls:**

- Active configuration and applicable ancestors are included. Use `includeInherited: false` for direct table associations, or `includeInactive: true` for inactive/draft candidates where available.
- All eight categories, 50 items per category (maximum 200), and a 65,536-byte JSON budget. `maxBytes` accepts 4,096–1,048,576 bytes.
- Summaries include conditions and declarative field actions. Script bodies, full definitions and dependencies are opt-in through `details`. `dependencyDepth: 1` requires `dependencies` and expands at most 50 unique dependency references.
- Filter with `categories`, metadata `name`, or up to 50 `sysIds`. `scope` selects the transaction scope for flow definition reads.

Follow each category's `nextCursor` with the same table and filters:

```typescript
const rulePage = await behavior.discoverTableBehavior('change_request', {
    categories: ['business_rules'],
});
const nextCursor = rulePage.categories[0]?.nextCursor;
if (nextCursor) {
    const nextPage = await behavior.discoverTableBehavior('change_request', {
        categories: ['business_rules'],
        cursors: { business_rules: nextCursor },
    });
    console.log(nextPage.categories);
}
```

Inspect category `status`, warnings, item `omittedDetails` and detail-batch `remainingReferences`. Large scripts/definitions are omitted whole; retry narrower batches or increase the byte budget. An empty page can still have a continuation. If even continuation/failure metadata exceeds the budget, the call fails with recovery instructions.

For **Change Management ATF planning**, combine schema fields/choices with UI/data-policy requirements, business-rule conditions, flow triggers and state-transition gates. Retrieve the relevant scripts/definitions, then use those requirements to choose test setup data, roles, transitions and assertions. Client mandatory fields and server enforcement remain separate requirements.

Results describe `accessible_configuration`: account permissions, domain visibility and available metadata limit what can be read. Conditions and scripts are never evaluated, and discovery does not predict execution order across automation types. Runtime flow triggers and current design-time definitions have separate provenance; current definitions may differ from the version that executed. Script-started or non-record-triggered automation is not automatically inferred as a table association.

Live validation covered **Australia** on `dev206299`; **Zurich** remains unverified. See the [Table Behavior guide](docs/TableBehaviorDiscovery.md) for source layouts, compatibility limits, dependency resolution and pagination details.

### Real-Time Log Monitoring

```typescript
import { SyslogReader } from '@sonisoft/now-sdk-ext-core';

const syslogReader = new SyslogReader(instance);

// Method 1: Using ChannelAjax (faster, more efficient)
await syslogReader.startTailingWithChannelAjax({
    interval: 1000, // Poll every second
    onLog: (log) => {
        console.log(`[${log.sequence}] ${log.message}`);
    },
    outputFile: './logs/servicenow.log'
});

// Method 2: Using Table API (supports filtering)
await syslogReader.startTailing('syslog', {
    interval: 5000,
    query: 'level=error^ORDERBYDESCsys_created_on',
    onLog: (log) => {
        console.error(`ERROR: ${log.message}`);
    }
});

// Stop tailing
syslogReader.stopTailing();
```

### Execute Background Scripts

```typescript
import { BackgroundScriptExecutor } from '@sonisoft/now-sdk-ext-core';

const executor = new BackgroundScriptExecutor(instance, 'global');

const script = `
    var gr = new GlideRecord('incident');
    gr.addQuery('active', true);
    gr.query();
    gs.info('Active incidents: ' + gr.getRowCount());
`;

const result = await executor.executeScript(script);
console.log('Script output:', result.output);
```

### Inspect and terminate cluster transactions

Retrieval and termination are deliberately separate operations. A successful kill reports
that ServiceNow accepted the request; call `getTransactions` later to observe eventual removal.

```typescript
import { ClusterTransactionManager } from '@sonisoft/now-sdk-ext-core';

const transactions = new ClusterTransactionManager(instance);
const active = await transactions.getTransactions({
    pollIntervalMs: 1000,
    timeoutMs: 60000,
    limit: 500
});

const selected = active.find((transaction) => transaction.url === '/safe_test.do');
if (selected) {
    await transactions.killTransaction(selected.sys_id);
}
```

Live integration coverage resolves credentials by alias from `@sonisoft/sn-credstore`;
credentials do not belong in the repository or test environment variables. To verify
retrieval against a configured instance:

```bash
SN_INSTANCE_ALIAS=dev281419 node --experimental-vm-modules node_modules/.bin/jest \
  --forceExit --runInBand --testTimeout=240000 --runTestsByPath \
  test/integration/sn/transaction/ClusterTransactionManager_IT.test.ts
```

The termination scenario is deliberately opt-in. First create a safe, disposable
long-running transaction and obtain its exact `sys_id`, then bind both variables to that
same identifier. The test proves the identifier is present, submits only that identifier,
and performs a separate retrieval until removal is observed:

```bash
SN_INSTANCE_ALIAS=dev281419 \
NEX_LIVE_KILL_TRANSACTION_SYS_ID=<safe-transaction-sys-id> \
NEX_LIVE_KILL_CONFIRM=dev281419:<safe-transaction-sys-id> \
node --experimental-vm-modules node_modules/.bin/jest \
  --forceExit --runInBand --testTimeout=240000 --runTestsByPath \
  test/integration/sn/transaction/ClusterTransactionManager_IT.test.ts
```

Do not copy OAuth tokens, passwords, cookies, or the credential-store file into `.env`.
Only the non-secret alias and the one-time safe transaction identifier are inputs.

### Run ATF Tests

```typescript
import { ATFTestExecutor } from '@sonisoft/now-sdk-ext-core';

const testExecutor = new ATFTestExecutor(instance);

// Execute a test suite
const result = await testExecutor.executeTestSuite('test_suite_sys_id', {
    timeout: 300000,
    onProgress: (update) => {
        console.log(`Progress: ${update.progress}% - ${update.status}`);
    }
});

console.log(`Tests passed: ${result.testsPassedCount}/${result.totalTests}`);
```

## 📚 Core Features

### 1. Application Management

Programmatically manage ServiceNow applications, plugins, and updates.

```typescript
import { ApplicationManager, BatchInstallation } from '@sonisoft/now-sdk-ext-core';

const appManager = new ApplicationManager(instance);

// Install from batch definition
const success = await appManager.installBatch('./batch-definition.json');

// Get application details
const appDetails = await appManager.getApplicationDetails('com.example.my_app');

// Check which apps need updates
const needsAction = await appManager.getApplicationsNeedingAction('./batch-definition.json');
```

**Batch Definition Example:**
```json
{
  "packages": [
    {
      "id": "com.snc.sdlc.agile.multi.2.0",
      "type": "plugin",
      "load_demo_data": false
    },
    {
      "id": "sn_cicd_spoke",
      "type": "application", 
      "version": "1.2.3",
      "load_demo_data": false
    }
  ]
}
```

### 2. ATF (Automated Test Framework) Testing

Execute tests and retrieve detailed results programmatically.

```typescript
import { ATFTestExecutor } from '@sonisoft/now-sdk-ext-core';

const testExecutor = new ATFTestExecutor(instance);

// Execute a single test
const result = await testExecutor.executeTest('test_sys_id', {
    timeout: 120000,
    onProgress: (update) => {
        console.log(`Test: ${update.testName} - ${update.status}`);
    }
});

// Execute test suite
const suiteResult = await testExecutor.executeTestSuite('suite_sys_id', {
    timeout: 600000,
    pollInterval: 5000
});

// Get detailed results
console.log(`Pass Rate: ${(suiteResult.testsPassedCount / suiteResult.totalTests * 100).toFixed(2)}%`);
console.log(`Failed Tests:`, suiteResult.testResults.filter(t => t.status === 'failure'));
```

### 3. Syslog Reading & Monitoring

Two methods for log monitoring, each optimized for different use cases.

#### ChannelAjax Method (Recommended for Real-Time)

**Benefits:**
- ⚡ Faster (1s default polling vs 5s)
- 🎯 100% reliable (sequence-based tracking)
- 💪 Minimal server load
- ✅ No duplicates or missed logs

```typescript
import { SyslogReader } from '@sonisoft/now-sdk-ext-core';

const syslogReader = new SyslogReader(instance);

await syslogReader.startTailingWithChannelAjax({
    interval: 1000,
    onLog: (log) => {
        const timestamp = new Date(log.sys_created_on).toLocaleString();
        console.log(`[${timestamp}] [Seq:${log.sequence}] ${log.message}`);
    },
    outputFile: './logs/tail.log'
});
```

#### Table API Method (Supports Filtering)

**Benefits:**
- 🔍 Server-side filtering with encoded queries
- 📋 Access to syslog_app_scope table
- 🎨 Custom field selection
- 📊 Rich formatting options

```typescript
await syslogReader.startTailing('syslog', {
    interval: 5000,
    query: 'level=error^sys_created_on>javascript:gs.minutesAgoStart(10)',
    onLog: (log) => {
        if (log.level === 'error') {
            sendAlert(log);
        }
    },
    formatOptions: {
        fields: ['sys_created_on', 'level', 'source', 'message'],
        dateFormat: 'relative',
        maxMessageWidth: 100
    }
});
```

#### Query and Export Logs

```typescript
// Query recent errors
const errors = await syslogReader.querySyslog(
    'level=error^ORDERBYDESCsys_created_on',
    50
);

// Print formatted table
syslogReader.printTable(errors, {
    fields: ['sys_created_on', 'level', 'source', 'message'],
    maxMessageWidth: 80
});

// Export to file
await syslogReader.saveToFile(errors, './logs/errors.json', 'json');
await syslogReader.saveToFile(errors, './logs/errors.csv', 'csv');
await syslogReader.saveToFile(errors, './logs/errors.txt', 'table');
```

### 4. AMB (Asynchronous Message Bus)

Monitor real-time events and record changes via WebSocket.

```typescript
import { AMBClient, MessageClientBuilder } from '@sonisoft/now-sdk-ext-core';

const builder = new MessageClientBuilder();
const subscriptions = builder.buildClientSubscriptions();
const client = new AMBClient(subscriptions, instance);

// Authenticate and connect
await client.authenticate();
client.connect();

// Watch for incident changes
const channel = client.getRecordWatcherChannel('incident', 'active=true', null, {
    subscriptionCallback: (message) => {
        console.log('Incident updated:', message);
    }
});

channel.subscribe((message) => {
    console.log('Change detected:', message);
});

// Disconnect when done
client.disconnect();
```

### 5. Table API Operations

Full CRUD operations on ServiceNow tables.

```typescript
import { TableAPIRequest } from '@sonisoft/now-sdk-ext-core';

const tableAPI = new TableAPIRequest(instance);

// Create a record
const createResponse = await tableAPI.post('incident', {}, {
    short_description: 'Test incident',
    urgency: '2',
    impact: '2'
});

// Read records
const readResponse = await tableAPI.get('incident', {
    sysparm_query: 'active=true',
    sysparm_limit: 10
});

// Update a record
const updateResponse = await tableAPI.put('incident', 'sys_id_here', {
    state: '6', // Resolved
    close_notes: 'Issue resolved'
});

// Partial update
const patchResponse = await tableAPI.patch('incident', 'sys_id_here', {
    work_notes: 'Added update via API'
});
```

### 6. Background Script Execution

Execute server-side GlideScript with full control.

```typescript
import { BackgroundScriptExecutor } from '@sonisoft/now-sdk-ext-core';

const executor = new BackgroundScriptExecutor(instance, 'global');

// Execute script
const result = await executor.executeScript(`
    var gr = new GlideRecord('sys_user');
    gr.addQuery('active', true);
    gr.addQuery('last_login', '>', gs.daysAgoStart(30));
    gr.query();
    
    var count = gr.getRowCount();
    gs.info('Active users (last 30 days): ' + count);
    
    return count;
`);

console.log('Script output:', result.output);
console.log('Return value:', result.result);
```

## 📖 API Reference

### Core Classes

- **`ServiceNowInstance`** - Instance connection and configuration
- **`ServiceNowRequest`** - HTTP request handling with authentication
- **`TableAPIRequest`** - ServiceNow Table API wrapper (CRUD)

### Application Management

- **`ApplicationManager`** - Install, upgrade, and validate applications via batch definitions
- **`AppRepoApplication`** - App repository operations
- **`CompanyApplications`** - Store application search, install, update, and progress tracking

### Scope & Configuration

- **`ScopeManager`** - Set/get current application scope, list and retrieve applications
- **`UpdateSetManager`** - Create, clone, inspect, move records, and manage update sets

### Testing & Automation

- **`ATFTestExecutor`** - ATF test execution and monitoring with progress tracking
- **`BackgroundScriptExecutor`** - Server-side GlideScript execution

### Code & Schema

- **`CodeSearch`** - Search across platform code by term, app, or table
- **`SchemaDiscovery`** - Discover table schemas, explain fields, validate catalog items
- **`TableBehaviorDiscovery`** - Read table automation, policy requirements and state gates; retrieve scripts, definitions and bounded dependencies in batches
- **`BEHAVIOR_CATEGORIES`, `BehaviorReference`, `TableBehaviorOptions`, `BehaviorDetailOptions`** - Category constants and typed inputs shared by consumers
- **`TableBehaviorResult`, `BehaviorDetailsResult`** - Configuration, provenance, warnings and continuation metadata

### Data Operations

- **`AttachmentManager`** - Upload, list, and retrieve file attachments
- **`BatchOperations`** - Sequential bulk create/update with variable substitution
- **`QueryBatchOperations`** - Query-based bulk update/delete with dry-run safety

### Workflow & Task

- **`WorkflowManager`** - Create complete workflows with activities, transitions, and conditions
- **`TaskOperations`** - Add comments, assign tasks, resolve/close incidents, approve changes

### Scripting

- **`ScriptSync`** - Bidirectional sync of Script Includes, Business Rules, and more

### Monitoring & Discovery

- **`AggregateQuery`** - COUNT, AVG, MIN, MAX, SUM with GROUP BY via Stats API
- **`InstanceHealth`** - Version, cluster nodes, stuck jobs, semaphores, operational counts
- **`CMDBRelationships`** - Query direct relationships and traverse CI graphs (BFS)
- **`InstanceDiscovery`** - List tables, scoped apps, store apps, and plugins

### Permission policy

Core can refuse operations that would change a ServiceNow instance. **It is inert until
an application installs a policy**, so importing this library changes nothing — the
`nex` CLI and the MCP server install one at startup because those are the surfaces an
AI agent drives.

```typescript
import { installPolicy, denyLayer, grantLayer } from '@sonisoft/now-sdk-ext-core';

installPolicy([
    denyLayer('lockdown', ['write']),                  // highest priority
    grantLayer('default', ['write', 'execute']),       // lowest
]);
```

Two verbs — `write` and `execute` — plus a `target` of `instance`, `local` or `session`.
Only `instance` is gated, so a tool that overwrites a local file is not refused as an
instance write. Layers are consulted in order and the first to answer `grant` or `deny`
decides; `abstain` passes the question down.

Reads are never gated.

> **This is a guardrail, not a security boundary.** Anything holding the credential can
> reach the instance directly — by calling the SDK, or with curl. What it buys is that
> inadvertent mutation stops being silent, and that an environment variable can deny in
> a way the calling code cannot override.

#### Script scanning, and what it cannot see

Background scripts are parsed to decide whether they need `write` on top of `execute`.
Anything unresolvable — computed member access like `gr['inse'+'rt']()`, `eval`, or a
parse failure — escalates to `write` rather than passing.

**A `write`-free result means "nothing obviously writes", not "this cannot write."**
These are invisible to any static scan:

- Script Includes — `new global.MyUtil().doThing()`, where the write is in another file
- `gs.eval(...)`
- `sn_ws.RESTMessageV2` calling out to anything
- `workflow.startFlow()`, `gs.getUser().setPreference()`
- a `GlideRecord` reached through a variable the scan never resolves

That is why `execute` is required regardless of what the scan concludes: permitting a
script to run at all is the real decision.

### Logging & Real-time Events

- **`SyslogReader`** - Log querying, formatting, export, and real-time tailing
- **`AMBClient`** - WebSocket-based real-time event subscriptions
- **`MessageClientBuilder`** - AMB client configuration

### Utilities

- **`Logger`** - Winston-based structured logging (stderr by default; file output is opt-in)
- **`configureLogging`** - sets destination, level, and rotation for the whole process
- **`NowStringUtil`** - String manipulation utilities
- **`AppUtil`** - Application utility functions

## 🎯 Use Cases

### CI/CD Pipeline Integration

```typescript
// Install required apps before deployment
const appManager = new ApplicationManager(instance);
await appManager.installBatch('./required-apps.json');

// Run tests
const testExecutor = new ATFTestExecutor(instance);
const testResults = await testExecutor.executeTestSuite('deployment_test_suite');

if (testResults.testsPassedCount !== testResults.totalTests) {
    throw new Error('Tests failed, aborting deployment');
}
```

### Log Analysis & Monitoring

```typescript
// Real-time error monitoring with alerts
const syslogReader = new SyslogReader(instance);

await syslogReader.startTailing('syslog', {
    query: 'level=error',
    onLog: async (log) => {
        if (log.message.includes('OutOfMemory')) {
            await sendPageAlert('Critical: OOM detected');
        }
        await saveToElasticsearch(log);
    }
});
```

### Data Migration Scripts

```typescript
const executor = new BackgroundScriptExecutor(instance, 'global');
const tableAPI = new TableAPIRequest(instance);

// Export data
const response = await tableAPI.get('custom_table', {
    sysparm_limit: 1000,
    sysparm_query: 'sys_created_on>2024-01-01'
});

// Process and transform
const records = response.bodyObject.result;
// ... transformation logic ...

// Import to another instance
for (const record of transformedRecords) {
    await targetTableAPI.post('target_table', {}, record);
}
```

## 📋 Command-Line Tools

The library includes ready-to-use CLI tools:

### Log Tailing (ChannelAjax)
```bash
node docs/examples/syslog-tail-channel.mjs your-instance ./logs/tail.log 1000
```

### Log Tailing (Table API)
```bash
node docs/examples/syslog-tail.mjs your-instance error ./logs/errors.log
```

## 📚 Documentation

Comprehensive documentation is available in the `/docs` directory:

**Getting Started:**
- **[Getting Started](./docs/GettingStarted.md)** - Setup and basic usage
- **[API Reference](./docs/APIReference.md)** - Complete API documentation
- **[Examples](./docs/examples/)** - Working code examples

**Application & Scope Management:**
- **[Application Manager](./docs/ApplicationManager.md)** - Application management guide
- **[Store Applications](./docs/CompanyApplications.md)** - Store app search, install, and update
- **[Scope Manager](./docs/ScopeManager.md)** - Application scope management
- **[Update Set Manager](./docs/UpdateSetManager.md)** - Update set lifecycle management

**Code, Schema & Search:**
- **[Code Search](./docs/CodeSearch.md)** - Platform code search
- **[Schema Discovery](./docs/SchemaDiscovery.md)** - Table schema and field discovery
- **[Table Behavior Discovery](./docs/TableBehaviorDiscovery.md)** - Rules, UI/client behavior, policies, workflows, flow triggers and state models

**Data Operations:**
- **[Attachment Manager](./docs/AttachmentManager.md)** - File attachment operations
- **[Batch Operations](./docs/BatchOperations.md)** - Bulk create/update with variable substitution
- **[Query Batch Operations](./docs/QueryBatchOperations.md)** - Query-based bulk update/delete

**Workflow, Task & Scripting:**
- **[Workflow Manager](./docs/WorkflowManager.md)** - Programmatic workflow creation
- **[Task Operations](./docs/TaskOperations.md)** - ITSM task management
- **[Script Sync](./docs/ScriptSync.md)** - Bidirectional script synchronization

**Monitoring & Discovery:**
- **[Aggregate Query](./docs/AggregateQuery.md)** - Stats API aggregations
- **[Instance Health](./docs/InstanceHealth.md)** - Health monitoring
- **[CMDB Relationships](./docs/CMDBRelationships.md)** - CI relationship graph traversal
- **[Instance Discovery](./docs/InstanceDiscovery.md)** - Table, app, and plugin discovery

**Testing & Logging:**
- **[ATF Test Executor](./docs/ATFTestExecutor.md)** - Testing automation
- **[Syslog Reader](./docs/SyslogReader.md)** - Log monitoring guide
- **[ChannelAjax Tailing](./docs/SyslogReaderChannelAjax.md)** - Advanced log tailing

## 🔧 Advanced Configuration

### Custom Request Handlers

```typescript
import { RequestHandler, ServiceNowInstance } from '@sonisoft/now-sdk-ext-core';

const handler = new RequestHandler(instance, {
    timeout: 30000,
    maxRetries: 3,
    retryDelay: 1000
});
```

### Logging

Logging goes to **stderr at `warn` and above**, and **writes no files by default** —
stdout is left clean for `--json` output and for MCP's JSON-RPC framing.

```typescript
import { Logger } from '@sonisoft/now-sdk-ext-core';

const logger = new Logger('MyApp');
logger.info('Application started');
logger.error('Error occurred', { details: errorObj });
```

Named credential fields and recognized token patterns are redacted in metadata and
message text. Pass structured metadata and avoid interpolating secrets into messages.

#### Turning on file logging

The application that owns the entry point configures logging once, at boot. Libraries
should not call this.

```typescript
import { configureLogging, flushLogs } from '@sonisoft/now-sdk-ext-core';

configureLogging({
    file: true,        // default false
    level: 'debug',    // default 'info'
    dir: './logs',     // default ~/.local/state/now-sdk-ext/logs (honours XDG_STATE_HOME)
});

// Winston buffers; process.exit() would drop the tail.
await flushLogs();
```

`flushLogs()` waits for the underlying file output to finish within a bounded timeout before returning. Await it before an explicit process exit; existing `Logger` instances remain usable after a flush.

Equivalent environment variables, honoured with no code change — this is how the MCP
server is configured, since it has no flags:

| Variable | Effect |
| --- | --- |
| `NEX_LOG_FILE` | `1`/`true` enables file logging |
| `NEX_LOG_DIR` | Directory for log files. Implies `NEX_LOG_FILE` |
| `NEX_LOG_LEVEL` | `error`, `warn`, `info`, `http`, `verbose`, `debug`, `silly` |

Explicit `configureLogging()` arguments win over the environment, which wins over the
defaults. Files rotate at 10 MB, keeping 5.

### Authentication Handler

```typescript
import { NowSDKAuthenticationHandler } from '@sonisoft/now-sdk-ext-core';

const authHandler = new NowSDKAuthenticationHandler(
    'instance-alias',
    credential
);

const token = await authHandler.getToken();
```

## 🤝 TypeScript Support

The library is written in TypeScript and includes full type definitions:

```typescript
import type {
    ServiceNowInstance,
    SyslogRecord,
    ATFTestResult,
    ApplicationDetailModel,
    BatchDefinition
} from '@sonisoft/now-sdk-ext-core';
```

## 🐛 Error Handling

```typescript
import { 
    FileException, 
    InvalidParameterException 
} from '@sonisoft/now-sdk-ext-core';

try {
    await appManager.installBatch('./batch.json');
} catch (error) {
    if (error instanceof FileException) {
        console.error('File not found:', error.message);
    } else if (error instanceof InvalidParameterException) {
        console.error('Invalid parameter:', error.message);
    } else {
        console.error('Unexpected error:', error);
    }
}
```

## ⚡ Performance Tips

1. **Use ChannelAjax for log tailing** - 5x faster than Table API polling
2. **Batch operations** - Group multiple API calls when possible
3. **Adjust poll intervals** - Balance responsiveness vs. API load
4. **Use encoded queries** - Server-side filtering is more efficient
5. **Implement retry logic** - Handle transient network issues

## 🔒 Security Best Practices

1. **Never hardcode credentials** - Use ServiceNow CLI authentication
2. **Use environment variables** - For configuration
3. **Implement role-based access** - Verify user permissions
4. **Audit API usage** - Log all operations
5. **Use HTTPS** - Always use secure connections

## 📦 Dependencies

- `@servicenow/sdk` 4.3.0 / `@servicenow/sdk-cli` 4.3.0 / `@servicenow/sdk-core` 4.3.0 - ServiceNow SDK and CLI tools
- `axios` - HTTP client
- `cometd` / `cometd-nodejs-client` - WebSocket support for AMB
- `winston` - Logging
- `xml2js` / `fast-xml-parser` - XML parsing
- `ws` - WebSocket client
- `zod` - Runtime schema validation
- `lodash` - Utility functions

## 🧪 Testing

```bash
# Run all tests
npm test

# Run specific test suite
npm test -- --testPathPattern=SyslogReader

# Run with coverage
npm test -- --coverage
```

## 🏗️ Building from Source

```bash
# Clone the repository
git clone <repository-url>

# Install dependencies
npm install

# Build TypeScript
npm run buildts

# Run tests
npm test

# Create package
npm pack
```

## 📝 License

MIT License - see LICENSE file for details

## 🙏 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Submit a pull request

## 📞 Support

For issues, questions, or contributions:

- 📧 Create an issue in the repository
- 📖 Check the documentation in `/docs`
- 💬 Review existing examples in `/docs/examples`

## 🗺️ Roadmap

- [ ] GraphQL API support
- [ ] Webhook integration
- [ ] Performance metrics dashboard
- [ ] Standalone CLI tool package
- [ ] Plugin development tools

---

**Made with ❤️ for the ServiceNow Developer Community**

## Browser sessions and automatic renewal

`createBrowserSession({alias})` resolves a stored SDK alias, refreshes OAuth through
the SDK, and returns `{alias, instanceUrl, createdAt, oauthExpiresAt, storageState}`.
`createdAt` is milliseconds; `oauthExpiresAt` is UNIX seconds and only a renewal hint.
`storageState` is secret and directly compatible with Playwright:

```ts
const store = await initCredentialStore();
if (!store.active) throw new Error('Headless credential storage is required');
const session = await createBrowserSession({alias: 'dev206299'});
const context = await browser.newContext({storageState: session.storageState});
```

Check `initCredentialStore().active` when the application requires the headless
backend. Imports alone never install the shim. Keep session state out of logs and
source control. A saved state file does not renew itself.

When upgrading a shared store, stop all clients first, upgrade every client
(including standalone `now-sdk-x`) to sn-credstore 1.1.1 or later, then restart.
The new lock protocol cannot safely run alongside older clients.

Long-running embedders can supply a `credentialProvider` in
`ServiceNowSettingsInstance`:

```ts
const credentialProvider = () => resolveSessionCredentials('dev206299');
const instance = new ServiceNowInstance({
    alias: 'dev206299',
    credentialProvider,
});
```

An initial `credential` is optional. When supplied, its origin constrains the first
provider result. Otherwise, the first successful login establishes the origin;
renewal cannot change it, even if a provider reuses a mutable credential object.

Requests renew credentials/session cookies before expiry. An authentication failure
can retry an ordinary read once; writes and stateful workflows are never replayed.
Impersonation/debugger sessions are pinned and report expiry rather than silently
losing workflow state. A provider resolving to a different origin is refused.
Pinning lasts for the handler's lifetime, including after stopping impersonation
or debugging. At a safe workflow boundary, create a new `ServiceNowInstance` to
start a fresh session. Reusing the same alias on that new instance is supported.

`SessionAuthError.code` distinguishes invalid configuration, changed origin,
temporary renewal failure, session expiry, and rejected OAuth renewal requiring login.
Inspect the code structurally across package copies. Alias-based helpers reject SDK
environment credentials that would silently override the alias.
