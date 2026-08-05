# ServiceNow SDK Extensions Core

[![npm version](https://img.shields.io/npm/v/@sonisoft/now-sdk-ext-core.svg)](https://www.npmjs.com/package/@sonisoft/now-sdk-ext-core)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)

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

- Node.js 18.x or higher
- ServiceNow CLI configured with instance credentials
- TypeScript 5.x or higher (optional, for TypeScript projects)

### ServiceNow CLI Setup

```bash
# Install ServiceNow CLI globally
npm install -g @servicenow/sdk

# Configure your instance credentials
snc configure profile set
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
> snc configure profile set
> # — or —
> npx @servicenow/sdk auth --add <your-alias>
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

Credential material is stripped from both metadata and the message text before anything
is written, so passing a whole request config or session object is safe.

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
