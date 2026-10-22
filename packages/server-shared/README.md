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
- `createToolCallStartEvent(id, toolName)`: Signals the invocation of a tool call with its provider ID and name.
- `createToolCallDeltaEvent(id, argsTextDelta)`: Emits raw JSON argument deltas for a tool call.
- `createToolCallEndEvent(id)`: Closes a tool call invocation.
- `createToolResultEvent(id, toolCallId, result)`: Emits the result of an executed tool call linked by `toolCallId`.
- `createApprovalRequiredEvent(threadId, approvals)`: Emits an `approval-required` event when tool calls require human-in-the-loop review, pausing the run.
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
- `ToolCallEndEvent`: Structure of the `tool-call-end` event.
- `ToolResultEvent`: Structure of the `tool-result` event.
- `ApprovalRequiredEvent`: Structure of the `approval-required` event.
- `PendingApproval`: Client-facing tool approval request (`toolCallId`, `toolName`, `arguments`, `description`, optional `sideEffects`).
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
- `StartEventSchema`, `TextStartEventSchema`, `TextDeltaEventSchema`, `TextEndEventSchema`, `ReasoningStartEventSchema`, `ReasoningDeltaEventSchema`, `ReasoningEndEventSchema`, `ToolCallStartEventSchema`, `ToolCallDeltaEventSchema`, `ToolCallEndEventSchema`, `ToolResultEventSchema`, `ApprovalRequiredEventSchema`, `ErrorEventSchema`, `FinishEventSchema`, `WorkflowEventSchema`, `SwarmEventSchema`: The schema of each event.
- `RunUsageSchema`, `PendingApprovalSchema`: The schemas of the `usage` of `finish` and of a pending approval.
- `streamEventComponents()`: The same schemas as OpenAPI 3.0 components: `StreamEvent` (a `oneOf` with a discriminator on `type`), a `Stream<Name>Event` per event, `RunUsage` and `PendingApproval`.
- `OpenAPISchemaObject`: A component schema as plain JSON.

### 2. SSE Helpers & Heartbeat Management

Wire formatting and keep-alive ping mechanisms to maintain streaming connections through intermediate proxies and strict runtime timeouts.

- `encodeSSE(data)`: Serializes any JavaScript object or event into SSE format (`data: <json>\n\n`).
- `encodeDone()`: Returns the standard terminal event frame (`data: [DONE]\n\n`).
- `DEFAULT_SSE_HEARTBEAT_MS`: Default heartbeat interval of 5,000 ms (5 seconds). Keeps streams active under Bun's 10-second `idleTimeout` and reverse-proxy disconnects (e.g., nginx 60s).
- `encodeHeartbeat()`: Returns a comment frame (`: keep-alive\n\n`) that SSE clients silently ignore.
- `resolveSseHeartbeatMs(value)`: Validates and resolves the heartbeat interval option (`0` turns heartbeats off; throws `RangeError` if negative, non-integer, or non-finite).
- `startHeartbeat(beat, intervalMs)`: Sets up a recurring interval calling `beat()` until aborted or until `beat()` returns `false` (indicating stream closure). Returns a cleanup teardown function.

### 3. Agent Stream Session

Stateful session manager coordinating stream event ordering, part transitions, and runtime event hooks.

- `AgentStreamSession`: High-level session coordinator for streaming agent runs. Guarantees that parts never interleave (closes an open text or reasoning part before emitting tool calls or ending), generates IDs, emits `start`, buffers non-streamed results, handles tool approvals, and emits `finish` or `error`. Exposes `callbacks` (`onToken`, `onReasoning`, `onToolCall`, `onToolResult`) ready to spread into `cogitator.run({ stream: true, ...session.callbacks })`.
- `createThreadId()`: Generates a cryptographically random thread identifier (`thread_${crypto.randomUUID()}`).
- `AgentStreamCallbacks`: Required callback interface matching Cogitator's streaming callbacks.
- `AgentStreamSessionOptions`: Options interface accepting an optional client-supplied `threadId`.

