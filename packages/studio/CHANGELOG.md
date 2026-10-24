# @cogitator-ai/studio

## 0.4.2

### Patch Changes

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

- Updated dependencies [[`2da3c07`](https://github.com/cogitator-ai/Cogitator-AI/commit/2da3c07a7409c6785d3dfdac276fa94f5ed8f9f8)]:
  - @cogitator-ai/types@0.74.0
  - @cogitator-ai/core@0.64.0
  - @cogitator-ai/workflows@0.14.15
  - @cogitator-ai/memory@0.26.3

## 0.4.1

### Patch Changes

- Updated dependencies [[`c5539d4`](https://github.com/cogitator-ai/Cogitator-AI/commit/c5539d41dc8611d9d8fae77a8e2b35f948f68bd1)]:
  - @cogitator-ai/types@0.73.0
  - @cogitator-ai/core@0.63.1
  - @cogitator-ai/memory@0.26.2
  - @cogitator-ai/workflows@0.14.14

## 0.4.0

### Minor Changes

- [#289](https://github.com/cogitator-ai/Cogitator-AI/pull/289) [`7d96a55`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d96a55a376770d0cce4d1d220fdad53f493b5bd) - Agent Skills from `SKILL.md` folders, todo lists with `write_todos`, and deferred tools found with `tool_search`.

  - `SkillRegistry` (core) finds skills in the Agent Skills format: folders with a `SKILL.md` whose YAML frontmatter gives `name` and `description`, next to the files the skill needs. It searches `dirs` (folders of skills, or a skill folder itself), a `project` folder on the host, with `user` the home folder, and the run's workspace (`.agents/skills`, `.cogitator/skills` and `.claude/skills` under its root, unless `workspace: false`), the first skill of a name winning. Host folders win over the workspace by default, so a skill a repository or the agent put there cannot replace one you chose, and `precedence: 'workspace'` puts the workspace first. Frontmatter is read leniently: a file without frontmatter or `description` is skipped, a name that breaks the format's rules or differs from its folder, a value of the wrong type or past its length and an unknown YAML tag are loaded with a warning, and every problem is in the catalog's `diagnostics` and logged once. Only metadata is kept (`name`, `description`, `license`, `compatibility`, `metadata`, `allowedTools`, `location`, `source`), the body and the files are read when the skill is activated. Host folders are scanned once per registry (`reload()` scans again), the workspace on every run, abortable with the run.
  - `AgentConfig.skills` takes a `SkillRegistry`, its configuration or any `SkillLoader` next to skills defined in code, whose tools and instructions still join the agent's. When skills are found, the system prompt ends with an `<available_skills>` section (names and descriptions, at most 12 000 characters of descriptions, then names only) and the run offers `use_skill({ skill })`, which returns the body of `SKILL.md` without its frontmatter (cut at `maxInstructionChars`, 20 000 by default, with a note where the rest is), the skill folder and its files. Files of a skill in the workspace are read with the agent's `read_file`, files of a host skill with `read_skill_file({ skill, path })`, which refuses paths that leave the skill folder, symlinks included. In the workspace a symbolic link is never followed, for a skill folder, the folders above it, its `SKILL.md` or its files, checked on every read. Activating a skill whose instructions are still in the conversation returns a short note, told apart by the skill's folder and workspace, so another agent's skill of the same name loads its own. An agent a handoff reaches gets its own skills. `allowed-tools` is kept on the skill and named to the model, not enforced. An invalid skills source fails the run with `CONFIGURATION_ERROR`, and an object that looks like a code skill but is not one is refused by the `Agent` constructor.
  - `AgentConfig.todos` gives the model `write_todos({ todos: [{ id, content, status }] })`. Each call replaces the list, ids are unique and at most one item is `in_progress`, else the call fails with a validation error. The list is read from the conversation and copied to the thread's metadata under `todos` (`{ items, entryId }`) by a run that saves to memory on the active branch. A later run whose history lost the list gets it from there when `entryId` is on its branch. The list is reported with the new `RunOptions.onTodos` and `RunObserver.onTodos` (also when a run starts from one), whose errors and failed metadata writes are logged without undoing the list, and returned as `RunResult.todos`. `todos` travels in the agent wire format and in snapshots.
  - `Tool.deferred` keeps a tool's schema out of the requests. A run whose agent has deferred tools offers `tool_search({ query, limit })`, which ranks them with BM25 over names, descriptions and parameter names and descriptions, identifiers split into words, and loads the best ones: their schemas are sent from the next turn on. The loaded tools are read back from the `tool_search` results in the conversation, so they stay loaded after a resume, in a fork, after a handoff and in later runs of the thread. A call to a deferred tool that was not loaded still runs, and a deferred tool forced with `toolChoice` is sent and stays loaded. The history budget counts the tools loaded in a `history` the run is given, and a history whose loaded tools push it past the window is cut to fit. Loading tools changes the tool list, and so the prompt cache prefix from that turn.
  - Clearing tool outputs leaves the run's own `use_skill` (the newest, up to 40 000 characters), `tool_search` and `write_todos` results alone, a tool of yours with one of these names is cleared as before. Compaction of a run's conversation puts the instructions of active skills (the newest, up to 40 000 characters, a note naming the rest) and the tools a search loaded back as system messages when it dropped them, and the newest todo list as a `write_todos` call and its result that checkpoints and `history` keep, one each however many compactions there are, and keeps room for them in the window. `ContextManager.compress()` takes the tokens to keep free, and `ToolRegistry.getSchemas()` a filter.
  - `Agent.clone()` merges the instructions of skills defined in code once, also clone after clone, where each clone used to add another copy.
  - Cogitator Studio shows a run's todo list in a Todos panel, updated live from the new `run.todos` host event, and keeps it in `RunRecord.todos`.
  - The `SkillLoader` interface of types, declared but never implemented, now describes a source of `SKILL.md` skills (`discover(context)` returning a `SkillCatalog`, `context.signal` aborting with the run), and `AgentConfig.skills` is typed `AgentSkillSource[]`.

### Patch Changes

- Updated dependencies [[`7d96a55`](https://github.com/cogitator-ai/Cogitator-AI/commit/7d96a55a376770d0cce4d1d220fdad53f493b5bd)]:
  - @cogitator-ai/types@0.72.0
  - @cogitator-ai/core@0.63.0
  - @cogitator-ai/memory@0.26.1
  - @cogitator-ai/workflows@0.14.13

## 0.3.21

### Patch Changes

- Updated dependencies [[`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b), [`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b)]:
  - @cogitator-ai/memory@0.26.0
  - @cogitator-ai/core@0.62.0
  - @cogitator-ai/types@0.71.0
  - @cogitator-ai/workflows@0.14.12

## 0.3.20

### Patch Changes

- Updated dependencies [[`213e3fb`](https://github.com/cogitator-ai/Cogitator-AI/commit/213e3fba0f0ed9a1290fdd1499dd4a0e4101b6e2)]:
  - @cogitator-ai/types@0.70.0
  - @cogitator-ai/core@0.61.1
  - @cogitator-ai/memory@0.25.6
  - @cogitator-ai/workflows@0.14.11

## 0.3.19

### Patch Changes

- Updated dependencies [[`091fa9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/091fa9e659341bc0f39344e46ec0c56ba0338f83)]:
  - @cogitator-ai/types@0.69.0
  - @cogitator-ai/core@0.61.0
  - @cogitator-ai/memory@0.25.5
  - @cogitator-ai/workflows@0.14.10

## 0.3.18

### Patch Changes

- Updated dependencies [[`8b099ce`](https://github.com/cogitator-ai/Cogitator-AI/commit/8b099ce06be7587aa7e350a0c3986eeb057c526e)]:
  - @cogitator-ai/types@0.68.0
  - @cogitator-ai/core@0.60.3
  - @cogitator-ai/memory@0.25.4
  - @cogitator-ai/workflows@0.14.9

## 0.3.17

### Patch Changes

- Updated dependencies [[`4c4ad3a`](https://github.com/cogitator-ai/Cogitator-AI/commit/4c4ad3a898675f7730236d1b2c6482b2fe108b32)]:
  - @cogitator-ai/types@0.67.0
  - @cogitator-ai/core@0.60.2
  - @cogitator-ai/memory@0.25.3
  - @cogitator-ai/workflows@0.14.8

## 0.3.16

### Patch Changes

- Updated dependencies [[`9b5004a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9b5004a447439427e934531f0ed7c4668f41ad30)]:
  - @cogitator-ai/types@0.66.0
  - @cogitator-ai/core@0.60.1
  - @cogitator-ai/memory@0.25.2
  - @cogitator-ai/workflows@0.14.7

## 0.3.15

### Patch Changes

- Updated dependencies [[`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899), [`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899)]:
  - @cogitator-ai/types@0.65.0
  - @cogitator-ai/core@0.60.0
  - @cogitator-ai/memory@0.25.1
  - @cogitator-ai/workflows@0.14.6

## 0.3.14

### Patch Changes

- Updated dependencies [[`e979cea`](https://github.com/cogitator-ai/Cogitator-AI/commit/e979cea3c2031e03c03adcf34eba97c1a8c8c698)]:
  - @cogitator-ai/core@0.59.0
  - @cogitator-ai/types@0.64.0
  - @cogitator-ai/memory@0.25.0
  - @cogitator-ai/workflows@0.14.5

## 0.3.13

### Patch Changes

- Updated dependencies [[`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357), [`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357)]:
  - @cogitator-ai/core@0.58.0
  - @cogitator-ai/types@0.63.0
  - @cogitator-ai/workflows@0.14.4
  - @cogitator-ai/memory@0.24.5

## 0.3.12

### Patch Changes

- Updated dependencies [[`2d00dd2`](https://github.com/cogitator-ai/Cogitator-AI/commit/2d00dd2dda98ab9aa59c1c7d38ad96b652d7979f)]:
  - @cogitator-ai/types@0.62.0
  - @cogitator-ai/core@0.57.0
  - @cogitator-ai/memory@0.24.4
  - @cogitator-ai/workflows@0.14.3

## 0.3.11

### Patch Changes

- Updated dependencies [[`afb3815`](https://github.com/cogitator-ai/Cogitator-AI/commit/afb3815d149086f411063b6a0cf2beaa299adcdc)]:
  - @cogitator-ai/memory@0.24.3
  - @cogitator-ai/core@0.56.4
  - @cogitator-ai/workflows@0.14.2

## 0.3.10

### Patch Changes

- Updated dependencies [[`a11b786`](https://github.com/cogitator-ai/Cogitator-AI/commit/a11b78613707a9092d7f0c49ed6982f239368e34)]:
  - @cogitator-ai/types@0.61.0
  - @cogitator-ai/core@0.56.3
  - @cogitator-ai/memory@0.24.2
  - @cogitator-ai/workflows@0.14.1

## 0.3.9

### Patch Changes

- Updated dependencies [[`3f81cdb`](https://github.com/cogitator-ai/Cogitator-AI/commit/3f81cdb928c80f4c70548911d4e6fd07cf2b1e52)]:
  - @cogitator-ai/workflows@0.14.0
  - @cogitator-ai/types@0.60.0
  - @cogitator-ai/core@0.56.2
  - @cogitator-ai/memory@0.24.1

## 0.3.8

### Patch Changes

- Updated dependencies [[`e205fef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e205fefeeabd060cf84e5a4b125c4c64e42d57c3)]:
  - @cogitator-ai/types@0.59.0
  - @cogitator-ai/memory@0.24.0
  - @cogitator-ai/core@0.56.1
  - @cogitator-ai/workflows@0.13.11

## 0.3.7

### Patch Changes

- Updated dependencies [[`a99a45a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a99a45a28af69326c4fc5e5453ccf188db85f682)]:
  - @cogitator-ai/types@0.58.0
  - @cogitator-ai/memory@0.23.0
  - @cogitator-ai/core@0.56.0
  - @cogitator-ai/workflows@0.13.10

## 0.3.6

### Patch Changes

- Updated dependencies [[`dedb431`](https://github.com/cogitator-ai/Cogitator-AI/commit/dedb4311ba307f4023d32c4e1391a4b166a58b76)]:
  - @cogitator-ai/types@0.57.0
  - @cogitator-ai/memory@0.22.0
  - @cogitator-ai/core@0.55.0
  - @cogitator-ai/workflows@0.13.9

## 0.3.5

### Patch Changes

- Updated dependencies [[`855d1bc`](https://github.com/cogitator-ai/Cogitator-AI/commit/855d1bc54282a487a4770e233091040831f05627)]:
  - @cogitator-ai/types@0.56.0
  - @cogitator-ai/memory@0.21.0
  - @cogitator-ai/core@0.54.0
  - @cogitator-ai/workflows@0.13.8

## 0.3.4

### Patch Changes

- Updated dependencies [[`d9caa65`](https://github.com/cogitator-ai/Cogitator-AI/commit/d9caa654df5b716feee2b66d46e3b8b717949c51), [`e83c1ef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e83c1efd7788d1df6b78e818599210e2b99153a7)]:
  - @cogitator-ai/types@0.55.0
  - @cogitator-ai/memory@0.20.0
  - @cogitator-ai/core@0.53.0
  - @cogitator-ai/workflows@0.13.7

## 0.3.3

### Patch Changes

- Updated dependencies [[`c29c8a0`](https://github.com/cogitator-ai/Cogitator-AI/commit/c29c8a00c9fce4a22af1c697246f065045a2f014)]:
  - @cogitator-ai/types@0.54.0
  - @cogitator-ai/memory@0.19.0
  - @cogitator-ai/core@0.52.0
  - @cogitator-ai/workflows@0.13.6

## 0.3.2

### Patch Changes

- Updated dependencies [[`99ceb01`](https://github.com/cogitator-ai/Cogitator-AI/commit/99ceb0107f7403fba0a95e31fd2d10b743144a03)]:
  - @cogitator-ai/types@0.53.0
  - @cogitator-ai/memory@0.18.0
  - @cogitator-ai/core@0.51.0
  - @cogitator-ai/workflows@0.13.5

## 0.3.1

### Patch Changes

- Updated dependencies [[`85d05b2`](https://github.com/cogitator-ai/Cogitator-AI/commit/85d05b20fe48738ee6ddcea83a043bb890b6d077)]:
  - @cogitator-ai/types@0.52.0
  - @cogitator-ai/memory@0.17.0
  - @cogitator-ai/core@0.50.0
  - @cogitator-ai/workflows@0.13.4

## 0.3.0

### Minor Changes

- [#225](https://github.com/cogitator-ai/Cogitator-AI/pull/225) [`c46adb9`](https://github.com/cogitator-ai/Cogitator-AI/commit/c46adb9429ef9686697a020d4d97634c907117d0) - Threads are trees of typed entries, runs and forks go on branches of them, and derived memory can point at what it stands on.

  - Every entry has a `parentId` (`null` at the root), a `seq` within its thread and a `type`, and a thread has an `activeLeafId`. `addEntry` goes on after the active leaf and moves it there in one step, takes an explicit `parentId` to write on another branch, and `activate: false` to leave the leaf where it is. Deleting an entry splices it out: its children follow its parent.
  - Entry types: `message`, `tool_result`, and the events `model_change`, `compaction`, `approval`, `interrupt`, `label` and `custom`, which carry an `event` payload. `getEntries` and `getPath` return only `message` and `tool_result` unless `types` asks for more (or `'all'`), so readers that know nothing of events keep seeing the conversation.
  - `getPath({ threadId, leafId?, limit?, before?, types? })` reads one branch from the root to its leaf, the newest `limit` entries and pages before an entry, without reading the whole thread. `rewind(threadId, toEntryId)` moves the leaf back along its branch and deletes nothing, `checkout(threadId, entryId)` makes any branch active, and `forkThread(threadId, atEntryId, newThreadId?)` copies a branch into a new thread (`metadata.forkOf` on the copies, `metadata.forkedFrom` on the thread). Every built-in adapter implements them, adapters of your own get them by extending the new `BranchingMemoryAdapter` and implementing `setActiveLeaf`, which must refuse an entry that is not in the thread.
  - Entries written before this version are chained by time when first met: Postgres moves its schema to version 2 on `connect()`, SQLite migrates by `user_version`, Redis and MongoDB chain a thread the first time it is read or written. Upgrade every process that shares a store together, as an older process appends without a parent.
  - `ContextBuilder` and the runtime read the active branch instead of the whole thread.
  - Compaction deletes nothing on adapters with branches: it adds a `compaction` entry at the end of the active branch that names the first kept entry (`CompactionEvent`) and holds the summary. `readCompactedHistory(memory, { threadId })` reads the conversation of a branch as that summary, the kept entries and everything after them, in pages back only to the compaction's start (`compactedHistory(path)` does the same for a path already read), and `ContextBuilder` and the runtime read history this way. Other branches and evidence keep the summarized entries, and `getEntries` still returns them. `sliding-window` leaves entries out the same way. A compaction whose active branch moved to another branch while the summary was written fails instead of writing a summary of the wrong conversation. Adapters without `getPath` compact as before.
  - Breaking: Redis keeps memory with no expiry by default (`ttl: 0`), where it used to expire after 24 hours. Pass `ttl` to keep the old behaviour. The in-process `memory` adapter counts `maxEntries` per thread, not across all threads, and evicts entries of inactive branches first.
  - Runs on branches: `RunOptions.branch: { fromEntryId, activate? }` reads history along the branch that ends at `fromEntryId` (`null` for none) and chains the run's entries after it, and `RunResult.memory` says where the run wrote (`threadId`, `branchPoint`, `leafId`). The runtime records `model_change` when it falls back to another model, `approval` when a run pauses and `interrupt` when one is aborted, and a paused run resumes on its branch. A run with `activate: false` does not take the thread's place for a paused run: it is resumed with its checkpoint, and never abandons the paused run of the conversation.
  - Time travel: checkpoints keep where their run wrote, and live replays and forks go on a branch of the original thread from where the run started, without moving its active leaf. Forks of one run no longer share a `replay_<runId>` thread and see each other's entries. A replay goes on a thread of its own when the checkpoint has no place in memory, its branch point is gone, the conversation before the run was edited, or the thread belongs to a user other than the new `ReplayOptions.userId` / `ForkOptions.userId`.
  - Lineage: `Evidence { entryId?, toolCallId?, fileRange?, quote }` and an optional `evidence` on facts, graph nodes and edges and insights. Every built-in fact and graph store keeps it (a new `evidence` column in Postgres and SQLite, added on connect, and a JSON property in Neo4j), updates take it and `mergeNodes` keeps the evidence of merged nodes. `verifyEvidence` checks that a quote appears in its entry or tool result word for word, `verifyEvidenceInMemory` checks a list against stored entries, and `evidenceOnPath` keeps derived items whose evidence lies on a branch.
  - Studio: a Tree panel next to the chat (`T`) shows every branch of a thread in memory, with forks, events and the run that wrote each entry.
  - `@cogitator-ai/test-utils`: conformance cases for trees, branches, paths, rewind and checkout, forks, entry types, splicing deletes, new roots, deleting a branch point, checkout of a deleted entry and concurrent appends.
  - MongoDB writes to a thread's tree under a short per-thread lease on the thread document, so concurrent processes cannot leave an entry under a deleted parent, and reads paths without loading whole ancestor lists into one document. Redis scripts name their keys, so they route correctly in cluster mode. SQLite keeps an explicit `seq` instead of `rowid`.

### Patch Changes

- Updated dependencies [[`c46adb9`](https://github.com/cogitator-ai/Cogitator-AI/commit/c46adb9429ef9686697a020d4d97634c907117d0)]:
  - @cogitator-ai/types@0.51.0
  - @cogitator-ai/memory@0.16.0
  - @cogitator-ai/core@0.49.0
  - @cogitator-ai/workflows@0.13.3

## 0.2.2

### Patch Changes

- Updated dependencies [[`92bcc11`](https://github.com/cogitator-ai/Cogitator-AI/commit/92bcc119e71742eaf2a4a3bffdeceaa18b153e5d)]:
  - @cogitator-ai/types@0.50.0
  - @cogitator-ai/memory@0.15.0
  - @cogitator-ai/core@0.48.0
  - @cogitator-ai/workflows@0.13.2

## 0.2.1

### Patch Changes

- Updated dependencies [[`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913), [`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913)]:
  - @cogitator-ai/types@0.49.0
  - @cogitator-ai/memory@0.14.0
  - @cogitator-ai/core@0.47.0
  - @cogitator-ai/workflows@0.13.1

## 0.2.0

### Minor Changes

- [#220](https://github.com/cogitator-ai/Cogitator-AI/pull/220) [`b42f62e`](https://github.com/cogitator-ai/Cogitator-AI/commit/b42f62ecd300cd945c42a91014b1297bc4e10c43) - Telemetry follows the OpenTelemetry GenAI semantic conventions, and runs that belong together share one trace.

  - Spans carry `gen_ai.*` attributes next to the existing `llm.*`, `tool.*` and `run.*` ones: `invoke_agent` on `agent.run`, `chat` on model calls (provider, request parameters, response id, finish reasons, token usage with cache reads, cache writes and reasoning), `execute_tool` on tool calls. `GEN_AI` names them all.
  - Streamed model calls record `gen_ai.response.time_to_first_chunk`.
  - Trace and span ids are W3C ids (32 and 16 hex characters) instead of `trace_…` and `span_…`. Code that parsed the old prefixes needs to treat ids as opaque strings. `agent.run` is now an `internal` span instead of `server`.
  - `RunOptions.trace` puts a run under a given parent, with `parseTraceparent` and `formatTraceparent` for W3C headers. A run started inside a tool of another run joins that run's trace under the tool's span, and `withTraceContext` does the same for any code.
  - `registerTelemetry(observer)` watches every runtime of the process, and `cogitator.recordSpan()` reports spans of your own orchestration to a runtime's observers.
  - `telemetry: { captureContent: true }` in the config, or `captureContent: true` on an observer, records system instructions, input and output messages, tool definitions, and tool arguments and results on the spans in the convention's JSON shapes. Observers that did not ask for content never receive it.
  - The OTLP exporter sends the convention's span names (`chat gpt-5.5`, `execute_tool search`, `invoke_agent researcher`) and array attributes, and keeps the Cogitator name as `cogitator.span_name`.
  - Workflows put agent runs under their node span, or under a `workflow.run` (`invoke_workflow`) span reported to the runtime's observers when no workflow tracer is on. Workflows running at once on one tracer no longer nest into each other. The `LLM_*` span attribute constants of workflows are deprecated in favour of `GEN_AI`.
  - Swarms report a `swarm.run` (`invoke_workflow`) span and run their agents under it, distributed swarms on their workers too.
  - A paused run reports its `agent.run` span with status `unset`, and a resumed run continues its trace. Time travel and learning traces are stored under the run id, since runs can now share a trace id: `timeTravel.compare()` and `getCheckpoints()` take a run id, and still take a trace id that belongs to one recorded run.
  - A workflow tracer given a `traceparent` with sampling flags `00` (through `setContextFromHeaders`) now leaves the workflow unsampled, as the caller asked, and the trace a workflow runs in takes precedence over a header the tracer kept from an earlier request.
  - The studio's trace inspector shows the instructions, prompt and response of every model call.

### Patch Changes

- Updated dependencies [[`b42f62e`](https://github.com/cogitator-ai/Cogitator-AI/commit/b42f62ecd300cd945c42a91014b1297bc4e10c43)]:
  - @cogitator-ai/core@0.46.0
  - @cogitator-ai/types@0.48.0
  - @cogitator-ai/workflows@0.13.0
  - @cogitator-ai/memory@0.13.3

## 0.1.12

### Patch Changes

- Updated dependencies [[`ed48837`](https://github.com/cogitator-ai/Cogitator-AI/commit/ed4883796a82b5f2b832a5bb45ba861fb0b17f45)]:
  - @cogitator-ai/core@0.45.0
  - @cogitator-ai/types@0.47.0
  - @cogitator-ai/workflows@0.12.12
  - @cogitator-ai/memory@0.13.2

## 0.1.11

### Patch Changes

- Updated dependencies [[`f68ebd8`](https://github.com/cogitator-ai/Cogitator-AI/commit/f68ebd892ee493279058212105381e8acb73b70e)]:
  - @cogitator-ai/core@0.44.0
  - @cogitator-ai/types@0.46.0
  - @cogitator-ai/workflows@0.12.11
  - @cogitator-ai/memory@0.13.1

## 0.1.10

### Patch Changes

- Updated dependencies [[`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b)]:
  - @cogitator-ai/memory@0.13.0
  - @cogitator-ai/core@0.43.0
  - @cogitator-ai/types@0.45.0
  - @cogitator-ai/workflows@0.12.10

## 0.1.9

### Patch Changes

- Updated dependencies [[`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22)]:
  - @cogitator-ai/types@0.44.0
  - @cogitator-ai/core@0.42.0
  - @cogitator-ai/memory@0.12.9
  - @cogitator-ai/workflows@0.12.9

## 0.1.8

### Patch Changes

- Updated dependencies [[`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765)]:
  - @cogitator-ai/core@0.41.0
  - @cogitator-ai/types@0.43.0
  - @cogitator-ai/workflows@0.12.8
  - @cogitator-ai/memory@0.12.8

## 0.1.7

### Patch Changes

- Updated dependencies [[`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd)]:
  - @cogitator-ai/types@0.42.0
  - @cogitator-ai/models@18.5.0
  - @cogitator-ai/core@0.40.0
  - @cogitator-ai/memory@0.12.7
  - @cogitator-ai/workflows@0.12.7

## 0.1.6

### Patch Changes

- [#199](https://github.com/cogitator-ai/Cogitator-AI/pull/199) [`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a) - Packages declare `"sideEffects": false`, so bundlers can leave out the modules an app does not use. None of them runs code at import time that depends on being kept. The repository URL in each package.json uses the `git+https` form npm expects.
- Updated dependencies [[`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a)]:
  - @cogitator-ai/core@0.39.1
  - @cogitator-ai/memory@0.12.6
  - @cogitator-ai/models@18.4.1
  - @cogitator-ai/types@0.41.1
  - @cogitator-ai/workflows@0.12.6

## 0.1.5

### Patch Changes

- Updated dependencies [[`9a31e38`](https://github.com/cogitator-ai/Cogitator-AI/commit/9a31e3897e0992061744bbcc5cf4075db2848b77), [`fba532a`](https://github.com/cogitator-ai/Cogitator-AI/commit/fba532a5fadc4d193f855c8aee0b44f48f9e0619)]:
  - @cogitator-ai/types@0.41.0
  - @cogitator-ai/core@0.39.0
  - @cogitator-ai/memory@0.12.5
  - @cogitator-ai/workflows@0.12.5

## 0.1.4

### Patch Changes

- [#155](https://github.com/cogitator-ai/Cogitator-AI/pull/155) [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292) - Decision models and OpenRouter as a built-in provider.

  - `cog.decide()` asks a decision model typed questions about a state and returns typed answers with probabilities instead of text: `noul` for yes or no, `choice` for one of several options, `score` for a level on a scale. Answers are typed by the questions, the request is checked before the call and the answer after it, and the call goes through the LLM retry policy, is checked against cost-routing budgets before it is sent, goes through `security.pii` masking or blocking, is priced and is reported to run observers as a run with one `llm.decide` span.
  - `decisionTool()` turns fixed questions into a tool an agent passes the state to.
  - OpenRouter's Decisions API is built in, with TypeSafe's Jev (`openrouter/typesafe/jev-1.13`). Other providers plug in through `llm.decisionBackends` and the `DecisionBackend` interface.
  - OpenRouter is a built-in provider for chat too: `llm.providers.openrouter` with `apiKey` and an optional `baseUrl`, or `OPENROUTER_API_KEY` through `@cogitator-ai/config`.
  - A chat run on a decision model fails at once with `CONFIGURATION_ERROR` instead of a provider error.
  - `LLMRetryPolicy` and `retryLLMCall` give calls that are not chat the retry policy of LLM backends.
  - `@cogitator-ai/models` knows Jev with its price, marks models with `kind: 'chat' | 'decision'` and adds `isDecisionModel()`.
  - Studio shows `llm.decide` spans.

  **Breaking:** a model string starting with `openrouter/` now runs on the OpenRouter provider. Before, the prefix stayed part of the model name on `llm.defaultProvider`.

- Updated dependencies [[`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292), [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292)]:
  - @cogitator-ai/core@0.38.0
  - @cogitator-ai/types@0.40.0
  - @cogitator-ai/models@18.4.0
  - @cogitator-ai/workflows@0.12.4
  - @cogitator-ai/memory@0.12.4

## 0.1.3

### Patch Changes

- [#153](https://github.com/cogitator-ai/Cogitator-AI/pull/153) [`60e8e89`](https://github.com/cogitator-ai/Cogitator-AI/commit/60e8e8930d7d7645bbf8dfe7a6ebf20da9d004ea) - A chat turn no longer sticks at "running" after its run finished. Right after sending, the studio loads the thread, and when that snapshot was taken while the run was still going but arrived after the event that it completed, it took the run back to running for good. Every run now has a `revision` that each change raises, streamed text included, and the UI keeps only the newer copy: a late snapshot no longer undoes an event, and text it already holds is not added twice. Revisions go on above those of a session before a restart.

  A run whose fork steps cannot be recorded still completes, without steps, and the studio log says why. It used to stay running.

## 0.1.2

### Patch Changes

- Updated dependencies [[`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e), [`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e)]:
  - @cogitator-ai/core@0.37.0
  - @cogitator-ai/types@0.39.0
  - @cogitator-ai/workflows@0.12.3
  - @cogitator-ai/memory@0.12.3

## 0.1.1

### Patch Changes

- Updated dependencies [[`d1a874c`](https://github.com/cogitator-ai/Cogitator-AI/commit/d1a874ce75b702eea77ca2a24945f383e8b63198)]:
  - @cogitator-ai/core@0.36.0
  - @cogitator-ai/types@0.38.0
  - @cogitator-ai/workflows@0.12.2
  - @cogitator-ai/memory@0.12.2

## 0.1.0

### Minor Changes

- [#139](https://github.com/cogitator-ai/Cogitator-AI/pull/139) [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa) - Cogitator Studio, a local debugger for agent projects: an overview of the project with its runs, success rate, spend, latency and daily activity, chat with every agent of the registry with streamed Markdown answers, highlighted code, LaTeX math, reasoning, tool calls and threads, approve or reject tool calls that need it, read each run as a waterfall of model calls, tool calls and nested agents with tokens and cost, and open any span for its details, run workflows with live node statuses and rerun them from a node, fork a finished run from any step with a changed input, context or tool result and compare both branches. A command palette (`⌘K`) reaches every agent, workflow, run and action, keyboard shortcuts cover the rest, and the light and dark themes follow the system. The project runs in a child process that reloads on save, and the history is kept in `.cogitator/studio/`.

### Patch Changes

- Updated dependencies [[`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa)]:
  - @cogitator-ai/core@0.35.0
  - @cogitator-ai/memory@0.12.1
  - @cogitator-ai/workflows@0.12.1
  - @cogitator-ai/types@0.37.0
