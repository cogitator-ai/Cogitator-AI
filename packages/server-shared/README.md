# @cogitator-ai/server-shared

Shared streaming protocol, request validation, response serialization, and utilities for Cogitator server adapters.

## Overview

`@cogitator-ai/server-shared` is the common foundation under every Cogitator server adapter (`express`, `fastify`, `hono`, `koa`, `next`, `tetsu`) and protocol bridge (`openai-compat`, `a2a`). It establishes a unified Server-Sent Events (SSE) streaming protocol, robust request body and media-type validation, standardized client response shaping, heartbeat management, ID generation, OpenAPI document generation, and adapter conformance test suites.

### Who is this for?

This package is intended for **adapter authors** and developers building **custom servers** or integrations directly on top of the Cogitator AI runtime. Most applications interact with Cogitator through an official adapter (such as `@cogitator-ai/hono`, `@cogitator-ai/express`, `@cogitator-ai/fastify`) and receive this package transitively without needing to install it directly.

## Installation

```bash
pnpm add @cogitator-ai/server-shared
# or
npm install @cogitator-ai/server-shared
```

## Quick Start: SSE Encoding

Adapters and custom HTTP servers use `encodeSSE` to format event objects into SSE wire frames (`data: <json>\n\n`) and `encodeDone` to signal stream completion (`data: [DONE]\n\n`):

```typescript
import {
  createStartEvent,
  createTextStartEvent,
  createTextDeltaEvent,
  createTextEndEvent,
  createFinishEvent,
  encodeSSE,
  encodeDone,
  generateId,
} from '@cogitator-ai/server-shared';

function streamResponse(res: NodeJS.WritableStream) {
  const messageId = generateId('msg');
  const textId = generateId('txt');

  // 1. Announce stream start and thread
  res.write(encodeSSE(createStartEvent(messageId, 'thread_abc123')));

  // 2. Stream text parts
  res.write(encodeSSE(createTextStartEvent(textId)));
  res.write(encodeSSE(createTextDeltaEvent(textId, 'Hello from ')));
  res.write(encodeSSE(createTextDeltaEvent(textId, 'Cogitator!')));
  res.write(encodeSSE(createTextEndEvent(textId)));

  // 3. Emit finish event with usage and outcome
  res.write(
    encodeSSE(
      createFinishEvent(
        messageId,
        { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
        { threadId: 'thread_abc123', status: 'completed' }
      )
    )
  );

  // 4. Terminate the SSE stream
  res.write(encodeDone());
}
```

## Exports

All exports from `packages/server-shared/src/index.ts` are grouped below by purpose:

### 1. SSE Streaming Protocol & Event Factory Functions

Standardized Server-Sent Events protocol for agent runs, workflow runs, swarm runs, and interactive tool approvals.

#### Event Factory Functions

- `createStartEvent(messageId, threadId?)`: Emits the initial `start` event announcing the message ID and the active or newly assigned memory `threadId`.
- `createTextStartEvent(id)`: Starts a streamed text segment.
- `createTextDeltaEvent(id, delta)`: Emits a text chunk (`delta`) for the active text part.
- `createTextEndEvent(id)`: Closes the active text segment.
- `createReasoningStartEvent(id)`: Starts a streamed reasoning summary segment (when `reasoning.summary` is enabled on the agent).
- `createReasoningDeltaEvent(id, delta)`: Emits a reasoning chunk (`delta`).
- `createReasoningEndEvent(id)`: Closes the reasoning summary segment.
- `createToolCallStartEvent(id, toolName)`: Signals a tool call with its provider ID and name. In a streamed run it goes out as soon as the model picked the tool.
- `createToolCallDeltaEvent(id, argsTextDelta)`: Emits raw JSON argument deltas for a tool call. In a streamed run each piece the model writes is a delta, else the arguments come in one delta right before the call runs.
- `createToolCallEndEvent(id, dropped?)`: Closes a tool call as soon as it is complete, so the events of two calls do not interleave unless the provider mixes their pieces. With `dropped` it closes a call the model never finished, which never runs.
- `createToolDroppedEvent(id, toolCallId, reason)`: The `tool-result` of a call that will never run, `{ dropped: true, reason }` with `reason` `'incomplete'` (the model never finished it) or `'discarded'` (the run did not keep it). A client removes the call, one that does not know `dropped` sees a call with an empty result.
- `createToolUpdateEvent(toolCallId, { content?, details?, presentation? })`: Emits what a running tool reported with `context.update()`, between its `tool-call-end` and its `tool-result`.
- `createToolResultEvent(id, toolCallId, result, { details?, presentation? })`: Emits the result of an executed tool call linked by `toolCallId`: `result` is what the model read, `details` and `presentation` come from a `toolOutput()` result or the tool's `presentation`.
- `createApprovalRequiredEvent(threadId, approvals)`: Emits an `approval-required` event when tool calls require human-in-the-loop review, pausing the run.
- `createInterruptRequiredEvent(threadId, interrupts)`: Emits an `interrupt-required` event when the run paused on questions its tools asked (`context.interrupt()`), answered by id in the `responses` of the resume.
- `createErrorEvent(message, code?)`: Builds an `error` stream event (`{ type: 'error', message, code }`).
- `createFinishEvent(messageId, usage?, details?)`: Emits the terminal `finish` event containing sanitized token counts and run completion details (`AgentRunOutcome`).
- `createWorkflowEvent(event, data)`: Emits workflow execution events (`node_started`, `node_completed`, `node_error`, `node_progress`, `workflow_completed`, `workflow_failed`).
- `createSwarmEvent(event, data)`: Emits multi-agent swarm coordination events (`agent_start`, `agent_complete`, `agent_error`, `message`, `swarm_completed`).

