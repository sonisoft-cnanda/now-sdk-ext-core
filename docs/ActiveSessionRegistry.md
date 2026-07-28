# ActiveSessionRegistry

Singleton registry for stateful workflow sessions that span multiple operations.

## Problem

Both the MCP server and CLI are effectively stateless between invocations:

- **MCP tools** are one-shot RPC calls. The caller (e.g., an AI agent) has no access to in-process state between tool calls.
- **CLI commands** run as separate process invocations (each `nex` command is independent).

Some workflows require multiple steps that share the same session context:

| Workflow | Steps |
|----------|-------|
| **Script Tracing** | Start tracing -> execute script (same session) -> get trace results -> stop tracing |
| **Impersonation** (future) | Enable impersonation -> execute operations as impersonated user -> disable impersonation |

The `ActiveSessionRegistry` solves this by assigning a unique ID to each workflow session, allowing subsequent operations to reference and reuse the same stateful resources.

## How It Relates to SessionManager

| Component | Scope | Keyed By | Stores |
|-----------|-------|----------|--------|
| `SessionManager` | HTTP session deduplication | Instance alias | `ServiceNowRequest` (cookies, CSRF tokens) |
| `ActiveSessionRegistry` | Workflow session lifecycle | UUID | Any resources (ScriptTracer, AMBClient, etc.) |

They complement each other. `SessionManager` ensures one HTTP session per instance. `ActiveSessionRegistry` bundles higher-level stateful resources under an ID that can be passed across tool/command boundaries.

## API

```typescript
import { ActiveSessionRegistry } from '@sonisoft/now-sdk-ext-core';

const registry = ActiveSessionRegistry.getInstance();
```

### `createSession(options): string`

Create a new session and return its UUID.

```typescript
const sessionId = registry.createSession({
    type: 'script-tracer',
    instanceAlias: 'dev01',
    resources: {
        scriptTracer: tracer,
        ambClient: ambClient,
    },
    ttlMs: 30 * 60 * 1000, // optional: 30-minute idle timeout
});
// sessionId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
```

### `getSession(id): ActiveSession | null`

Retrieve a session by ID. Returns `null` if not found or expired. Updates `lastAccessedAt`.

### `getResource<T>(sessionId, key): T | null`

Typed convenience for retrieving a single resource.

```typescript
const tracer = registry.getResource<ScriptTracer>(sessionId, 'scriptTracer');
```

### `setResource(sessionId, key, value): boolean`

Attach or update a resource on an existing session.

### `destroySession(id): boolean`

Remove a session and all its resources. Callers are responsible for cleanup (e.g., stopping a `ScriptTracer`, disconnecting an `AMBClient`) before calling this.

### `listSessions(filter?): ActiveSession[]`

List active sessions, optionally filtered by `type` and/or `instanceAlias`. Expired sessions are evicted during listing.

## ActiveSession Interface

```typescript
interface ActiveSession {
    readonly id: string;           // UUID v4
    readonly type: string;         // e.g., 'script-tracer', 'impersonation'
    readonly instanceAlias: string;
    readonly createdAt: Date;
    lastAccessedAt: Date;          // updated on every access
    resources: Map<string, unknown>;
}
```

## MCP Implementation Guide

When building MCP tools for stateful workflows, follow this pattern:

### Script Tracer Tools

#### `start_script_tracer(instance)` -> returns `sessionId`

```typescript
// 1. Set up AMB client and authenticate
const ambClient = new AMBClient(clientSubscriptions, snInstance);
await ambClient.authenticate();
ambClient.connect();

// 2. Create and start the tracer
const tracer = new ScriptTracer(ambClient, snInstance, { onTrace: ... });
await tracer.start();

// 3. Register in ActiveSessionRegistry
const registry = ActiveSessionRegistry.getInstance();
const sessionId = registry.createSession({
    type: 'script-tracer',
    instanceAlias: alias,
    resources: { scriptTracer: tracer, ambClient: ambClient },
    ttlMs: 30 * 60 * 1000, // auto-cleanup after 30 min idle
});

// 4. Return sessionId to the caller
return { sessionId, debugSessionId: tracer.sessionId };
```

#### `execute_with_tracing(sessionId, script)` -> uses same session

