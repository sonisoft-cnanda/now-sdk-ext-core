# ScriptTracer

Real-time server-side script tracing for ServiceNow instances via the AMB (Asynchronous Message Bus) protocol.

## Overview

ScriptTracer connects to the ServiceNow JS Debugger and Script Tracer REST APIs, then subscribes to AMB channels to receive live trace data as server-side scripts execute. This enables programmatic inspection of script execution — which scripts run, in what order, and what field changes they produce.

## Architecture

```
ScriptTracer
  ├── REST: POST /api/now/js/debugger/start    → obtains debug session token
  ├── REST: POST /api/now/js/scripttracer/start → activates tracing
  ├── AMB:  /scripttracer/{sessionId}           → trace statements
  ├── AMB:  /debugger/watcher/console/{sid}     → console output
  ├── AMB:  /debugger/watcher/{sid}             → debug watcher events
  └── AMB:  /debugger/sessionlog/{sid}          → session log events
```

### Components

| Component | Purpose |
|-----------|---------|
| `ScriptTracer` | Orchestrates the trace lifecycle (start/stop) and aggregates results |
| `ScriptTracerModels` | TypeScript interfaces for trace statements, AMB messages, and options |
| `SessionManager` | Singleton HTTP session registry — ensures one authenticated session per instance alias |
| `AMBClient` | Underlying WebSocket/CometD transport for real-time channel subscriptions |

## Usage

```typescript
import { AMBClient } from "../amb/AMBClient";
import { ScriptTracer } from "./ScriptTracer";

// Authenticate and connect AMB
const ambClient = new AMBClient();
await ambClient.authenticate(instance);
await ambClient.connect();

// Start tracing
const tracer = new ScriptTracer(ambClient, instance, {
    onTrace: (statements) => {
        for (const stmt of statements) {
            console.log(`${stmt.fileName}:${stmt.linesContext.currentLineNumber} [${stmt.tableName}]`);
        }
    },
    onConsole: (msg) => console.log("Console:", msg.data.message),
});

const result = await tracer.start();
// ... trigger server-side script execution ...
const stopResult = await tracer.stop();

console.log(`Captured ${tracer.traceStatements.length} trace statements`);
```

## Trace Statement Structure

Each `TraceStatement` contains:

| Field | Description |
|-------|-------------|
| `scriptField` | The field containing the script (e.g. `script`, `condition`) |
| `fileName` | Script name / sys_id |
| `fileTypeLabel` | Type label (e.g. "Business Rule", "Script Include") |
| `tableName` / `tableLabel` | Table the script operates on |
| `linesContext` | Current line number, start line, and surrounding code content |
| `diff` | Array of field changes (`{ name, previous, value }`) |
| `state` | Arbitrary state snapshot at time of trace |

## State Machine

```
idle → starting → tracing → stopping → stopped
                    ↓
                  error
```

- `start()` throws if already in `tracing` state
- `stop()` throws if not in `tracing` state
- On failure, state transitions to `error`

## SessionManager

`SessionManager` is a singleton registry that deduplicates HTTP sessions by instance alias. All components targeting the same instance share one `ServiceNowRequest`, avoiding redundant authentication.

```typescript
// Automatically reuses existing session or creates a new one
const req = SessionManager.getInstance().getRequest(instance);

// Ensure authenticated before making calls
const authReq = await SessionManager.getInstance().getAuthenticatedRequest(instance);
```

## Using with ActiveSessionRegistry (MCP / CLI)

Script tracing is a multi-step workflow: start tracing, execute operations, collect results, stop tracing. Since MCP tools and CLI commands are stateless between invocations, the `ActiveSessionRegistry` provides a unique session ID that callers pass back on subsequent operations.

```typescript
import { ActiveSessionRegistry } from '@sonisoft/now-sdk-ext-core';

// Start: create tracer, register session, return ID to caller
const registry = ActiveSessionRegistry.getInstance();
const sessionId = registry.createSession({
    type: 'script-tracer',
    instanceAlias: 'dev01',
    resources: { scriptTracer: tracer, ambClient: ambClient },
    ttlMs: 30 * 60 * 1000,
});

// Later: caller passes sessionId back to retrieve the tracer
const tracer = registry.getResource<ScriptTracer>(sessionId, 'scriptTracer');
console.log(tracer.traceStatements);

// Cleanup
await tracer.stop();
ambClient.disconnect();
registry.destroySession(sessionId);
```

See [ActiveSessionRegistry documentation](../ActiveSessionRegistry.md) for the full MCP and CLI implementation guide.
