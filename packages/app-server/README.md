# @cogitator-ai/app-server

A typed JSON-RPC 2.0 app-server for Cogitator: threads, turns, steering, approvals and code reviews of a `Cogitator` runtime, served as NDJSON on stdio, with a client generated from the protocol's Zod schemas. It is what an editor, a desktop app or a script drives Cogitator through, and what the ACP agent (phase 45) maps onto.

```bash
pnpm add @cogitator-ai/app-server @cogitator-ai/core
```

Or run it with no code at all: `cogitator app-server -m ollama/qwen3:8b` serves the agent of the CLI on stdin and stdout.

## Features

- **SessionHost** - threads kept in the runtime's memory, one turn per thread at a time, each a run started with `cogitator.start()` (or `startResume()` for a paused thread) whose handle steers and interrupts it
- **Turn streaming** - every event of the stream protocol as `turn/event`, the runs a turn delegates (subagents, agents as tools) tagged with the tool call that started them. A step a fallback model takes over mid-answer comes as `reset-step`, naming what the client takes back
- **Approvals two ways** - asked live with `approval/request` (ACP `session/request_permission` shape), or the turn ends paused and the client resumes it with decisions
- **Steering** - `turn/steer` with `steer`, `followUp` or `inject` delivery, guarded by the expected turn id
- **Reviews** - `review/start` reviews uncommitted changes, a branch, a commit or custom instructions in a review thread, the findings structured by a response format
- **Structured output** - `outputSchema` on `turn/start`, read into `structured`
- **Session log** - `thread/log` from the memory adapter's change feed
- **Traces** - the spans of every turn as `_cogitator/trace/span` for clients that ask, and `_cogitator/trace/get` for those of a past turn
- **Extensions** - `_cogitator/memory/search`, `_cogitator/thread/rewind`, `_cogitator/trace/get`, `_cogitator/workflow/*` and `_cogitator/swarm/*`
- **Generated client** - `@cogitator-ai/app-server/client` has a type for every params, result and notification and an `AppServerClient` with a method per request, with no runtime dependencies. A drift test keeps it in step with the schemas
- **JSON Schema** - the whole protocol as one draft 2020-12 document

## Quick start

### Serve over stdio

```typescript
import { Agent, Cogitator } from '@cogitator-ai/core';
import { SessionHost, createAppServer, serveStdio } from '@cogitator-ai/app-server';

const cogitator = new Cogitator({
  memory: { adapter: 'sqlite', sqlite: { path: './sessions.db' } },
});
const assistant = new Agent({
  name: 'assistant',
  model: 'ollama/qwen3:8b',
  instructions: 'You are a helpful assistant.',
});

const host = new SessionHost({ cogitator, agents: { assistant } });
await serveStdio(createAppServer(host));
await host.close();
```

