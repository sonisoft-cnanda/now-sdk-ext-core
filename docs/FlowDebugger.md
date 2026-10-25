# Debug a flow step by step

`FlowDebugger` drives Workflow Studio's flow debugger (**Test ▸ Debug**) over REST. It starts a run,
stops at breakpoints, steps over, into and out, and reads each step's runtime inputs and outputs while
the run is paused. A run you start must be ended: `runTo` (by default) and `withSession` cancel it for you.

```typescript
import { FlowDebugger, FlowDebugError } from '@sonisoft/now-sdk-ext-core';

const dbg = new FlowDebugger(instance);

// One call: run to step 3, report the run there, cancel it.
const { snapshot } = await dbg.runTo({
    flow: 'x_acme_app.create_task_copy',          // or a sys_id
    inputs: { table: 'incident', field_values: 'short_description=Debug run' },
    breakpoints: [3],                              // step numbers, as Workflow Studio shows them
});
console.log(snapshot.pausedAt?.step?.label);       // "If: Wait for Completion"
console.log(snapshot.steps.find(s => s.step?.number === 1)?.outputs.Record);
```

**A debug run executes the flow for real.** Its actions create and change records, send notifications
and call out, exactly as a Test does. Debug a copy (`FlowManager.copyFlow`) in a scratch application, and
never on an instance you may not change. Under an installed policy, starting a run and sending a step
command need **execute**; breakpoint changes and cancel need **write**, so a run started before
`--deny-execute` can still be cancelled under it. `start` refuses up front when write is not permitted,
so it never starts a run it could not cancel.

## Driving a run yourself

```typescript
await dbg.withSession({ flow: FLOW_SYS_ID, inputs }, async (session) => {
    // A run pauses before its first step.
    console.log(session.snapshot.state, session.snapshot.pausedAt?.step?.number);   // PAUSED 1
    await dbg.setBreakpoints(session.contextId, [3]);
    let snap = await dbg.resume(session.contextId);    // paused at step 3
    snap = await dbg.stepOver(session.contextId);      // next step, or the end
    return snap.state;
});                                                    // cancelled here unless it ended
```

| Method | What it does |
| --- | --- |
| `start(options)` | Starts a run of the flow's current draft and waits for the first pause. Returns the root `contextId`, the locations it can stop at, and the first snapshot. |
| `setBreakpoints(ctx, steps)` / `clearBreakpoints(ctx)` / `getBreakpoints(ctx)` | Replace, clear or read the breakpoints. Reads back what the debugger holds. |
| `stepOver` / `stepInto` / `stepOut` / `resume` / `skipAll` (`ctx`) | Send one command to the paused run, then wait for it to pause again, end, or time out. |
| `command(ctx, name)` | The same, by name. Only the five names above are accepted. |
| `inspect(ctx)` | The run as it is now, without moving it. |
| `locations(ctx)` | Where the active context can stop. |
| `cancel(ctx)` | Ends the run, and every subflow context below it, and reads each one back. Safe to repeat. A child context id is followed up to its root. |
| `runTo(options)` | Start, run to the first breakpoint, report, then (`after`) `cancel` (the default), `resume` or `stay`. With `resume`, a run that has not finished when the wait ends is left running (`final.timedOut`); with `stay`, it is left as it is. |
| `withSession(options, work)` | Start, run `work`, cancel afterwards unless the run ended. |
| `listSessions({ createdBy? })` | Debug runs still open on the instance, newest first: for finding one a crashed process left paused. |

Every method takes the **root** context id that `start` returned.

## Snapshots

A `FlowDebugSnapshot` is the run at the moment it was read:

- `state` is `PAUSED`, `RUNNING`, `WAITING`, `COMPLETE`, `CANCELLED`, `ERROR` or `UNKNOWN`; `rawState` is
  the platform's value (`PAUSED_IN_DEBUG`, `IN_PROGRESS`, …).