```typescript
// 1. Retrieve the active session's resources
const registry = ActiveSessionRegistry.getInstance();
const session = registry.getSession(sessionId);
if (!session) throw new Error(`Session ${sessionId} not found or expired`);

// 2. Execute script using the same instance (SessionManager handles HTTP session reuse)
const snInstance = await getServiceNowInstance(session.instanceAlias);
const executor = new BackgroundScriptExecutor(snInstance, scope);
const result = await executor.executeScript(script);

// The script execution triggers server-side tracing automatically because
// the tracer is subscribed to AMB channels on the same session
return result;
```

#### `get_trace_results(sessionId)` -> returns accumulated traces

```typescript
const tracer = registry.getResource<ScriptTracer>(sessionId, 'scriptTracer');
if (!tracer) throw new Error(`Session ${sessionId} not found or expired`);

return {
    state: tracer.state,
    statementCount: tracer.traceStatements.length,
    statements: tracer.traceStatements,
};
```

#### `stop_script_tracer(sessionId)` -> stops and cleans up

```typescript
const registry = ActiveSessionRegistry.getInstance();
const tracer = registry.getResource<ScriptTracer>(sessionId, 'scriptTracer');
const ambClient = registry.getResource<AMBClient>(sessionId, 'ambClient');

if (tracer && tracer.state === 'tracing') {
    await tracer.stop();
}
if (ambClient) {
    ambClient.disconnect();
}

registry.destroySession(sessionId);
return { success: true };
```

### Impersonation Tools (Future)

The same pattern applies. The session would store the impersonated user context:

```typescript
const sessionId = registry.createSession({
    type: 'impersonation',
    instanceAlias: alias,
    resources: {
        impersonatedUser: targetUser,
        originalUser: currentUser,
        snRequest: impersonatedRequest,
    },
    ttlMs: 60 * 60 * 1000, // 1-hour idle timeout
});
```

Subsequent operations would retrieve the `snRequest` from the session to execute as the impersonated user:

```typescript
const snRequest = registry.getResource<ServiceNowRequest>(sessionId, 'snRequest');
// Use this request for all operations that should run as the impersonated user
```

## CLI Implementation Guide

### Long-Running Commands (Script Tracing)

For AMB-dependent features, the CLI command stays alive (like `nex log` does) and the `ActiveSessionRegistry` manages state within that process:

```typescript
// nex script-tracer start --auth dev01
export class ScriptTracerStart extends AuthenticatedCommand {
    async run() {
        // Set up AMB, start tracer, register session (same as MCP pattern above)
        const sessionId = registry.createSession({ ... });
        this.log(`Session started: ${sessionId}`);

        // Keep alive, stream trace output
        process.on('SIGINT', async () => {
            await tracer.stop();
            ambClient.disconnect();
            registry.destroySession(sessionId);
        });
    }
}
```

### Cross-Process Session Reuse (Future - Impersonation)

For HTTP-only workflows that don't need WebSocket, a future `SessionStore` could serialize session data to disk:

```
~/.nex/sessions/<uuid>.json
{
    "id": "a1b2c3...",
    "type": "impersonation",
    "instanceAlias": "dev01",
    "createdAt": "2026-03-29T...",
    "cookies": "JSESSIONID=...; glide_session_store=...",
    "userToken": "abc123...",
    "instanceUrl": "https://dev01.service-now.com",
    "metadata": { "impersonatedUser": "admin" }
}
```

This would allow:
```bash
nex impersonate start --auth dev01 --user admin
# -> Session abc123 created

nex exec --session abc123 ./my-script.js
# -> Executes as admin using restored session cookies

nex impersonate stop --session abc123
# -> Cleans up session file
```

> **Note**: AMB-dependent features (script tracing) cannot be serialized to disk because WebSocket connections are inherently in-memory. For those, the CLI command must stay alive.

## Resource Key Conventions

Use consistent resource keys across MCP and CLI implementations:

| Key | Type | Used By |
|-----|------|---------|
| `scriptTracer` | `ScriptTracer` | Script tracing sessions |
| `ambClient` | `AMBClient` | Any session needing WebSocket/AMB |
| `snRequest` | `ServiceNowRequest` | Sessions needing a specific HTTP session reference |
| `impersonatedUser` | `string` | Impersonation sessions |
| `originalUser` | `string` | Impersonation sessions |

## TTL and Cleanup

- Always set a `ttlMs` when creating sessions to prevent resource leaks
- Sessions expire automatically when not accessed within the TTL window
- `listSessions()` evicts expired entries as a side effect
- On explicit stop/cleanup, always call `destroySession()` after cleaning up resources
- Recommended defaults: 30 minutes for script tracing, 60 minutes for impersonation