The host needs memory (`memory.adapter`), since threads live there. `serveStdio` reads NDJSON from `process.stdin` (`jsonrpc` may be left out, as Codex's clients do), writes one message per line to `process.stdout` in order and waits for the stream to drain. When the input ends it answers the requests still being handled, interrupts the turns of the client, waits for them and resolves.

### Drive it with the generated client

```typescript
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { APP_SERVER_PROTOCOL_VERSION, AppServerClient } from '@cogitator-ai/app-server/client';

const child = spawn('cogitator', ['app-server', '-m', 'ollama/qwen3:8b']);
const lines = createInterface({ input: child.stdout });
const client = new AppServerClient({
  send: (line) => child.stdin.write(`${line}\n`),
  onLine: (callback) => lines.on('line', callback),
  close: () => child.stdin.end(),
});

await client.initialize({
  protocolVersion: APP_SERVER_PROTOCOL_VERSION,
  clientInfo: { name: 'my-editor', version: '1.0.0' },
  capabilities: { approvals: 'request' },
});
client.on('turn/event', ({ event }) => {
  if (event.type === 'text-delta') process.stdout.write(event.delta);
});
client.on('turn/completed', ({ turn }) => console.log(`\n${turn.status}`));
client.onRequest('approval/request', ({ toolCall }) => ({
  outcome: {
    outcome: 'selected',
    optionId: toolCall.toolName === 'read' ? 'allow_always' : 'reject_once',
  },
}));

const { thread } = await client.threadStart();
await client.turnStart({ threadId: thread.id, input: [{ type: 'text', text: 'Hello' }] });
```

`cogitator app-server generate-ts --out <dir>` writes the same client into a project of your own, and `cogitator app-server generate-json-schema --out <dir>` the JSON Schema.

## Protocol

JSON-RPC 2.0, one message per line. Every params and result object takes `_meta`, which the other side passes over. The client sends `initialize` first: until then every other method is answered with `-32010`.

### Methods

| Method                     | Params                                                                                          | Result                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `initialize`               | `protocolVersion`, `clientInfo`, `capabilities?` (`approvals`, `traces`, `optOutNotifications`) | `protocolVersion`, `serverInfo`, `capabilities`, `agents` |
| `thread/start`             | `agent?`, `threadId?`, `metadata?`, `permissionMode?`                                           | `thread`, then `thread/started`                           |
| `thread/resume`            | `threadId`                                                                                      | `thread`, `messages`, `pending?`                          |
| `thread/fork`              | `threadId`, `atEntryId?`, `newThreadId?`                                                        | `thread`, then `thread/started`                           |
| `thread/list`              | `archived?`, `agent?`, `cursor?`, `limit?`                                                      | `threads`, `nextCursor?`                                  |
| `thread/archive`           | `threadId`                                                                                      | `thread`, then `thread/archived`                          |
| `thread/unarchive`         | `threadId`                                                                                      | `thread`, then `thread/unarchived`                        |
| `thread/setPermissionMode` | `threadId`, `mode`                                                                              | `thread`                                                  |
| `turn/start`               | `threadId`, `input?` or `resume?`, `outputSchema?`, `model?`, `permissionMode?`                 | `turn`, then `turn/started`                               |
| `turn/steer`               | `threadId`, `expectedTurnId`, `input`, `delivery?`                                              | `turnId`                                                  |
| `turn/interrupt`           | `threadId`, `turnId`                                                                            | `undelivered`                                             |
| `review/start`             | `threadId`, `target`, `model?`                                                                  | `turn`, `reviewThreadId`                                  |
| `_cogitator/memory/search` | `query`, `threadId?`, `agent?`, `limit?`                                                        | `results`, `note?`                                        |
| `_cogitator/thread/rewind` | `threadId`, `toEntryId`, `files?`, `dryRun?`, `force?`                                          | the rewind report                                         |
| `_cogitator/trace/get`     | `turnId`                                                                                        | `threadId`, `turnId`, `spans`                             |
| `_cogitator/workflow/list` | -                                                                                               | `items`                                                   |
| `_cogitator/workflow/run`  | `name`, `input?`                                                                                | `runId`, `result?`                                        |
| `_cogitator/swarm/list`    | -                                                                                               | `items`                                                   |
| `_cogitator/swarm/run`     | `name`, `input?`                                                                                | `runId`, `result?`                                        |

The workflow and swarm methods exist only when the host was given `workflows` or `swarms` runners, else they answer method not found.

A turn's answer always goes out before its `turn/started`, so a client knows the turn id before any event of it. A turn ends `completed`, `paused` (with `pending` approvals and interrupts), `interrupted` or `failed` (with `error`), in `turn/completed`. A paused thread refuses new input with `-32022`: resume it with `turn/start` and `resume: { decisions, responses, defaultDecision }`.

### Notifications

| Notification                | Params                                                                         |
| --------------------------- | ------------------------------------------------------------------------------ |
| `thread/started`            | `thread`                                                                       |
| `thread/archived`           | `threadId`                                                                     |
| `thread/unarchived`         | `threadId`                                                                     |
| `thread/log`                | `threadId`, `change`, `entryId?`, `entry?`                                     |
| `turn/started`              | `threadId`, `turn`                                                             |
| `turn/event`                | `threadId`, `turnId`, `event` (a `StreamEvent`), `parentToolCallId?`, `agent?` |
| `turn/completed`            | `threadId`, `turn`                                                             |
| `_cogitator/workflow/event` | `runId`, `name`, `event`                                                       |
| `_cogitator/swarm/event`    | `runId`, `name`, `event`                                                       |
| `_cogitator/trace/span`     | `threadId`, `turnId`, `span`                                                   |

`capabilities.optOutNotifications` in `initialize` leaves out the methods it names, such as `thread/log`.

### Traces

The host passes `onSpan` to every turn and keeps the spans of a turn (`id`, `traceId`, `parentId`, `name`, `kind`, `status`, times, `attributes`, `events`): the last 2000 of each of the last 200 turns. A client that says `capabilities.traces: true` gets each span as it ends in `_cogitator/trace/span`, still left out when `optOutNotifications` names it. `_cogitator/trace/get` with a `turnId` returns the spans kept of that turn, `-32002` with `data.kind: 'turn'` for a turn the host does not know or no longer keeps.

### Approvals

With `capabilities.approvals: 'request'` the server asks `approval/request` while the turn waits. Its params are `threadId`, `turnId`, `toolCall` and the `options` `allow_once`, `allow_always` and `reject_once`. The client answers `{ outcome: { outcome: 'selected', optionId } }` (with `updatedArguments` or `reason` when it likes), or `{ outcome: { outcome: 'cancelled' } }` to leave the turn paused. `allow_always` approves with `remember: true`, which saves the allow rule the request suggests. ACP's `reject_always` is not offered, since the runtime keeps allow rules from answers but not deny rules: put a lasting denial in the `deny` rules of the permissions instead. An answer with an option not offered leaves the turn paused. Without it (`'pause'`, the default) the turn ends paused.

### Reviews

`review/start` reads what the target names (`uncommittedChanges`, `baseBranch { branch }`, `commit { sha, title? }` from git in the host's `review.cwd`, or `custom { instructions }`), starts a review thread and runs the thread's agent with review instructions and a response format. Its `turn/completed` carries `review`: `findings` (`title`, `body`, `priority` 0 to 3, `confidence`, `location?`), `overallCorrectness` and `overallExplanation`. Pass `review.agent` or `review.context` to the host to change who reviews or how changes are read.

### Errors

| Code     | Meaning                                                                             |
| -------- | ----------------------------------------------------------------------------------- |
| `-32700` | A line that is not JSON                                                             |
| `-32600` | Not a JSON-RPC message                                                              |
| `-32601` | Method not found                                                                    |
| `-32602` | Invalid params, `data.issues` holds the Zod issues                                  |
| `-32002` | Not found, `data.kind` is `thread`, `turn`, `agent`, `entry`, `workflow` or `swarm` |
| `-32010` | Not initialized                                                                     |
| `-32011` | Already initialized                                                                 |
| `-32020` | Thread busy: a turn goes on, `data.activeTurnId`                                    |
| `-32021` | Turn not active: not the turn going on, or none is                                  |
| `-32022` | Thread paused: resume it                                                            |
| `-32023` | Thread archived                                                                     |
| `-32030` | Runtime error, `data.code` is the runtime's error code                              |

## ACP mapping

The core methods line up with the Agent Client Protocol, so the ACP agent of phase 45 is a thin layer over this one:

| ACP                          | App-server                      |
| ---------------------------- | ------------------------------- |
| `initialize`                 | `initialize`                    |
| `session/new`                | `thread/start`                  |
| `session/load`               | `thread/resume`                 |
| `session/prompt`             | `turn/start` + `turn/completed` |
| `session/cancel`             | `turn/interrupt`                |
| `session/update`             | `turn/event`                    |
| `session/request_permission` | `approval/request`              |
| `session/set_mode`           | `thread/setPermissionMode`      |

Cogitator's own methods go by `_cogitator/*`, the way ACP names extensions.

## Packages

| Import                              | What                                                             | Runs on           |
| ----------------------------------- | ---------------------------------------------------------------- | ----------------- |
| `@cogitator-ai/app-server`          | `SessionHost`, `createAppServer`, `serveStdio`, codegen, schemas | Node              |
| `@cogitator-ai/app-server/protocol` | The Zod schemas, error codes and types                           | anywhere Zod runs |
| `@cogitator-ai/app-server/client`   | The generated `AppServerClient` and types                        | anywhere          |

## Development

```bash
pnpm --filter @cogitator-ai/app-server generate   # write src/client/generated.ts from the schemas
pnpm --filter @cogitator-ai/app-server test
```

## License

MIT