- `pausedAt` is the location, with its `step`: number, label, kind (`action`, `flowLogic`, `subflow`, or
  `actionStep` for a custom action's inner step), and the instance ids that tie it to the report.
- `steps` holds every element with a report so far: state, error, timing, and `inputs` / `outputs` as
  `{value, displayValue}`. A completed step's `error` is "Success": that is the engine's wording.
- `error` is set when the run ended in `ERROR`. A failing step does not pause; the run goes straight to
  `ERROR`.
- `timedOut` is set when a wait ran out before the run visibly moved on: it is usually still executing
  (`RUNNING`) or waiting. The run is left as it is; look again with `inspect`, or `cancel` it.

## Step numbers and debugger lines

You name breakpoints by the step number Workflow Studio shows (the step's `order`). The debugger itself
uses its own line numbers (the fixture subflow's steps 1 to 4 are lines 1, 4, 6 and 8), and it checks a
breakpoint by line only: an element id it does not know is still reported as verified. So `FlowDebugger`
never sends a breakpoint you typed. It looks the step up in the debugger's own list of locations and
sends that pair, and an unknown step is refused as `unknown_breakpoint`, listing the valid numbers.
You can also pass `{ line }` or `{ flowElementId }` exactly as `locations()` reports them; inner steps of
a custom action are reachable that way.

## Subflows

Step into on a subflow call starts the subflow in a **child context** of its own, and the parent waits.
`FlowDebugger` follows it: the snapshot's `contextId` is the child, `chain` lists root to child, and
commands, breakpoints and `locations()` apply to the child until it finishes. Cancelling the root ends the
child too.

## Inputs

For a subflow, `inputs` are its inputs by name. Unknown names (`unknown_input`) and missing mandatory ones
(`missing_input`) are refused before anything is sent. A JavaScript array for an `array.*` input is sent
the way Workflow Studio sends it (`{children: [{name, value}, …]}`); a plain array would reach the flow as
an empty list. For a flow, `inputs` are the trigger's outputs, as `FlowManager.testFlow` takes them (for a
record trigger: `current` as the record's sys_id, and `table_name`).

## Errors

`FlowDebugError` carries a `code` and a `detail` that never holds input values or step data:

| Code | When |
| --- | --- |
| `invalid_input` | A malformed id, step reference, option or command name. |
| `flow_not_found` / `not_debuggable` | No such flow or subflow; or an action, which has Test but no Debug. |
| `unknown_input` / `missing_input` | `detail.inputs` names them. |
| `start_failed` | The debugger did not start a run (`detail.status`). If it started one that then could not be set up, it was cancelled again: `detail.contextId` and `detail.cancelled` say which run and whether that worked, and the error's `cause` is the original failure. |
| `not_paused` | A command while the run is not paused, or a breakpoint change once it has ended; `detail.state`. |
| `unknown_breakpoint` / `breakpoint_not_verified` | `detail.validSteps`; or the debugger's `serverMessage`. |
| `context_not_found` / `not_a_debug_session` | No such context; or one the debugger did not start. `cancel` refuses those, so it can never end a real flow run. |
| `permission_denied` / `release_unsupported` | The session cannot use the debugger; or the instance has none. |
| `cancel_failed` | Cancel was sent, but the run (or one of its subflow contexts, `detail.contextId`) is still open; `detail.state`. |
| `unexpected_response` | An answer this library does not understand. |

Policy refusals are not wrapped: check them with `isPolicyRefusal`.

## How it works

These are Workflow Studio's own calls, captured from the UI and replayed with the ordinary OAuth
credential. They are not a published REST contract, so a release can change them; `release_unsupported`
is what an instance without them reports.

| Purpose | Call |
| --- | --- |
| Start | `POST /api/now/processflow/debug/start/flow-object` with `{flow, outputMap, runOnThread: true, tracingEnabled: true}`; `flow` is the definition from `GET processflow/flow/{id}` |
| Locations | `GET /api/now/processflow/debug/allowed-breakpoints/{ctx}` |
| Breakpoints | `GET` / `POST /api/now/processflow/debug/breakpoints/{ctx}` (the POST replaces the set) |
| Command | `POST /api/now/processflow/debug/command/{ctx}/{command}`, one of `STEP_INTO`, `STEP_OVER`, `STEP_OUT`, `RESUME`, `SKIP_ALL` |
| State and step data | `GET /api/now/processflow/operations/flow/context/{ctx}` |
| Cancel | `POST /api/now/processflow/operations/flow/context/{ctx}/cancel` |
| Child contexts, open runs | `sys_flow_context` (`source_record` = the parent; `calling_source` = `DEBUG_BUTTON`) |

Behaviour that shapes the implementation:

- A command is answered before the step runs, so every command is followed by polling the context.
- **Any** command name is answered with success, and an unknown one runs the flow to the end. Only the
  five names are ever sent.
- Cancel answers "cancelled flow" (201) for any id, even one that does not exist, so the result is always
  read back.
- The start request is marked `sensitive`, because its body holds the whole flow and its inputs, and so
  are the context reads, whose replies hold the run's data: neither reaches a log. A failed start keeps
  only its HTTP status; a 400 or 404 is checked with a harmless debugger read to tell an instance without
  the debugger (`release_unsupported`) from a start it refused.
- WAITING only counts as settled after 5 seconds, because right after step into a subflow the parent is
  WAITING before its child context exists. A genuine wait (a timer, Wait For Condition) is therefore
  reported 5 seconds late.
