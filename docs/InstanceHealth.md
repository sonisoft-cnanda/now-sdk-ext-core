# InstanceHealth

The `InstanceHealth` class provides a consolidated health check for a ServiceNow instance, covering version info, cluster status, stuck jobs, semaphores, and operational counts.

## Table of Contents

- [Overview](#overview)
- [Constructor](#constructor)
- [Methods](#methods)
- [Interfaces](#interfaces)
- [Examples](#examples)
- [Best Practices](#best-practices)
- [Related](#related)

## Overview

The `InstanceHealth` enables you to:

- Run a consolidated health check across multiple subsystems in a single call
- Retrieve instance version and build information
- Monitor cluster node status across all nodes
- Detect stuck scheduled jobs with configurable thresholds
- Track active semaphore counts
- Collect operational counts for incidents, changes, and problems
- Get a human-readable summary of overall instance health

## Constructor

```typescript
constructor(instance: ServiceNowInstance, aggregateQuery?: AggregateQuery)
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `instance` | `ServiceNowInstance` | Yes | The ServiceNow instance connection |
| `aggregateQuery` | `AggregateQuery` | No | Optional custom AggregateQuery instance; one is created automatically if omitted |

### Example

```typescript
import { ServiceNowInstance, InstanceHealth } from '@sonisoft/now-sdk-ext-core';

const health = new InstanceHealth(instance);
```

## Methods

### checkHealth

Run a consolidated health check on the instance. Each sub-check is isolated -- a failure in one does not affect others. Sub-checks that fail return `null` for their result.

```typescript
async checkHealth(options?: HealthCheckOptions): Promise<HealthCheckResult>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `options` | `HealthCheckOptions` | Options to control which checks are run. All checks are enabled by default. |

#### HealthCheckOptions

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `includeVersion` | `boolean` | `true` | Include instance version info from sys_properties |
| `includeCluster` | `boolean` | `true` | Include cluster node status from sys_cluster_state |
| `includeStuckJobs` | `boolean` | `true` | Include stuck job detection from sys_trigger. A read, so it still runs under `--read-only` |
| `includeSemaphores` | `boolean` | `true` | Include active semaphore count from sys_semaphore |
| `includeOperationalCounts` | `boolean` | `true` | Include operational counts (incidents, changes, problems) |
| `stuckJobThresholdMinutes` | `number` | `30` | Threshold in minutes for a job to be considered "stuck" |

#### Returns

`Promise<HealthCheckResult>` containing:
- `timestamp`: ISO 8601 timestamp of when the check ran
- `version`: Instance version information (or `null` if skipped/failed)
- `clusterNodes`: Array of cluster node statuses (or `null` if skipped/failed)
- `stuckJobs`: Array of stuck job records (or `null` if skipped/failed)
- `activeSemaphoreCount`: Number of active semaphores (or `null` if skipped/failed)
- `operationalCounts`: Open incident, change, and problem counts (or `null` if skipped/failed)
- `summary`: Human-readable summary string

#### Example

```typescript
const result = await health.checkHealth();

console.log(`Timestamp: ${result.timestamp}`);
console.log(`Summary: ${result.summary}`);

if (result.version) {
    console.log(`Version: ${result.version.version}`);
    console.log(`Build: ${result.version.buildTag}`);
}

if (result.stuckJobs && result.stuckJobs.length > 0) {
    console.warn(`Found ${result.stuckJobs.length} stuck jobs!`);
}
```

## Interfaces

### HealthCheckOptions

```typescript
interface HealthCheckOptions {
    /** Include instance version info from sys_properties. Defaults to true. */
    includeVersion?: boolean;

    /** Include cluster node status from sys_cluster_state. Defaults to true. */
    includeCluster?: boolean;

    /** Include stuck job detection from sys_trigger. Defaults to true. */
    includeStuckJobs?: boolean;

    /** Include active semaphore count from sys_semaphore. Defaults to true. */
    includeSemaphores?: boolean;

    /** Include operational counts (incidents, changes, problems). Defaults to true. */
    includeOperationalCounts?: boolean;

    /** Threshold in minutes for a job to be considered "stuck". Defaults to 30. */
    stuckJobThresholdMinutes?: number;
}
```

### HealthCheckResult

```typescript
interface HealthCheckResult {
    /** Timestamp of the health check */
    timestamp: string;

    /** Instance version information (null if check failed or was skipped) */
    version: InstanceVersionInfo | null;

    /** Cluster node statuses (null if check failed or was skipped) */
    clusterNodes: ClusterNodeStatus[] | null;

    /** Stuck jobs (null if check failed or was skipped) */
    stuckJobs: StuckJobRecord[] | null;

    /** Number of active semaphores (null if check failed or was skipped) */
    activeSemaphoreCount: number | null;

    /** Operational counts (null if check failed or was skipped) */
    operationalCounts: OperationalCounts | null;

    /** Summary string describing overall health */
    summary: string;
}
```

### InstanceVersionInfo

```typescript
interface InstanceVersionInfo {
    /** The WAR version (glide.war) */
    version?: string | null;

    /** Build date (glide.build.date) */
    buildDate?: string | null;

    /** Build tag (glide.build.tag) */
    buildTag?: string | null;
}
```

### ClusterNodeStatus

```typescript
interface ClusterNodeStatus {
    /** The system ID */
    sys_id: string;

    /** The node ID */
    node_id?: string;

    /** The node status */
    status?: string;

    /** System updated on */
    sys_updated_on?: string;

    /** Additional fields */
    [key: string]: unknown;
}
```

### StuckJobRecord

```typescript
interface StuckJobRecord {
    /** The system ID */
    sys_id: string;

    /** Name of the trigger */
    name?: string;

    /** The next scheduled action time */
    next_action?: string;

    /** The state of the trigger */
    state?: string;

    /** Additional fields */
    [key: string]: unknown;
}
```

### OperationalCounts

```typescript
interface OperationalCounts {
    /** Number of open incidents */
    openIncidents?: number | null;

    /** Number of open change requests */
    openChanges?: number | null;

    /** Number of open problems */
    openProblems?: number | null;
}
```

## Examples

### Example 1: Full Health Check

```typescript
async function runFullHealthCheck() {
    const health = new InstanceHealth(instance);
    const result = await health.checkHealth();

    console.log('=== Instance Health Check ===');
    console.log(`Time: ${result.timestamp}`);
    console.log(`Summary: ${result.summary}`);

    if (result.version) {
        console.log(`\nVersion: ${result.version.version || 'unknown'}`);
        console.log(`Build Date: ${result.version.buildDate || 'unknown'}`);
        console.log(`Build Tag: ${result.version.buildTag || 'unknown'}`);
    }

    if (result.clusterNodes) {
        console.log(`\nCluster Nodes: ${result.clusterNodes.length}`);
        for (const node of result.clusterNodes) {
            console.log(`  Node ${node.node_id}: ${node.status}`);
        }
    }

    if (result.stuckJobs && result.stuckJobs.length > 0) {
        console.log(`\nStuck Jobs: ${result.stuckJobs.length}`);
        for (const job of result.stuckJobs) {
            console.log(`  ${job.name} (next_action: ${job.next_action})`);
        }
    } else {
        console.log('\nNo stuck jobs detected.');
    }

    if (result.operationalCounts) {
        console.log('\nOperational Counts:');
        console.log(`  Open Incidents: ${result.operationalCounts.openIncidents ?? 'N/A'}`);
        console.log(`  Open Changes: ${result.operationalCounts.openChanges ?? 'N/A'}`);
        console.log(`  Open Problems: ${result.operationalCounts.openProblems ?? 'N/A'}`);
    }
}
```

### Example 2: Targeted Health Check

```typescript
async function checkForStuckJobs() {
    const health = new InstanceHealth(instance);

    // Only check for stuck jobs with a 15-minute threshold
    const result = await health.checkHealth({
        includeVersion: false,
        includeCluster: false,
        includeSemaphores: false,
        includeOperationalCounts: false,
        includeStuckJobs: true,
        stuckJobThresholdMinutes: 15
    });

    if (result.stuckJobs && result.stuckJobs.length > 0) {
        console.error(`ALERT: ${result.stuckJobs.length} jobs stuck for over 15 minutes`);
        for (const job of result.stuckJobs) {
            console.error(`  - ${job.name} (sys_id: ${job.sys_id})`);
        }
        process.exit(1);
    }

    console.log('No stuck jobs detected.');
}
```

### Example 3: Periodic Monitoring

```typescript
async function monitorInstance(intervalMs: number = 60000) {
    const health = new InstanceHealth(instance);

    const check = async () => {
        try {
            const result = await health.checkHealth();
            const timestamp = new Date().toISOString();
            console.log(`[${timestamp}] ${result.summary}`);

            if (result.stuckJobs && result.stuckJobs.length > 5) {
                console.warn(`[${timestamp}] WARNING: ${result.stuckJobs.length} stuck jobs`);
            }

            if (result.activeSemaphoreCount !== null && result.activeSemaphoreCount > 50) {
                console.warn(`[${timestamp}] WARNING: ${result.activeSemaphoreCount} active semaphores`);
            }
        } catch (err) {
            console.error(`Health check failed: ${err}`);
        }
    };

    // Run immediately, then on interval
    await check();
    setInterval(check, intervalMs);
}
```

## Best Practices

1. **Use Selective Checks**: Disable checks you do not need to reduce API calls and improve response time
2. **Adjust Stuck Job Threshold**: The default 30-minute threshold may not suit all environments; tune `stuckJobThresholdMinutes` based on your instance's workload
3. **Handle Null Results Gracefully**: Each sub-check can return `null` independently if it fails or is skipped; always check for `null` before accessing nested properties
4. **Monitor the Summary**: The `summary` string provides a quick one-line overview suitable for logging or alerting
5. **Inject AggregateQuery for Testing**: Pass a custom `AggregateQuery` via the constructor to facilitate unit testing or to reuse a shared instance
6. **Log Health Checks**: Store health check results over time to identify trends in stuck jobs, semaphore counts, and operational volumes

## Related

- [Getting Started Guide](./GettingStarted.md)
- [AggregateQuery](./AggregateQuery.md)
- [InstanceDiscovery](./InstanceDiscovery.md)
- [API Reference](./APIReference.md)
- [Examples](./Examples.md)
