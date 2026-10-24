# @cogitator-ai/ai-sdk

## 0.10.0

### Minor Changes

- [#293](https://github.com/cogitator-ai/Cogitator-AI/pull/293) [`2da3c07`](https://github.com/cogitator-ai/Cogitator-AI/commit/2da3c07a7409c6785d3dfdac276fa94f5ed8f9f8) - Steer a run while it goes on, choose what a second message does to a busy thread, pause a run on a question a tool asks, and cancel a run without losing what it showed or did.

  Behavior changes, none of which needs a code change:

  - An aborted run (its `signal`, its timeout, `handle.abort()` or a newer run that interrupts it) now leaves more in its thread: the text it already streamed as an assistant message with `metadata.interrupted: true`, the results of tool calls that finished before the abort, and `Aborted before dispatch` for the calls it never started. Before, it left only its `interrupt` entry. A tool that ignores the signal still runs on, its late result is never written.
  - History read from memory now answers a tool call left without a result (a crash, an abort while the tool ran) with `The run stopped before this tool call returned: outcome unknown, verify before retrying`, instead of dropping the call from the assistant message. The model learns the call may have run. The log is not rewritten. Code that sends `history` of its own is not affected.
  - A paused run's `output` is the text of its last assistant message. For a pause on approvals this is what it always was.

  New:

  - `cog.start(agent, options)` returns a `RunHandle`: `steer(message)` adds a user message after the current step's tool calls (none is skipped) and wakes an agent about to stop, `followUp(message)` runs once the agent would stop (with a fresh `maxIterations`), `inject(message)` adds context to the next model call without waking the agent (one left at the end is saved to the thread), `abort(reason?)` stops the run and returns what it did not deliver, and `result` is what `run()` returns. `queue: { steering, followUp }` takes queued messages `'one-at-a-time'` (default) or `'all'` at once. Delivered messages are saved as `message` entries with `metadata.queued`, so a later run reads them as history, and a run that pauses returns the rest in `result.undelivered`. `run()` is unchanged.
  - `multitaskStrategy` (`RunOptions`, or `CogitatorConfig` for every run) says what a run does when another run of the runtime goes on in its thread, with the names of LangGraph's `multitask_strategy`: `enqueue` waits, `reject` fails with `THREAD_BUSY` (409), `interrupt` aborts the running one (it fails with `RUN_INTERRUPTED`, 409), `rollback` interrupts it and runs on a branch from where it started, so the thread goes on as if it never happened. Unset, runs of one thread go on side by side as before. A run started from a tool call of the run going on is never held back, other runs of the same trace follow the strategy.
  - Tools pause a run to ask a person with `context.interrupt({ reason, message, responseSchema, expiresAt })`. The run returns `status: 'paused'` with the question in `result.interrupts` (`id`, `kind: 'input'`, `reason`, `message`, `responseSchema` as JSON Schema, `expiresAt`, `toolCallId`, `toolName`), and `cog.resume(agent, thread, { responses: { [id]: answer } })` checks the answer against the schema and runs the tool again, where `interrupt()` returns it, parsed by a Zod schema. A wrong answer fails the resume with `INTERRUPT_ANSWER_INVALID` (400, `details.interruptId`), one after `expiresAt` with `INTERRUPT_EXPIRED` (410), and the run still waits. Finished calls of the same step keep their results. The pause and the resume are logged as `interrupt` entries (`status: 'paused' | 'resumed'`).
  - The run result wire format (`toAgentWireRunResult`) keeps `interrupts`, and `AgentRunPausedError` says when a workflow node or a swarm turn paused on questions instead of approvals.
  - Tool calls of a step run one after another, and the step stops at the first question: the calls after it run once the answer came. With `parallelToolCalls: true` the other calls run before the answer. Calls that finished keep their results, the checkpoint lists them in `turn.completed`, and a handoff among them hands over once the resumed step is done. A resume that leaves a question unanswered pauses on it again as it was asked, its tool not run again and its `expiresAt` unchanged. Answers are checked with the tool's Zod schema (refinements included) while the process that asked keeps it, else with the stored JSON Schema of the schema's input side.
  - A run with a `multitaskStrategy` is refused with `THREAD_ACCESS_DENIED` before it touches another user's run going on in the thread. A follow-up or steering message starts a new task, so its first tool call is never taken for a duplicate. `handle.abort()` is final: what it returns was never delivered or saved, also when it comes after the last model turn.
  - Queued messages pass the run's `beforeRun` input checks (PII in `block` mode, prompt injection, input guardrails, your own hooks) before they reach the model or the thread, injected messages saved at the end too. A refused message is dropped and listed in `handle.refused` with its error (`onRefusedMessage` in the options of `start()`), the run goes on.
  - A question that expired without an answer no longer holds the run: a resume answers its tool call with `Nobody answered "<message>" before it expired`, so other questions of the step can be answered alone. Calls of a step that never ran get "Not started" when the user moves on. A run whose signal aborted already, and a run of another user on a thread whose run has not written anything yet, change nothing on the thread.
  - `saveInterruptedReply: false` keeps an aborted run from saving its streamed text, and the voice runner uses it, so an interrupted voice turn keeps only what the caller heard, as before.
  - Resume a checkpoint with the same or a newer version: from this release the turn of a pause on a question lists all its calls, the finished ones in `turn.completed`, and an older version would run those again. The checkpoint stays `version: 1`.
  - `multitaskStrategy` is part of the config schema, so `defineConfig()` and `cogitator.yml` keep it.
  - Approvals are interrupts of `kind: 'approval'` keyed by tool call id: `result.interrupts` lists them, and `responses` decides them as `decisions` does. `decisions`, `defaultDecision` and `pendingApprovals` work as before. `RunCheckpoint` stays `version: 1` with optional `interrupts` and `iterationLimit`, older checkpoints resume as they did.
  - `@cogitator-ai/core` exports `ABORTED_BEFORE_DISPATCH`, `OUTCOME_UNKNOWN`, `repairUnansweredToolCalls()`, `APPROVAL_RESPONSE_SCHEMA` and `isToolInterrupt()` (rethrow it from a `wrapToolCall` middleware that catches tool errors). `@cogitator-ai/types` adds `RunHandle`, `StartOptions`, `QueuedRunMessage`, `MultitaskStrategy`, `RunInterrupt`, `InterruptRequest`, `ToolContext.interrupt` and the error codes `THREAD_BUSY`, `RUN_INTERRUPTED` and `INTERRUPT_EXPIRED`.
  - Server adapters (Express, Fastify, Hono, Koa, Tetsu, Next.js) take `multitaskStrategy` in run, stream and WebSocket run requests and `responses` in resume requests. A paused run that waits on questions of its tools carries them in `interrupts` of the JSON answer, the `finish` event and the WebSocket `complete` event, and its stream sends the new `interrupt-required` event instead of `approval-required`. `@cogitator-ai/server-shared` adds `runRequestRunOptions()`, `MULTITASK_STRATEGIES`, `createInterruptRequiredEvent()`, `toPendingInterrupts()`, `PendingInterrupt` and their schemas, and the OpenAPI document lists the new fields. `useCogitatorChat` keeps `pendingInterrupts`, calls `onInterruptRequired`, and resumes with `resume({ responses })`. With `multitaskStrategy: 'enqueue'` or `'reject'` it no longer aborts the request in flight when a new message is sent, and a refused message shows as an error without touching the running answer. Swarm routes ignore `multitaskStrategy` in every adapter. A stream refused or interrupted this way answers `200` with an `error` event carrying the code, the JSON routes `409` (`410` for `INTERRUPT_EXPIRED`).
  - The Gateway's `queueMode` takes the run strategies too: `enqueue` (the same as `sequential`), `reject` (a message for a busy thread runs nothing, reaches the new `message:rejected` hook, is never handed back to its channel, and makes `injectMessage` reject) and `rollback` (as `interrupt`, then the new message is answered on a branch from where the stopped answer started). Every gateway run names the strategy its queue mode stands for, so the runtime's `multitaskStrategy` never contradicts the queue (`parallel` names none). `sequential`, `parallel`, `interrupt` and `collect` work as before. Cogitator Studio labels pauses on questions and their answers in the thread tree.
  - Pauses on questions of tools never resume without answers anywhere. `pendingQuestions(result)` lists them, and `AgentRunPausedError` carries them in `interrupts`. A workflow `agentNode` fails with it, also with an approval store or `approvals: false`, where it used to resume without an answer forever. Swarm turns and queued workflow jobs fail the same way, and `JobQueue.resumeAgentJob` takes `responses`. The Gateway asks the question in the chat and takes the user's next message as the answer, and the voice runner says it and takes the caller's next turn. A2A tasks wait in `input-required` with an `interrupt-request` part and take the answer back (`A2AClient.answerQuestions()`). MCP servers ask through elicitation. The OpenAI-compatible APIs, Studio and delegated `agentAsTool` runs end with an error that names the questions, and the AI SDK provider warns with them (`providerMetadata.cogitator.pendingQuestions`).
  - `parseAnswer(text, schema)` and `answerFormat(schema)` (`@cogitator-ai/types`) read a typed or spoken answer by the question's schema and say what an answer looks like. `cog.pausedRun(threadId)` lists what a thread waits on, `cog.cancelPause(threadId, { userId, reason })` ends a pause with declined results. The Gateway shows the format with the question, tells a wrong answer in plain words, cancels a question with a cancel word (`approvals.cancelWords`, `cancel` by default) or after `approvals.maxAnswerAttempts` wrong answers (3), ends an expired one, and picks up a question waiting across a restart. The voice runner reads spoken answers the same way. A2A tasks keep their paused run by task, so a new task in the same context no longer answers the wrong run (the older task ends `canceled`), an expired question fails its task and lifts the pause, and text answers are read by the schema. MCP elicitation carries the schema's limits, asks again on a refused answer (3 times at most) and waits `elicitationTimeoutMs` (10 minutes by default) instead of 60 seconds.

### Patch Changes

- Updated dependencies [[`2da3c07`](https://github.com/cogitator-ai/Cogitator-AI/commit/2da3c07a7409c6785d3dfdac276fa94f5ed8f9f8)]:
  - @cogitator-ai/types@0.74.0
  - @cogitator-ai/core@0.64.0

## 0.9.1

### Patch Changes

- [#272](https://github.com/cogitator-ai/Cogitator-AI/pull/272) [`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899) - Channels: the gateway answers the messages of a thread one at a time and keys threads by conversation.

  This changes behavior for existing gateways:

  - `queueMode` defaults to `'sequential'`: a thread answers its messages in the order they came, one at a time, while different threads run side by side. A channel's message handler returns once the message is queued, so Telegram long polling and the Bluesky and Threads polls go on to other chats, button presses and stop buttons while a thread is busy. `injectMessage` resolves once the message is answered, and the new `gateway.idle()` waits until every queued message is.
  - Channels now confirm a message to their platform once it is queued, before it is answered: Telegram long polling moves its offset, Bluesky marks its notifications seen, Threads moves past the post. So `gateway.stop()` drains first: it flushes the debouncer and waits up to the new `drainTimeout` (default 30000 ms) for the queued messages and the runs in progress, then aborts the runs still going, drops what still waits, waits up to `drainTimeout` again for the aborted runs to settle and only then stops the channels. Messages that come in while it stops are dropped and reported to `onError`, a second `stop()` returns the same promise, and `RuntimeBuilder`'s `cleanup()` closes memory after it. `cogitator assistant` and `cogitator up` wait for it, quitting at once on a second Ctrl-C.
  - `injectMessage` rejects when the message was not answered: its run failed (also reported to `onError`, as before), `stop()` aborted or dropped it, or it came in while the gateway was stopping. `HeartbeatScheduler` records that as an error, and a one-shot task that fails stays pending and fires again on a later poll or after a restart (up to `maxRetries`, unless it is `bestEffort`) instead of being lost.
  - The default thread key is `channelType:conversation:userId` instead of `channelType:userId`. The conversation is the new `ChannelMessage.conversationId` when a channel sets it, else `channelId` plus `:topicId`. A user's private chat, each group, each Telegram forum topic, each Slack thread and each GitHub issue, pull request and review thread is a thread of its own.
  - Slack sets `topicId` to the `ts` of the Slack thread of a channel message. A top-level channel message is answered in a new Slack thread, a conversation of its own without the history of earlier ones, and `sendText` posts into the `topicId` thread when a reply names no message. A DM stays one conversation.
  - Bluesky and Threads set `conversationId` to `thread:<root>`, so the replies of one post thread stay in one thread while each answer still goes to its post. A WhatsApp direct chat addressed by LID sets `conversationId` to the person's phone-number jid when WhatsApp shares it, so it is one thread with the chat addressed by phone number. `userId` stays as before. `ChannelAction` and `ChannelStop` carry `conversationId` too, and the approval buttons check it.
  - Telegram gives a button press a `topicId` only in a forum topic or a private chat topic, as it does for messages, so Approve and Deny work in the reply threads of plain groups.
  - Runs get the `topicId` and `conversationId` of their message (`RunOptions`, `ToolContext`, the run middleware context and `invokeTool` options have both, and `@cogitator-ai/ai-sdk` passes them between the AI SDK and Cogitator tool contexts like the other channel fields, while workflows and swarms build no channel context), `schedule_task` stores them with the task and `HeartbeatScheduler` puts them on the message it fires, so a reminder set in a topic or a post thread fires there, even after the user moved on. A task without them is answered in the topic of the user's most recent conversation in its chat, taken from the conversations the gateway keeps in each user's session metadata (`conversations`, up to 50). `compactAll()` finds the threads of stored sessions there after a restart.
  - `stats.totalSessions` and `getSessions()` count conversations, not users, and the gateway keeps its bookkeeping of the 10000 most recent threads (`MAX_TRACKED_THREADS`).
  - New exports: `defaultThreadKey`, `legacyThreadKey`, `conversationOf`, `readConversations`, `CONVERSATIONS_KEY`, `MAX_TRACKED_THREADS` and the types `ConversationRef`, `StoredConversation` and `MessageProcessor`. `MessageQueue.push` returns a promise that settles once the message is done with, `true` when it was handled, and its processor may resolve `false` for a message it could not handle (`MessageProcessor`).

  Migration: to keep the old behavior, pass `queueMode: 'parallel'`, and pass `session: { threadKey: legacyThreadKey }` to keep the threads stored under the old key (their history is not found by the new one). With `legacyThreadKey`, `compactAll()` still finds the thread of every stored session, while any other custom `threadKey` leaves stored sessions to it and the gateway keeps no conversations. With `cogitator up`, set `session.queueMode: parallel` and `session.threadKey: legacy` in `cogitator.yml`.

- Updated dependencies [[`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899), [`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899)]:
  - @cogitator-ai/types@0.65.0
  - @cogitator-ai/core@0.60.0

## 0.9.0

### Minor Changes

- [#259](https://github.com/cogitator-ai/Cogitator-AI/pull/259) [`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357) - A full AI SDK provider, Cogitator agents as AI SDK agents, the conversation as messages instead of a transcript, and agent events as custom parts

  `createCogitatorProvider` carries the members of its specification, so `createProviderRegistry` takes it. Its embedding and image models throw `NoSuchModelError`, and so does an unknown agent, which used to throw a plain `Error` with the same message.

  `toAISDKAgent(cogitator, agent, settings?)` from the new `@cogitator-ai/ai-sdk/agent` entry point (ai@7) is a `ToolLoopAgent` on `cogitatorModel()`, an AI SDK agent for everything that takes one.

  The prompt no longer reaches the agent as a `User:` / `Assistant:` / `Tool:` transcript. Its trailing user messages are the input, and the turns before them are the run's history as messages, tool calls and their results included, through the new `RunOptions.history` in core: the conversation the caller holds, read instead of the thread's memory, refused when it holds a system message. A prompt that does not end with a user message is now refused, unless it answers tool approvals.

  `providerOptions.cogitator` (`providerMetadata.cogitator` on ai@4) takes `threadId`, `userId` and `saveHistory`. With a `threadId`, the memory thread is the history and only the new turn of the prompt is used. A call without one no longer saves its turn to a thread of its own, which nothing could read back, unless `saveHistory: true`.

  `v4` models report handoffs and model fallbacks inside the run as custom parts, `cogitator.handoff` and `cogitator.model-fallback`.

### Patch Changes

- Updated dependencies [[`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357), [`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357)]:
  - @cogitator-ai/core@0.58.0
  - @cogitator-ai/types@0.63.0

## 0.8.0

### Minor Changes

- [#207](https://github.com/cogitator-ai/Cogitator-AI/pull/207) [`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22) - `toAISDKTool()` and `convertToolsToAISDK()` take `{ invoker, onApproval }`. With an invoker (your `Cogitator`) every call goes through `cogitator.invokeTool`, so the guardrails, the sandbox of a sandboxed tool and `tool.timeout` apply, and approval works on every AI SDK major. A call the AI SDK asks approval for (`requiresApproval`) and approved through its approval flow (ai@6, ai@7: an approving `tool-approval-response` for the call in the last message) runs without being asked again. Messages usually come from the client, so set `experimental_toolApprovalSecret` to have the AI SDK refuse approvals your server did not sign. Other calls that need approval, every one on ai@4 and ai@5, which do not read `needsApproval`, or one the guardrails want approved, go to `onApproval`, then to `guardrails.onToolApproval`, and a call nobody decides fails with an error the model reads. The AI SDK has parsed the arguments with the tool's schema already, so they are not parsed again.

  Without options the AI SDK calls the tool's `execute` directly, as before.

### Patch Changes

- Updated dependencies [[`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22)]:
  - @cogitator-ai/types@0.44.0
  - @cogitator-ai/core@0.42.0

## 0.7.0

### Minor Changes

- [#205](https://github.com/cogitator-ai/Cogitator-AI/pull/205) [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765) - Tool names are checked where a tool is created. `tool()` (and `fromAISDKTool()` of `@cogitator-ai/ai-sdk`) throws a `TypeError` for a name that one of the providers refuses, naming the rule (letters, digits, `_` and `-`, starting with a letter or `_`, at most 64 characters, the strictest of OpenAI, Anthropic, Gemini and Bedrock) and a name that fits. Such a name used to fail only once a run sent it, as a 400 from the provider, or worked on one provider and broke on the next.

  `assertToolName(name)` throws the same error for tools built without `tool()`. `normalizeToolName(name)` turns any name into one that fits (`weather.get` becomes `weather_get`, a name too long is cut and ends with a hash of the whole one), `normalizeToolNames(names)` does the same for a set and keeps it distinct, `isProviderSafeToolName(name)` checks one, `TOOL_NAME_MAX_LENGTH` is 64. The MCP adapter uses them, `normalizeMCPToolName` gives the same names as before.

  `ToolRegistry.register()` and `registerMany()` warn when a different tool takes a name that is registered, since the model can only call one of them. `{ replace: true }` replaces on purpose without a warning. In a run, a tool of the agent still replaces a tool of the same name in `cogitator.tools` quietly.

  `A2AClient.asToolFromCard()` names the tool after the card in a form providers accept: `Research Agent` becomes `Research_Agent`. A handoff to an agent with a long name gets a `transfer_to_...` tool name cut to fit, with a hash, and handoffs to agents whose names come out the same (`Billing EU` and `Billing/EU`, names in other scripts) get a hash each, so the model can reach every one of them. Tools an agent writes for itself with `create_tool` are refused, and skipped when loaded, when their name breaks the rule.

  **Migration:** a tool whose name breaks the rule now throws when it is created. Rename it, or wrap a name built from data in `normalizeToolName()`. Names with dots or colons that only Gemini accepted are among them.

### Patch Changes

- Updated dependencies [[`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765)]:
  - @cogitator-ai/core@0.41.0
  - @cogitator-ai/types@0.43.0

## 0.6.1

### Patch Changes

- [#199](https://github.com/cogitator-ai/Cogitator-AI/pull/199) [`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a) - Packages declare `"sideEffects": false`, so bundlers can leave out the modules an app does not use. None of them runs code at import time that depends on being kept. The repository URL in each package.json uses the `git+https` form npm expects.
- Updated dependencies [[`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a)]:
  - @cogitator-ai/core@0.39.1
  - @cogitator-ai/types@0.41.1

## 0.6.0

### Minor Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - The AI SDK bridge keeps what used to get lost on the way:

  - `finishReason` reports how the agent's run ended: `length` for a truncated answer, `content-filter` for a filtered or refused one, `other` (raw `iteration-limit`) when tool calls used up the iterations, instead of always `stop`.
  - `doGenerate` and `doStream` agree: text the agent wrote before a tool call is part of both, and in JSON mode only the final answer is text, so `streamText` with `Output.object` parses like `generateText`.
  - Tool calls and results of earlier turns in a multi-turn prompt reach the agent in its transcript.
  - `toolChoice: 'none'` runs the agent without tools, a forced tool choice produces a warning.
  - `fromAISDK` replays reasoning parts with their provider metadata (Anthropic thinking signatures) and each tool call's provider metadata (`ToolCall.replay.providerMetadata`), sends tool results with images as image content and failed calls as `error-text`, and maps `content-filter` finishes.
  - `fromAISDKTool` passes the real tool call id as `toolCallId` and keeps `$defs`, `toAISDKTool` forwards `toolCallId` and shows the model media results as images through `toModelOutput`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Tool approvals survive the AI SDK bridge in both directions.

  - `toAISDKTool()` sets `needsApproval` from the Cogitator tool's `requiresApproval`, and `fromAISDKTool()` sets `requiresApproval` from `needsApproval`. Before, a tool that needed approval on one side ran unasked on the other.
  - An agent model whose run pauses for tool approvals no longer reports `finishReason: 'stop'` with an empty answer. `v3` and `v4` models (ai@6, ai@7) end the turn with `tool-calls` and a `tool-approval-request` per waiting call, and a `tool-approval-response` in the next prompt resumes the run. `v1` and `v2` models finish with `other` and a warning, with `status`, `threadId` and `pendingApprovals` in `providerMetadata.cogitator`.

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `RunOptions.toolChoice` sets which tools the model may or must call in a run. `'none'` holds for every turn. `'required'` or a named function forces a call on each turn until the model makes one, then the run goes back to `'auto'`, so the model answers from the results instead of calling tools until `maxIterations`. A named function the agent does not have fails the run with `VALIDATION_ERROR`.

  The OpenAI-compatible endpoints pass `tool_choice: 'required'` and a named function on to the run, where before they only narrowed the tools and a model could still answer in plain text. The AI SDK bridge forces `required` and a named tool of the agent the same way instead of warning that it cannot.

- Updated dependencies [[`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281)]:
  - @cogitator-ai/core@0.34.0
  - @cogitator-ai/types@0.36.0

## 0.5.0

### Minor Changes

- 33c567e: Remove the `AISDKModelWrapperOptions` type. No function ever accepted it (`fromAISDK` and `AISDKBackend` take only the AI SDK model, and its `defaultModel` had no effect), so code that imported it can drop the import.

### Patch Changes

- 79d9e12: The AI SDK backend reports the wrapped model's provider name without casting it to the built-in provider union, now that backends can name their own provider.
- Updated dependencies [9175c69]
- Updated dependencies [e70e482]
- Updated dependencies [8d520c0]
- Updated dependencies [1993d56]
- Updated dependencies [1369ed1]
- Updated dependencies [0bf2e44]
- Updated dependencies [bc76f42]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [1993d56]
- Updated dependencies [c117071]
- Updated dependencies [656499e]
- Updated dependencies [1993d56]
- Updated dependencies [bc76f42]
- Updated dependencies [656499e]
- Updated dependencies [bc76f42]
- Updated dependencies [b8c9eca]
- Updated dependencies [b8c9eca]
- Updated dependencies [9175c69]
- Updated dependencies [d35ef2a]
- Updated dependencies [db2e373]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [e2da4f9]
- Updated dependencies [6b7e672]
- Updated dependencies [49503b9]
- Updated dependencies [a36cde4]
- Updated dependencies [ae26101]
  - @cogitator-ai/core@0.26.0
  - @cogitator-ai/types@0.29.0

## 0.4.0

### Minor Changes

- 7bee3ef: Reasoning models and prompt caching work the same way on every provider.

  - **Reasoning.** `reasoning: { effort, budgetTokens?, summary? }` on an agent, a run or a `ChatRequest` (`effort` from `none` to `max`). Anthropic and Bedrock get adaptive thinking with the closest effort the Claude model accepts (`disabled` / `between_tools` / lowest effort for `none`, a thinking budget on Claude 3.7 – 4.5); OpenAI gets `reasoning.effort` and summaries; OpenAI-compatible servers `reasoning_effort`; Gemini `thinkingLevel` (3+) or `thinkingBudget` (2.5) with `includeThoughts`; Ollama `think`. The summary comes back as `ChatResponse.reasoning` / `delta.reasoning`, `RunResult.reasoning` and `onReasoning`; server adapters, Next.js handlers and hooks, and the AI SDK adapter stream it as `reasoning-start` / `reasoning-delta` / `reasoning-end` parts.
  - **Thinking across tool calls.** Claude thinking blocks (Anthropic and Bedrock) are kept with the tool calls they preceded and sent back during the tool loop — only after the latest user message, since they are bound to the conversation that produced them — and a request whose replayed blocks the API refuses is retried once without them.
  - **Prompt caching.** Agent runs cache by default (`llm.promptCache`, `false` turns it off): Anthropic requests carry `cache_control`, Bedrock requests cache points; every backend reports `usage.cachedInputTokens` / `cacheWriteTokens` / `reasoningTokens`. `@cogitator-ai/models` prices cache reads and writes (`inputCached`, new `inputCacheWrite`, `calculateCost()`), so run costs account for them.

  **Fixes:** Anthropic and Bedrock `inputTokens` now include cache reads and writes (they counted only uncached input); Gemini `outputTokens` now include thinking tokens (`thoughtsTokenCount`), which were billed but not counted.

### Patch Changes

- Updated dependencies [a7cb81b]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/core@0.24.0
  - @cogitator-ai/types@0.27.0

## 0.3.1

### Patch Changes

- c4a4252: Agents can run on backends of your own. `llm.backends` takes `LLMBackend` instances by name: an agent with model `name/model` or `provider: 'name'` runs on it, and a name of a built-in provider replaces it. Backend plugins registered with `registerLLMBackend()` are now used by the runtime, created on first use with their config from `llm.plugins`; before, the registry was never consulted. A provider nobody provides fails with `CONFIGURATION_ERROR`. `cogitator.route(model)` returns the backend and model name a run uses. With `fromAISDK()`, any AI SDK model now runs Cogitator agents, tools included.
- 6404340: `llm.defaultModel` and `limits` now do what they say.

  - An agent may leave out `model` (`AgentConfig.model` is optional): it runs on the Cogitator's `llm.defaultModel`, and a run without either fails with a `CONFIGURATION_ERROR` naming the agent. `cogitator.resolveModel(agent)` returns the model a run uses. **Breaking for types:** `Agent.model` is `string | undefined`.
  - `limits.maxConcurrentRuns` caps concurrent `run()` calls; the rest wait in order, and their timeout and abort signal cover the wait.
  - `limits.defaultTimeout` applies to runs whose options and agent set no timeout. The 120 s default moved from the `Agent` constructor to the runtime, so `agent.config.timeout` is `undefined` unless set.
  - `limits.maxTokensPerRun` is checked before every model call and fails the run with the new `RUN_TOKEN_LIMIT_EXCEEDED` code.
  - Swarms: the assessor and the distributed coordinator resolve models through the Cogitator, so agents without a model work there too (`Assessor.analyze()` takes an optional resolver).

- Updated dependencies [480f2a3]
- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [22f47c9]
- Updated dependencies [51d581e]
- Updated dependencies [5b12191]
- Updated dependencies [f36a121]
  - @cogitator-ai/core@0.22.0
  - @cogitator-ai/types@0.25.0

## 0.3.0

### Minor Changes

- Support AI SDK 4, 5, 6 and 7. `cogitatorModel()`/`createCogitatorProvider()` detect the installed `ai` major (v1/v2/v3/v4, override via `specificationVersion`) at runtime and in the types, so existing ai@4 code keeps compiling and running. Agent tool calls are reported as provider-executed tool calls instead of client tool calls, so the AI SDK no longer runs them again. `fromAISDK()` wraps LanguageModelV1–V4. `toAISDKTool()` emits `inputSchema` plus `parameters` and passes the tool context through.

  **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.21.0
  - @cogitator-ai/types@0.24.0

## 0.2.16

### Patch Changes

- Internal peer dependencies are now declared as version ranges instead of exact pins, so the package keeps installing cleanly alongside newer 0.x releases of @cogitator-ai/core.
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.20.0
  - @cogitator-ai/types@0.23.0

## 0.2.15

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.4
  - @cogitator-ai/types@0.22.3

## 0.2.14

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/core@0.19.3

## 0.2.13

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.2
  - @cogitator-ai/types@0.22.2

## 0.2.12

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.1
  - @cogitator-ai/types@0.22.1

## 0.2.11

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.7

## 0.2.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.6

## 0.2.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3
  - @cogitator-ai/core@0.18.5

## 0.2.8

### Patch Changes

- @cogitator-ai/core@0.18.4

## 0.2.7

### Patch Changes

- @cogitator-ai/core@0.18.3

## 0.2.6

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/core@0.18.2

## 0.2.3

### Patch Changes

- fix(ai-sdk): audit — 8 bugs & type fixes, +45 tests
  - Fix createCogitatorProvider: now accepts explicit agents config instead of broken unsafe cast
  - Fix fromAISDKTool: throw on missing execute instead of returning undefined
  - Fix AISDKBackend: derive provider from model instead of hardcoding 'openai'
  - Fix type: Partial<ToolCall> -> ToolCall where all fields always present
  - Remove unused @ai-sdk/provider-utils dependency
  - Add 45 unit tests (tools, provider, model-wrapper)
  - Exclude tests from tsc build output

## 0.2.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.1

## 0.2.1

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.18.0
  - @cogitator-ai/types@0.20.0

## 0.2.0

### Minor Changes

- feat(next): add @cogitator-ai/next package for Next.js App Router integration
  - createChatHandler / createAgentHandler for streaming API routes
  - useCogitatorChat / useCogitatorAgent React hooks
  - AI SDK useChat compatible streaming protocol
  - Full TypeScript support

  feat(ai-sdk): add @cogitator-ai/ai-sdk package for Vercel AI SDK compatibility
  - cogitatorModel() - use Cogitator agents with generateText/streamText
  - fromAISDK() - use AI SDK models in Cogitator agents
  - Tool conversion utilities (fromAISDKTool, toAISDKTool)
  - Full streaming support with LanguageModelV1 interface