### 4. ID Generation

- `generateId(prefix = 'id')`: Generates collision-resistant, URL-safe identifiers combining prefix, base-36 timestamp, random characters, and monotonic counter (e.g., `msg_...`, `txt_...`, `rsn_...`, `res_...`).

### 5. Request Validation & Schemas

Uniform validation logic across all adapters to reject malformed payloads with HTTP 400 (`INVALID_INPUT`) before reaching the model or runtime.

#### Functions & Constants

- `parseRunRequest(body, options?)`: Validates `POST /agents/:name/run` and `/stream` request bodies. Rejects blank strings (`""`, `"   "`), verifies `context` against `acceptContext` policy, and validates `threadId`.
- `parseSwarmRunRequest(body, options?)`: Extends `parseRunRequest` with positive finite `timeout` validation up to `MAX_RUN_TIMEOUT_MS`.
- `parseResumeRequest(body)`: Validates `POST /agents/:name/resume` payloads (`threadId`, `decisions` map, and `defaultDecision`).
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
- `SwaggerConfig`: Customization options for Swagger UI and OpenAPI generation (title, version, base path, auth, and `limits`, which the spec shows as the defaults and caps of the capped request fields).
- `OpenAPIContext`: Context containing the registered agents, workflows, and swarms.

### 10. Conformance Testing Suite

Shared conformance test cases and mock runtime ensuring all adapters behave identically.

- `checkConformance(testCase, response, runtime, check?)`: Compares a response the adapter already returned against the test case and runtime state, returning a list of mismatches (an empty array means the adapter conforms).
- `ConformanceRuntime`: Mock runtime tracking runs, resumes, streaming callbacks, and memory operations. `new ConformanceRuntime(testCase)` follows the case's `runtime` options: runs that fail with a `CogitatorError` (`fail`) or a plain error (`crash`), and a thread holding `threadEntries` messages.
- `CONFORMANCE_CASES`: Collection of standardized test cases covering input validation, context policy, thread isolation, error conditions and the streams of runs and resumes. Every event of a stream a case reads must match `StreamEventSchema`, and nothing may follow its `finish` or `error`.
- `CONFORMANCE_ROUTES`: Standard test route mapping (`/agents/:name/run`, `/threads/:id/messages`, etc.).
- `CONFORMANCE_NAMES`: Standard test entity names (`assistant`, `team`, `flow`, `thread-1`).
- `CONFORMANCE_SWARM`: Standard swarm fixture with router and pipeline stages.
- `CONFORMANCE_GENERATED_THREAD`: Constant identifying generated thread assertions.
- `conformanceMethod(case)`: Resolves HTTP method for a conformance test case.
- `conformanceContentType(case)`: Resolves Content-Type header for a test case.
- `conformanceRunResult()`: Generates mock completed `RunResult`.
- `conformancePausedResult()`: Generates mock paused `RunResult` with pending tool approvals.
- `parseSseEvents(text)`: Parses raw SSE wire text into structured event objects for test assertions.
- `ConformanceCase`: Interface defining a test case.
- `ConformanceCheckOptions`: Custom status code and error code mapping options for `checkConformance` (e.g. for adapters following framework-specific error conventions).
- `ConformanceResponse`: Standardized response representation for adapter fetchers, with the answer's `headers` (names in lower case) for the cases that check `Retry-After`.
- `ConformanceRoute`: Union of supported conformance route names.
- `ConformanceServerOptions`: Adapter server options required by specific conformance test cases: `acceptContext`, `threadMessageRoles`, `limits`, `anonymous`, `forbiddenThreads` (threads the adapter's `authorizeThread` refuses), `deps` (what its `deps` hook returns) and `workflowCheckpoints` (the adapter's workflow checkpoint store, an empty one in the cases).

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