#### Protocol Types

- `StreamEvent`: Discriminated union of all streaming events emitted over the SSE wire.
- `StartEvent`: Structure of the `start` event.
- `TextStartEvent`: Structure of the `text-start` event.
- `TextDeltaEvent`: Structure of the `text-delta` event.
- `TextEndEvent`: Structure of the `text-end` event.
- `ReasoningStartEvent`: Structure of the `reasoning-start` event.
- `ReasoningDeltaEvent`: Structure of the `reasoning-delta` event.
- `ReasoningEndEvent`: Structure of the `reasoning-end` event.
- `ToolCallStartEvent`: Structure of the `tool-call-start` event.
- `ToolCallDeltaEvent`: Structure of the `tool-call-delta` event.
- `ToolCallEndEvent`: Structure of the `tool-call-end` event, with optional `dropped`.
- `ToolUpdateEvent`: Structure of the `tool-update` event: what a running tool reported, or with `arguments` the arguments a streamed call runs with when they differ from the streamed ones.
- `ToolResultEvent`: Structure of the `tool-result` event, with optional `details` and `presentation` (`ToolPresentation`: `label`, `icon?`, `detail?`), or `dropped` and `reason` for a call that never ran.
- `ApprovalRequiredEvent`: Structure of the `approval-required` event.
- `PendingApproval`: Client-facing tool approval request (`toolCallId`, `toolName`, `arguments`, `description`, optional `sideEffects`, and once the run has permissions set up `reason` (why the call asks), `rule` (the text of the `ask` rule that made it ask, never the file it came from), `suggestedRule` (the rule an "always allow" answer saves) and the run's permission `mode`).
- `InterruptRequiredEvent`: Structure of the `interrupt-required` event.
- `PendingInterrupt`: A question a paused run waits on (`id`, `kind`, `reason`, `message`, optional `responseSchema`, `expiresAt`, `toolCallId`, `toolName`, `details`). `kind` is `approval`, `input` (a tool asked), `plan` (a plan to approve before the run leaves plan mode, the plan in `details.plan`) or `budget` (a budget the run reached, its `scope`, `metric`, `used` and `limit` in `details`). The answer goes by `id` in `responses` and must match `responseSchema`.
- `ErrorEvent`: Structure of the `error` event.
- `FinishEvent`: Structure of the `finish` event extending partial `AgentRunOutcome`.
- `FinishDetails`: Optional outcome details and thread passed when building a `FinishEvent`.
- `WorkflowEvent`: Structure of workflow progress events.
- `SwarmEvent`: Structure of swarm progress events.
- `Usage`: Token usage counts (`inputTokens`, `outputTokens`, `totalTokens`, and optional `reasoningTokens`, `cachedInputTokens`, `cacheWriteTokens`).

#### Protocol Schemas

Every event has a Zod schema of the same shape as its type, so a client can check what a server sends at its boundary:

```typescript
import { StreamEventSchema } from '@cogitator-ai/server-shared';

for (const data of sseDataLines) {
  if (data === '[DONE]') break;
  const event = StreamEventSchema.parse(JSON.parse(data));
  if (event.type === 'text-delta') process.stdout.write(event.delta);
}
```

- `StreamEventSchema`: Discriminated union of every event schema on `type`. An unknown `type` or a field of the wrong type fails to parse, a field a newer server adds is dropped.
- `StartEventSchema`, `TextStartEventSchema`, `TextDeltaEventSchema`, `TextEndEventSchema`, `ReasoningStartEventSchema`, `ReasoningDeltaEventSchema`, `ReasoningEndEventSchema`, `ToolCallStartEventSchema`, `ToolCallDeltaEventSchema`, `ToolCallEndEventSchema`, `ToolUpdateEventSchema`, `ToolResultEventSchema`, `ApprovalRequiredEventSchema`, `ErrorEventSchema`, `FinishEventSchema`, `WorkflowEventSchema`, `SwarmEventSchema`: The schema of each event.
- `RunUsageSchema`, `PendingApprovalSchema`, `ToolPresentationSchema`: The schemas of the `usage` of `finish`, of a pending approval and of the `presentation` of a tool call.
- `streamEventComponents()`: The same schemas as OpenAPI 3.0 components: `StreamEvent` (a `oneOf` with a discriminator on `type`), a `Stream<Name>Event` per event, `RunUsage`, `PendingApproval` and `ToolPresentation`.
- `OpenAPISchemaObject`: A component schema as plain JSON.

### 2. SSE Helpers & Heartbeat Management

Wire formatting and keep-alive ping mechanisms to maintain streaming connections through intermediate proxies and strict runtime timeouts.

- `encodeSSE(data, id?)`: Serializes any JavaScript object or event into SSE format (`data: <json>\n\n`), with an `id: <id>` line first when given (the events of a resumable stream).
- `encodeDone()`: Returns the standard terminal event frame (`data: [DONE]\n\n`).
- `DEFAULT_SSE_HEARTBEAT_MS`: Default heartbeat interval of 5,000 ms (5 seconds). Keeps streams active under Bun's 10-second `idleTimeout` and reverse-proxy disconnects (e.g., nginx 60s).
- `encodeHeartbeat()`: Returns a comment frame (`: keep-alive\n\n`) that SSE clients silently ignore.
- `resolveSseHeartbeatMs(value)`: Validates and resolves the heartbeat interval option (`0` turns heartbeats off; throws `RangeError` if negative, non-integer, or non-finite).
- `startHeartbeat(beat, intervalMs)`: Sets up a recurring interval calling `beat()` until aborted or until `beat()` returns `false` (indicating stream closure). Returns a cleanup teardown function.

### 3. Agent Stream Session

Stateful session manager coordinating stream event ordering, part transitions, and runtime event hooks.

- `AgentStreamSession`: High-level session coordinator for streaming agent runs. Guarantees that parts never interleave (closes an open text or reasoning part before emitting tool calls or ending, and ends each streamed tool call as soon as it is complete, so tool calls interleave only when the provider mixes their pieces, and then no piece is lost), drops the calls it announced that never came to run (a `tool-call-end` with `dropped` when the call was never finished, then a dropped `tool-result`, also at `complete` and `fail`, while calls that run or wait for approval are kept, and a dropped call that runs after all under another tool name is announced again), generates IDs, emits `start`, buffers non-streamed results, handles tool approvals, and emits `finish` or `error`. Exposes `callbacks` (`onToken`, `onReasoning`, `onToolCall`, `onToolResult`, `onToolUpdate`, `onToolInputStart`, `onToolInputDelta`, `onToolInputAvailable`, `onToolInputAbandoned`) ready to spread into `cogitator.run({ stream: true, ...session.callbacks })`.
- `createThreadId()`: Generates a cryptographically random thread identifier (`thread_${crypto.randomUUID()}`).
- `AgentStreamCallbacks`: Required callback interface matching Cogitator's streaming callbacks.
- `AgentStreamSessionOptions`: Options interface accepting an optional client-supplied `threadId`.

### 3a. Resumable Streams

The machinery behind the `resumableStreams` option every adapter takes (express, fastify, hono, koa, tetsu, next). With it on, every event of `/agents/:name/stream` and `/agents/:name/resume/stream` carries an SSE `id`, `<streamId>:<seq>` with `seq` from 1 up, so the id alone names the stream (`streamId` is `stream_<uuid>`, which nobody can guess). A client that disconnects no longer stops the run: it goes on, its events kept in a store. The same route with `Last-Event-ID: <id>` (or `?lastEventId=<id>`) reconnects instead of starting a run and reads no body: the answer replays the events after that id, then follows the run to `finish` or `error` (and `data: [DONE]` after `finish`). Several clients may follow one stream. `DELETE /agents/:name/stream/:streamId` cancels the run (`204`), on whatever process runs it.

- **Owner.** A stream is bound to the caller who started it: by default every field of what the adapter's `auth` returned (user id, roles, permissions, metadata such as a tenant), so callers without a user id are still told apart. `owner(auth)` returns a key of your own, for example the user id alone when the identity carries values that change between requests, such as the expiry of a token. Only a caller with the same key may reconnect or cancel, anyone else gets `404 STREAM_NOT_FOUND` before any SSE header, and so does an unknown or expired stream or an event id the stream never sent. An id that is not `<streamId>:<seq>` gets `400 INVALID_INPUT`.
- **authorizeThread.** After the owner check, a reconnect and a cancel ask the adapter's `authorizeThread` about the stream's thread, so a caller it turns away now gets `403 THREAD_FORBIDDEN`.
- **Header first.** `?lastEventId=` is for clients that cannot set headers. It puts the id into URLs and access logs, prefer `Last-Event-ID`.
- **Gaps.** When events after the id are no longer kept (more than `maxEvents` since, or a store that lost some, found by their sequence numbers), the reconnect gets one `error` event `STREAM_RESUME_GAP`, without an id, telling the client to fetch the thread (`GET /threads/:id`) to catch up.
- **Slow clients.** At most `maxEvents` wait for a client that reads slowly. One that falls further behind reads the store again, and gets `STREAM_RESUME_GAP` only for events the store no longer keeps.
- **Stopped runs.** A run nobody follows for `detachedTimeoutMs` (5 minutes) is stopped, so a client that never comes back does not run up cost, and every run is stopped when `until` aborts (a server that shuts down, Fastify closes the plugin's runs by itself). Such a stream ends with an `error` event `STREAM_ABORTED`, a cancelled one with `STREAM_CANCELLED`, which a late reconnect replays.
- **Room.** A stream whose run goes on is never evicted. When the store keeps `maxStreams` streams that all go on, a new resumable stream is refused with `503 STREAM_LIMIT_REACHED` before anything is sent.
- **Store failures.** The clients of the process that runs a stream get every event from it directly, the last one too, also when the store fails. A store that cannot keep an event stops the run (`STREAM_ABORTED`).

```typescript
import { CogitatorServer } from '@cogitator-ai/express';

new CogitatorServer({
  app,
  cogitator,
  agents,
  config: {
    auth: verifyToken,
    resumableStreams: {
      maxEvents: 2000,
      retentionMs: 10 * 60_000,
      detachedTimeoutMs: 2 * 60_000,
      owner: (auth) => auth?.userId,
      until: shutdownSignal,
    },
  },
});
```

- `ResumableStreams<Auth>`: The hub an adapter builds from its option (`ResumableStreams.from(option)`, `undefined` when off). `startAgentRun({ auth, threadId, signal?, execute, describeError })` starts a streamed run or resume on a new stream and answers `{ ok: true, stream }` (`frames(signal)`: the events with their ids, until the stream ends or `signal` aborts) or `{ ok: false, error }` (`503 STREAM_LIMIT_REACHED`). `reconnect(lastEventId, caller)` and `cancel(streamId, caller)` take the caller (`{ auth, authorizeThread }`) and answer `{ ok: true, ... }` or the refusal. `close()` stops every run of the process, as `until` does. `open(owner)` is the lower level: a stream of your own events (`emit`, `end`, `signal`, `stopReason`).
- `ResumableStreamOptions<Auth>`: `{ store?, maxEvents?, retentionMs?, maxStreams?, detachedTimeoutMs?, owner?, until? }`. `retentionMs` and `maxStreams` set up the default in-memory store, next to a `store` of your own they throw. `maxEvents` also bounds what waits for one client.
- `StreamCaller<Auth>`, `defaultStreamOwner(auth)`: Who asks to reconnect or cancel, and the default owner key.
- `StreamReplayStore`: Where the events are kept: `create` (`false` when it has no room without evicting a stream that goes on), `append`, `read(streamId, afterSeq)` (the events after it, whether some were evicted (`gap`) and whether the stream finished), `finish`, `get` (the `owner`, `lastSeq` and how many `subscribers` follow it), `subscribe` (the events appended from now on, then the end), `cancel` and `onCancel` (a cancel asked on any process reaches the process that runs the stream). Several processes behind a load balancer need a store they share, with pub/sub (Redis `PUBLISH`/`SUBSCRIBE` or similar), so a reconnect or a cancel that lands on another process reaches the run, and `subscribers` counts the clients of every process, which the run reads before it stops as detached.
- `InMemoryStreamReplayStore`: The default store, for one process: `maxEvents` of each stream (1000, a ring that evicts the oldest), a finished stream for `retentionMs` (5 minutes), `maxStreams` streams (1000, a new one evicts the stream that finished first, and is refused while all of them go on). No timers: expired streams are dropped as the store is used. `now` injects the clock.
- `STREAM_NOT_FOUND`, `STREAM_RESUME_GAP`, `STREAM_ABORTED`, `STREAM_CANCELLED`, `STREAM_LIMIT_REACHED`: The error codes of resumable streams.
- `formatStreamEventId(streamId, seq)`, `parseStreamEventId(id)`, `isStreamId(id)`, `lastEventIdOf(header, query)`: The event id format, and the id a request reconnects with (the header first, an empty value names none).
- `invalidLastEventId()`, `invalidStreamId()`, `streamNotFound()`, `streamLimitReached()`: The refusals of a reconnect, a cancel and a new stream.

### 4. ID Generation

- `generateId(prefix = 'id')`: Generates collision-resistant, URL-safe identifiers combining prefix, base-36 timestamp, random characters, and monotonic counter (e.g., `msg_...`, `txt_...`, `rsn_...`, `res_...`).

### 5. Request Validation & Schemas

Uniform validation logic across all adapters to reject malformed payloads with HTTP 400 (`INVALID_INPUT`) before reaching the model or runtime.

#### Functions & Constants

- `parseRunRequest(body, options?)`: Validates `POST /agents/:name/run` and `/stream` request bodies. Rejects blank strings (`""`, `"   "`), verifies `context` against `acceptContext` policy, and validates `threadId` and `multitaskStrategy` (one of `MULTITASK_STRATEGIES`).
- `runRequestRunOptions(body)`: The run options a parsed run request adds, its `multitaskStrategy` when it names one.
- `parseSwarmRunRequest(body, options?)`: Extends `parseRunRequest` with positive finite `timeout` validation up to `MAX_RUN_TIMEOUT_MS`.
- `parseResumeRequest(body)`: Validates `POST /agents/:name/resume` payloads (`threadId`, `decisions` map, `defaultDecision`, and the `responses` to the run's interrupts). A decision is `{ approved: boolean, reason?: string, updatedArguments?: object, remember?: boolean | { rule?: string, layer?: 'session' | 'local' | 'project' | 'user' } }`: an approval may change the arguments of the call (the run checks them against the tool's schema and the rules again) and save an "always allow" rule (`remember: true` saves the `suggestedRule`), a refusal keeps its `reason`.
- `parseAddMessageRequest(body, options?)`: Validates `POST /threads/:id/messages` payloads (`role`, non-blank `content`, optional `metadata`).
- `parseWorkflowRunRequest(body, options?)`: Validates `POST /workflows/:name/run` payloads (`input` object, integer `maxConcurrency`, integer `maxIterations`, boolean `checkpoint`). `checkpoint: true` is accepted only with `{ checkpoints: true }`, for a server that keeps a checkpoint store, and refused otherwise.
- `parseWorkflowResumeRequest(body)`: Validates `POST /workflows/:name/resume` payloads (non-blank `checkpointId`, the same `maxConcurrency` and `maxIterations` options).
- `isNonBlankString(value)`: Type guard ensuring value is a string with at least one non-whitespace character.
- `isJsonObject(value)`: Type guard ensuring value is a non-null, non-array plain object.
- `NON_BLANK_PATTERN`: Regex pattern string (`"\\S"`) for schema-driven adapters (e.g., Fastify, Tetsu).
- `RUN_INPUT_SCHEMA`: JSON Schema object describing the `input` field.
- `DEFAULT_THREAD_MESSAGE_ROLES`: Default accepted roles for thread messages (`['user', 'assistant']`).
- `MAX_RUN_TIMEOUT_MS`: Upper limit for run timeouts (2,147,483,647 ms, approx. 24.8 days).

#### Types

- `ParseResult<T>`: Result union (`{ ok: true; value: T } | { ok: false; message: string }`).
- `RunRequestBody`: Validated agent run request body.
- `RunRequestOptions`: Options specifying allowed context keys via `acceptContext`.
- `ContextPolicy`: Allowed context policy: `false` (refuse all, default), `true` (accept all), or a whitelist of allowed string keys.
- `SwarmRunRequestBody`: Validated swarm run request body including optional `timeout`.
- `ResumeRequestBody`: Validated tool approval resumption body.
- `AddMessageRequestBody`: Validated thread message insertion body.
- `AddMessageRequestOptions`: Options configuring permitted thread message roles.
- `ThreadMessageRole`: Supported message roles (`'user' | 'assistant' | 'system'`).
- `WorkflowRunRequestBody`: Validated workflow run request body.
- `WorkflowRunRequestOptions`: Whether the server keeps a checkpoint store (`checkpoints`), so a run may ask for checkpoints.
- `WorkflowResumeRequestBody`: Validated workflow resume request body.
- `WorkflowRunLimitsBody`: The `maxConcurrency` and `maxIterations` options of a workflow run or resume.

### 6. Request Body Parsing & Media Type Validation

Safeguards preventing unauthorized cross-origin execution and parsing body payloads safely.

#### Functions & Constants

- `refuseNonJsonBody(method, headers)`: Inspects incoming request headers before reading the body. Refuses non-JSON POST/PUT/PATCH/DELETE requests with HTTP 415 (`UNSUPPORTED_MEDIA_TYPE`) to prevent cross-origin preflight bypasses from HTML forms or `text/plain`.
- `isJsonMediaType(contentType)`: Checks if a Content-Type header matches `application/json` or `application/*+json`.
- `parseJsonBody(contentType, text)`: Validates media type and parses raw JSON body text, returning typed results or refusals.
- `readJsonRequestBody(request, limit?)`: Reads a Fetch API `Request` body stream up to the byte limit, returning parsed JSON or a structured `BodyRefusal`.
- `DEFAULT_JSON_BODY_LIMIT`: Default maximum request body limit (1 MiB: 1,048,576 bytes).
- `UNSUPPORTED_MEDIA_TYPE`: Refusal object (`status: 415`, `code: 'UNSUPPORTED_MEDIA_TYPE'`).
- `INVALID_JSON`: Refusal object (`status: 400`, `code: 'INVALID_INPUT'`).
- `PAYLOAD_TOO_LARGE`: Refusal object (`status: 413`, `code: 'PAYLOAD_TOO_LARGE'`).

#### Types

- `BodyRefusal`: Structured refusal representation (`status`, `code`, `message`).
- `JsonBodyResult`: Result union (`{ ok: true; value: unknown } | { ok: false; refusal: BodyRefusal }`).

### 7. Response Serialization & Token Usage

Sanitizes runtime results into safe client-facing JSON responses without leaking internal server state (such as system instructions, raw message history, or execution checkpoints).

#### Functions

- `toAgentRunResponse(result)`: Converts a Cogitator `RunResult` into the canonical client response shape (`AgentRunResponse`), preserving `output`, `threadId`, `usage`, `toolCalls`, `traceId`, and outcome flags.
- `toAgentRunOutcome(result)`: Extracts status outcomes (`completed` vs `paused`), `pendingApprovals`, structured outputs, and run termination flags (`truncated`, `blocked`, `iterationLimitReached`).
- `toAgentToolCall(call)`: Sanitizes tool calls into `{ id, name, arguments }`, stripping provider internal state.
- `toPendingApprovals(requests)`: Sanitizes pending tool approval requests for human review.
- `toPendingInterrupts(interrupts)`: The questions of a paused run as clients see them, none while it waits for approvals only.
- `toRunUsage(usage)`: Filters runtime usage down to client-facing token counts (`RunUsage`), omitting server-side cost and duration.
- `toWorkflowCompletedData(result)`: The data of the `workflow_completed` stream event, `{ workflowId, duration, checkpointId? }` (`WorkflowCompletedData`).
- `toWorkflowFailedData(result)`: The data of the `workflow_failed` event a workflow stream sends right before its `error` event, `{ checkpointId? }` (`WorkflowFailedData`).
- `withResumedCheckpoint(result, checkpointId)`: The result of a workflow resume, naming the checkpoint it started from when the resumed run saved none of its own, so a resume that fails at once can be resumed again.

#### Types

- `AgentRunResponse`: Canonical response shape for `POST /agents/:name/run` and `/resume`.
- `AgentRunOutcome`: Flags detailing how a run terminated.
- `AgentToolCall`: Sanitized client-facing tool call.
- `RunUsage`: Standardized token usage structure.

### 8. Swarm Lifecycle Utilities

Resource safety helpers for multi-agent swarm orchestration.

- `withSwarm(swarm, task)`: Executes `task(swarm)` and ensures `swarm.close()` is called in a `finally` block. Prevents connection leaks in distributed swarms (which maintain Redis connections and state TTLs).
- `swarmAgentNames(config)`: Extracts deduplicated list of all agent names participating in a swarm across supervisor, worker, moderator, router, and pipeline stage slots.
- `ClosableSwarm`: Interface for swarm instances exposing `close(): Promise<void>`.
- `SwarmAgentSlots`: Structural definition of agent roles and slots in a swarm configuration.

### 9. OpenAPI & Swagger UI Generation

Dynamic documentation generators reflecting registered agents, tools, workflows, and swarms.

- `generateOpenAPISpec(context, config)`: Builds an OpenAPI 3.0 specification from registered agents, tools (with JSON schemas), workflows, and swarms. Every SSE route answers `text/event-stream` with the `StreamEvent` schema.
- `documentStreamEvents(document)`: Adds the stream protocol to an OpenAPI document a framework generated from its own routes, such as `@fastify/swagger`: the StreamEvent components, and `StreamEvent` as the `text/event-stream` body of every POST route ending in `/stream`. `generateOpenAPISpec` already documents its streams this way.
- `StreamDocumentable`: What `documentStreamEvents` needs of a document.
- `generateSwaggerHTML(spec)`: Generates a standalone HTML page embedding Swagger UI from CDN with the OpenAPI `spec` object embedded inline for `/docs`.
- `OpenAPISpec`: TypeScript interface for the generated OpenAPI 3.0 document.
- `SwaggerConfig`: Customization options for Swagger UI and OpenAPI generation (title, version, base path, auth, `limits`, which the spec shows as the defaults and caps of the capped request fields, and `resumableStreams`, which documents `Last-Event-ID`, `lastEventId` and `STREAM_NOT_FOUND` on the stream routes).
- `OpenAPIContext`: Context containing the registered agents, workflows, and swarms.

### 10. Conformance Testing Suite

Shared conformance test cases and mock runtime ensuring all adapters behave identically.

- `checkConformance(testCase, response, runtime, check?)`: Compares a response the adapter already returned against the test case and runtime state, returning a list of mismatches (an empty array means the adapter conforms).
- `ConformanceRuntime`: Mock runtime tracking runs, resumes, streaming callbacks, and memory operations. `new ConformanceRuntime(testCase)` follows the case's `runtime` options: runs that fail with a `CogitatorError` (`fail`) or a plain error (`crash`), a thread holding `threadEntries` messages, and streamed runs that `hold` after their parts until `release()` or until their signal aborts.
- `CONFORMANCE_CASES`: Collection of standardized test cases covering input validation, context policy, thread isolation, error conditions and the streams of runs and resumes. Every event of a stream a case reads must match `StreamEventSchema`, and nothing may follow its `finish` or `error`.
- `CONFORMANCE_ROUTES`: Standard test route mapping (`/agents/:name/run`, `/threads/:id/messages`, etc.).
- `CONFORMANCE_NAMES`: Standard test entity names (`assistant`, `team`, `flow`, `thread-1`).
- `CONFORMANCE_SWARM`: Standard swarm fixture with router and pipeline stages.
- `CONFORMANCE_GENERATED_THREAD`: Constant identifying generated thread assertions.
- `conformanceMethod(case)`: Resolves HTTP method for a conformance test case.
- `conformanceContentType(case)`: Resolves Content-Type header for a test case.
- `conformanceRunResult()`: Generates mock completed `RunResult`.
- `conformancePausedResult()`: Generates mock paused `RunResult` with pending tool approvals.
- `parseSseEvents(text)`: Parses raw SSE wire text into structured event objects for test assertions. `parseSseFrames(text)` keeps the `id` of each event.
- `runConformanceCase(case, runtime, send)`: Sends a case and its follow-ups (reconnects, cancels, a second stream) through `send`, in order, dropping the first answer after `disconnectAfter` events when the case says so and releasing a held run once the first follow-up opens. Put what it returns into `checkConformance`.
- `sendConformanceRequest(request, fetcher, codeOf?)`: The `send` of an adapter whose test can `fetch` (a listening server, `app.request`, a route handler): it reads the status, headers, error code and body, or the first events of a stream it then drops.
- `ConformanceRequest`, `ConformanceSend`, `ConformanceFollowUp`: One request of a case, how an adapter sends it, and the follow-ups of a case (`reconnect` with the id of an event of the first answer, `cancel`, `start`, with the caller's headers and what each answer must be).
- `conformanceCaller(header)`, `conformanceAuthorizeThread(server)`, `conformanceResumableStreams(server)`, `ConformanceCaller`: What an adapter's `auth`, `authorizeThread` and `resumableStreams` are for a case: callers told apart by the `x-conformance-user` and `x-conformance-role` headers (`callers`), roles turned away from every thread (`forbiddenRoles`), streams bound to the user id alone (`streamOwner: 'user'`).
- `ConformanceCase`: Interface defining a test case.
- `ConformanceCheckOptions`: Custom status code and error code mapping options for `checkConformance` (e.g. for adapters following framework-specific error conventions).
- `ConformanceResponse`: Standardized response representation for adapter fetchers, with the answer's `headers` (names in lower case) for the cases that check `Retry-After`.
- `ConformanceRoute`: Union of supported conformance route names.
- `ConformanceServerOptions`: Adapter server options required by specific conformance test cases: `acceptContext`, `threadMessageRoles`, `limits`, `anonymous`, `forbiddenThreads` (threads the adapter's `authorizeThread` refuses), `deps` (what its `deps` hook returns), `workflowCheckpoints` (the adapter's workflow checkpoint store, an empty one in the cases), `resumableStreams` (the adapter's option of that name), `callers`, `forbiddenRoles` and `streamOwner` (see `conformanceCaller`).

### 11. Server Contract

What every adapter keeps the same, so an application behaves alike on any of them.

- `RunLimits`, `checkRunLimits(limits)`: The operator's caps on a run (`swarmTimeout`, `workflowMaxIterations`, `workflowMaxConcurrency`), checked to be positive integers.
- `swarmTimeoutWithin(requested, limits)`, `workflowOptionsWithin(options, limits)`: What a run gets, the smaller of what the request asked and the cap, the cap when it asked for nothing.
- `ownedCheckpoints(store, owner)`: A `CheckpointStore` of one user in a store servers share: `save` writes the checkpoint with `owner` (no `owner` key for `undefined`), `load` answers `null` for a checkpoint of anyone else, `list` keeps only the owner's, and `delete` removes only an owned one. A caller without a user id owns only checkpoints saved without one. Adapters run workflows with `new WorkflowExecutor(cogitator, ownedCheckpoints(store, userId))`.
- `findOwnedCheckpoint(store, owner, workflowName, checkpointId)`, `checkpointNotFound(checkpointId)`: The checkpoint a workflow resume names, when it is one of that workflow owned by the caller, and the `404 CHECKPOINT_NOT_FOUND` the adapter answers otherwise, also when it keeps no store.
- `AuthorizeThread`, `authorizeThreadAccess(authorize, auth, threadId)`, `threadForbidden(threadId)`: The hook an adapter asks about every thread a request names, and the `403 THREAD_FORBIDDEN` it answers when the hook says no.
- `AnonymousPolicy`, `admitCaller(userId, policy)`, `UNAUTHORIZED`: `'deny'` turns away a caller without a user id with `401 UNAUTHORIZED`.
- `describeHttpError(error)`: The status, code, message and `retryAfter` (whole seconds) an error is answered with: a `CogitatorError` its own status or the one of its code, a `SwarmTimeoutError` `504 RUN_TIMEOUT`, anything else `undefined`, which the adapter logs and answers with `INTERNAL_ERROR` without its text. `cogitatorErrorStatus` and `retryAfterSeconds` are the parts of it.
- `errorEnvelope(error)`, `errorHeaders(error)`: The `{ error: { message, code, checkpointId? } }` body and the `Retry-After` header of an error answer.
- `workflowRunFailure(described, checkpointId)`: How a failed workflow run is answered: as the error it failed with, plus the `checkpointId` of the last checkpoint it saved, which `errorEnvelope` carries next to `code` and `message`. A run that saved none is answered as any other error.
- `parseThreadPageQuery(query)`, `readThreadPage(memory, threadId, page, thread?)`, `MAX_THREAD_PAGE_LIMIT`: `GET /threads/:id?limit&cursor`, the newest `limit` messages of what is left and a `nextCursor` for the page before them. The cursor tells apart entries that share a time, so no message is skipped or repeated across pages.

## Packages Built on `@cogitator-ai/server-shared`

The following adapters and integrations build on `@cogitator-ai/server-shared`:

| Package                                                                                                        | Description                                                                             | Documentation                                                                           |
| -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [`@cogitator-ai/express`](https://github.com/cogitator-ai/Cogitator-AI/tree/main/packages/express)             | Express.js server adapter with REST endpoints, SSE streaming, WebSocket, and Swagger UI | [README](https://github.com/cogitator-ai/Cogitator-AI/tree/main/packages/express)       |
| [`@cogitator-ai/fastify`](https://github.com/cogitator-ai/Cogitator-AI/tree/main/packages/fastify)             | Fastify server adapter leveraging schema compilation and hooks                          | [README](https://github.com/cogitator-ai/Cogitator-AI/tree/main/packages/fastify)       |
| [`@cogitator-ai/hono`](https://github.com/cogitator-ai/Cogitator-AI/tree/main/packages/hono)                   | Multi-runtime Hono adapter (Node.js, Bun, Deno, Cloudflare Workers, AWS Lambda)         | [README](https://github.com/cogitator-ai/Cogitator-AI/tree/main/packages/hono)          |
| [`@cogitator-ai/koa`](https://github.com/cogitator-ai/Cogitator-AI/tree/main/packages/koa)                     | Koa server adapter with middleware pipeline and SSE streaming                           | [README](https://github.com/cogitator-ai/Cogitator-AI/tree/main/packages/koa)           |
| [`@cogitator-ai/next`](https://github.com/cogitator-ai/Cogitator-AI/tree/main/packages/next)                   | Next.js App Router streaming handlers and React client hooks                            | [README](https://github.com/cogitator-ai/Cogitator-AI/tree/main/packages/next)          |
| [`@cogitator-ai/tetsu`](https://github.com/cogitator-ai/Cogitator-AI/tree/main/packages/tetsu)                 | Tetsu framework adapter for Bun with automatic OpenAPI generation                       | [README](https://github.com/cogitator-ai/Cogitator-AI/tree/main/packages/tetsu)         |
| [`@cogitator-ai/openai-compat`](https://github.com/cogitator-ai/Cogitator-AI/tree/main/packages/openai-compat) | OpenAI-compatible server (`/v1/chat/completions`, `/v1/responses`, `/v1/assistants`)    | [README](https://github.com/cogitator-ai/Cogitator-AI/tree/main/packages/openai-compat) |
| [`@cogitator-ai/a2a`](https://github.com/cogitator-ai/Cogitator-AI/tree/main/packages/a2a)                     | Agent2Agent (A2A) protocol v0.3 server and client implementation                        | [README](https://github.com/cogitator-ai/Cogitator-AI/tree/main/packages/a2a)           |

## Documentation

- Full Cogitator documentation: [cogitator.app](https://cogitator.app)
- Server adapters overview: [cogitator.app/docs/server-adapters](https://cogitator.app/docs/server-adapters)

## License

MIT
