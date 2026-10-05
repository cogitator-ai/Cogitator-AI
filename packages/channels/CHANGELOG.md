# @cogitator-ai/channels

## 0.8.2

### Patch Changes

- Updated dependencies [[`7bffbeb`](https://github.com/cogitator-ai/Cogitator-AI/commit/7bffbeb32394ea52a5662eac5fd104e8e76ed32a)]:
  - @cogitator-ai/core@0.30.3
  - @cogitator-ai/browser@0.4.5

## 0.8.1

### Patch Changes

- [#117](https://github.com/cogitator-ai/Cogitator-AI/pull/117) [`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b) - npm keywords for every package, so a search for what a package does finds it, and packages are now published with provenance: npm shows that each version was built and signed by the repository's release workflow, from which commit.
- Updated dependencies [[`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b)]:
  - @cogitator-ai/browser@0.4.4
  - @cogitator-ai/core@0.30.2
  - @cogitator-ai/mcp@19.2.7
  - @cogitator-ai/memory@0.11.5
  - @cogitator-ai/models@18.2.1
  - @cogitator-ai/rag@0.5.3
  - @cogitator-ai/types@0.33.1

## 0.8.0

### Minor Changes

- [#115](https://github.com/cogitator-ai/Cogitator-AI/pull/115) [`7886808`](https://github.com/cogitator-ai/Cogitator-AI/commit/7886808f11282b2d3a0c6820ba593417865f9139) - Telegram on the current Bot API, and buttons, stops and topics for every channel.

  Telegram:

  - Markdown goes out as a rich message (Bot API 10.1), so an agent's headings, tables, code blocks, task lists, footnotes and formulas render as written, up to 32,768 characters. A refused rich message falls back to classic Markdown, then plain text. `richMessages: false` keeps classic Markdown.
  - Streaming uses rich drafts with a stop button. A press stops the run and keeps what was written as the reply.
  - Inline buttons with colors, URLs, copy-text and disabled buttons, and their presses.
  - Topics, `@username` chat ids, captions, GIFs and voice notes, albums, silent, protected, ephemeral and effect messages, link preview options.
  - Command menus by scope and language, the bot's name and descriptions, and `call(method, args)` for any other Bot API method.
  - `format: 'html'` now sends HTML; it was sent as plain text.
  - Every call goes through grammY's raw API, so newer Bot API methods work on any grammY version.

  Gateway:

  - Tool approval prompts carry Approve and Deny buttons on channels with buttons; a press answers like the reply words, and counts only from the user the prompt asked while their run is paused. `approvals.buttons`, `approvals.buttonLabels` and `approvals.expiredMessage` configure them.
  - Other button presses reach the new `action:received` hook.
  - Replies, streams and typing stay in the topic a message came from.
  - Channels that render Markdown themselves (`nativeMarkdown`) get it as written, and `maxMessageChars` sets their own limit.

  Types: `ChannelButton`, `ChannelAction`, `ChannelStop`, `ChannelCommand`, `DraftOptions`, `ActionReceivedEvent`, new `SendOptions` fields, `Attachment.caption`, `ChannelMessage.topicId`, `StreamConfig.stopButton`, and optional `Channel` members for albums, actions, stops and command menus. `sendFile` may resolve with the message id.

### Patch Changes

- Updated dependencies [[`7886808`](https://github.com/cogitator-ai/Cogitator-AI/commit/7886808f11282b2d3a0c6820ba593417865f9139)]:
  - @cogitator-ai/types@0.33.0
  - @cogitator-ai/browser@0.4.3
  - @cogitator-ai/core@0.30.1
  - @cogitator-ai/mcp@19.2.6
  - @cogitator-ai/memory@0.11.4
  - @cogitator-ai/rag@0.5.2

## 0.7.6

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/core@0.30.0
  - @cogitator-ai/types@0.32.0
  - @cogitator-ai/browser@0.4.2
  - @cogitator-ai/mcp@19.2.5
  - @cogitator-ai/memory@0.11.3
  - @cogitator-ai/rag@0.5.1

## 0.7.5

### Patch Changes

- Updated dependencies [[`f9bada3`](https://github.com/cogitator-ai/Cogitator-AI/commit/f9bada3e466b559f22c5906cf9639e00151b6cb8)]:
  - @cogitator-ai/core@0.29.0
  - @cogitator-ai/browser@0.4.1

## 0.7.4

### Patch Changes

- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/core@0.28.0
  - @cogitator-ai/mcp@19.2.4
  - @cogitator-ai/memory@0.11.2
  - @cogitator-ai/types@0.31.0
  - @cogitator-ai/rag@0.5.0
  - @cogitator-ai/browser@0.4.0

## 0.7.3

### Patch Changes

- Updated dependencies [[`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`13f8ca5`](https://github.com/cogitator-ai/Cogitator-AI/commit/13f8ca50083debbadeebbc2e30e4432c3234b0fe), [`9c8ca91`](https://github.com/cogitator-ai/Cogitator-AI/commit/9c8ca914282662b93d0a42f5913c2dde8064eb57), [`12ac6a8`](https://github.com/cogitator-ai/Cogitator-AI/commit/12ac6a851f60fdbdafcc7a05aa8aa65e91426572), [`a208f5f`](https://github.com/cogitator-ai/Cogitator-AI/commit/a208f5f123b6ba86e58223829fd8435ba766c5e9), [`65786f6`](https://github.com/cogitator-ai/Cogitator-AI/commit/65786f66fc66bac3ee0997c7a467546b403e07c7), [`69ff26f`](https://github.com/cogitator-ai/Cogitator-AI/commit/69ff26fff42fe23e5be9ec3eef483837f304aac6), [`f6f8c58`](https://github.com/cogitator-ai/Cogitator-AI/commit/f6f8c58a837be665febfb99d2b670e913df2ff36), [`5caa2aa`](https://github.com/cogitator-ai/Cogitator-AI/commit/5caa2aa17e737fb7c5fcd56f3acab57744af7217), [`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2)]:
  - @cogitator-ai/core@0.27.0
  - @cogitator-ai/rag@0.4.0
  - @cogitator-ai/memory@0.11.1
  - @cogitator-ai/models@18.2.0
  - @cogitator-ai/types@0.30.0
  - @cogitator-ai/browser@0.3.9
  - @cogitator-ai/mcp@19.2.3

## 0.7.2

### Patch Changes

- Updated dependencies [[`de07e80`](https://github.com/cogitator-ai/Cogitator-AI/commit/de07e80fd5a1b4b066dc1d4e8710716a53959d41)]:
  - @cogitator-ai/core@0.26.2
  - @cogitator-ai/browser@0.3.8

## 0.7.1

### Patch Changes

- Updated dependencies [9a7b6f4]
  - @cogitator-ai/core@0.26.1
  - @cogitator-ai/browser@0.3.7

## 0.7.0

### Minor Changes

- f43f6af: `RuntimeBuilder` now wires what the gateway supports: `channels.whatsapp` and `channels.webchat` in the assistant config (WebChat requires `WEBCHAT_TOKEN`), an `approvals` config block, and `hooks` / `approvals` builder options passed to the gateway. Previously only Telegram, Discord and Slack could be configured and hooks or approval settings never reached the gateway.
- 8d520c0: Gateway hooks are typed per hook name. `HookPayloads` maps every hook to its payload (`MessageReceivedEvent`, `AgentErrorEvent`, `ApprovalResolvedEvent`, ...), so `hooks.on('agent:error', (e) => e.error.message)` type-checks instead of receiving `unknown`; handlers typed with an `unknown` payload are still accepted. The `agent:error` payload now always carries an `Error`. `GatewayConfig.owner`, which the gateway never read, is deprecated in favour of `ownerIds` on `ownerCommands` and `dmPolicy`.

### Patch Changes

- 8963e1e: `DmPolicyMiddleware` now expands a leading `~` in `storePath`. Previously a path like `~/.cogitator/dm-allowlist.json` created a literal `~` directory in the working directory when the middleware was used outside `RuntimeBuilder`.
- 1df914a: `HeartbeatScheduler` now honours stores that claim timers (`claimTtl`, `renew`, `release`), like the workflows `TimerManager`: it renews the claim before a task fires and every `claimTtl / 3` while it runs, skips a task whose claim was taken over (new `onClaimLost` callback), and releases disabled, exhausted and not-yet-processed tasks so other workers are not blocked by its lease.
- Updated dependencies [9175c69]
- Updated dependencies [fede839]
- Updated dependencies [e70e482]
- Updated dependencies [8d520c0]
- Updated dependencies [a3c2ee1]
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
- Updated dependencies [e7925d5]
- Updated dependencies [b8c9eca]
- Updated dependencies [bb17767]
- Updated dependencies [b8c9eca]
- Updated dependencies [9175c69]
- Updated dependencies [7e42e10]
- Updated dependencies [7e42e10]
- Updated dependencies [e7925d5]
- Updated dependencies [d35ef2a]
- Updated dependencies [4a2925f]
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
  - @cogitator-ai/browser@0.3.6
  - @cogitator-ai/memory@0.11.0
  - @cogitator-ai/mcp@19.2.2
  - @cogitator-ai/rag@0.3.5

## 0.6.1

### Patch Changes

- 1368ff8: `RuntimeBuilder` takes the config as written (`AssistantConfigInput`) and applies the schema itself, so a config built in code no longer has to spell out fields that have defaults (`memory.autoExtract`, `memory.knowledgeGraph`, channel policies); an invalid config throws when the builder is created.
- e561607: The WhatsApp channel supports Baileys 7 (`@whiskeysockets/baileys` 7.x, now its `latest`) next to 6.x. When WhatsApp addresses a person by LID, the message's `userId` is still their phone number from `remoteJidAlt` / `participantAlt` whenever WhatsApp shares it, so owner lists and per-user memory keep matching.
- Updated dependencies [e211b6a]
- Updated dependencies [db8ebaf]
- Updated dependencies [333e4ad]
- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [452a248]
- Updated dependencies [57ac053]
- Updated dependencies [7482f93]
- Updated dependencies [b8c7c3d]
- Updated dependencies [35701f9]
  - @cogitator-ai/core@0.25.0
  - @cogitator-ai/mcp@19.2.1
  - @cogitator-ai/memory@0.10.0
  - @cogitator-ai/types@0.28.0
  - @cogitator-ai/browser@0.3.5
  - @cogitator-ai/rag@0.3.4

## 0.6.0

### Minor Changes

- 7bee3ef: Runs pause for a person to approve sensitive tool calls and continue later.

  - A tool with `requiresApproval` never runs without a decision. `RunOptions.onApproval` (or `guardrails.onToolApproval`) decides inline; otherwise the run pauses before executing the turn and returns `status: 'paused'`, `pendingApprovals` and a JSON `checkpoint`. `cogitator.resume(agent, threadId | checkpoint, { decisions, defaultDecision, userId })` executes the approved calls, answers declined ones with the reason, and goes on. A new message on the thread instead declines the waiting calls.
  - Paused runs are kept per thread in the memory adapter's thread metadata (`ThreadRunCheckpointStore`), in process memory without memory (`InMemoryRunCheckpointStore`), or in `runCheckpoints`. Resuming by thread checks the caller (`THREAD_ACCESS_DENIED`); a thread with nothing paused answers the new `RUN_NOT_PAUSED` (409).
  - `agentAsTool` passes the caller's `userId` to the delegated run and declines its approvals unless given `onApproval`, instead of reporting a paused sub-run as success.
  - Server adapters answer paused runs with `status` / `pendingApprovals` (never the checkpoint), stream `approval-required`, and take `POST /agents/:name/resume` (plus a WebSocket `resume` message); Next.js has `createResumeHandler` and `pendingApprovals` / `approve()` / `deny()` in its hooks; channels ask in the chat and resume on "approve" / "deny <reason>" (also "да" / "нет").

  **Behaviour change:** `requiresApproval` used to be enforced only with constitutional guardrails and an `onToolApproval` callback; without them such tools ran unasked. They now pause the run. WebSocket `complete` events no longer include a paused run's checkpoint.

### Patch Changes

- Updated dependencies [a7cb81b]
- Updated dependencies [0933009]
- Updated dependencies [997e911]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/core@0.24.0
  - @cogitator-ai/models@18.1.0
  - @cogitator-ai/types@0.27.0
  - @cogitator-ai/mcp@19.2.0
  - @cogitator-ai/browser@0.3.4
  - @cogitator-ai/memory@0.9.1
  - @cogitator-ai/rag@0.3.3

## 0.5.1

### Patch Changes

- ed996c4: One agent can serve many users without them seeing each other's conversations or memory.

  - **Threads have owners.** The run that creates a thread records its `userId` (`thread.metadata.userId`). A run that passes a `threadId` continues it only for its owner and otherwise fails with the new `THREAD_ACCESS_DENIED` (403) before any history is loaded; a thread that cannot be read fails with `MEMORY_READ_FAILED` instead of being recreated without its owner. `RunOptions.threadAccess: 'shared'` opts out for threads your server derives itself (channels uses it, so group chats keep working). `assertThreadAccess`, `ensureThreadAccess`, `threadOwner` and `threadMetadata` are exported for your own endpoints.
  - **Memory is scoped by user.** `ContextBuilder.build({ userId })` leaves out facts, embeddings and knowledge graph nodes whose `metadata.userId` belongs to someone else; memory without an owner stays shared. The vector search filters in the adapter (`filter.userId` on the in-memory, Postgres and Qdrant adapters), so other users' memories cannot crowd out the user's own. Agent runs build the context for their `userId`, and the runtime now hands the context builder the memory adapter's facts and embeddings and the `memory.embedding` service, so `includeFacts`, `includeSemanticContext` and the `relevant`/`hybrid` strategies work in runs.
  - **Swarms and worker jobs** carry `userId` (`SwarmRunOptions.userId`, `addAgentJob(..., { userId })`) to every agent run.
  - **Server adapters** scope `/threads/:id` (read, append, clear) to the authenticated user and pass it to agent, stream, WebSocket and swarm runs. hono and koa now pass `auth`'s `userId` to runs at all (HTTP and WebSocket); next answers a run's `CogitatorError` with its status and `code` instead of 500, and chat streams cancel the run on client disconnect even after the Request object is no longer referenced. The shared OpenAPI spec lists the 403 of `/threads/:id` and agent runs.

  **Behaviour change:** threads created before, or by runs without a `userId`, have no owner and are open only to callers without one. Hand such a thread to a user by setting `metadata.userId` with `updateThread`.

- Updated dependencies [9ff5a06]
- Updated dependencies [8bdf656]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0
  - @cogitator-ai/core@0.23.0
  - @cogitator-ai/mcp@19.1.0
  - @cogitator-ai/memory@0.9.0
  - @cogitator-ai/browser@0.3.3
  - @cogitator-ai/rag@0.3.2

## 0.5.0

### Minor Changes

- 9eae101: Slack: answer @mentions in channels. The adapter only listened to `message` events, so a mention delivered as `app_mention` (the documented subscription) was dropped. Mentions are now handled, the `<@bot>` token is stripped from the text, a message that arrives both as `message` and `app_mention` is handled once, and the new `mentionOnly` option ignores channel messages that do not mention the bot. `RuntimeBuilder` now passes `SLACK_APP_TOKEN` (Socket Mode) and `SLACK_PORT`, and warns when Slack falls back to HTTP mode; `cogitator wizard` and `cogitator init` ask for the app token.

### Patch Changes

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
  - @cogitator-ai/browser@0.3.2
  - @cogitator-ai/mcp@19.0.1
  - @cogitator-ai/memory@0.8.1
  - @cogitator-ai/rag@0.3.1

## 0.4.1

### Patch Changes

- Updated dependencies [4940750]
  - @cogitator-ai/core@0.21.1
  - @cogitator-ai/browser@0.3.1

## 0.4.0

### Minor Changes

- Local Whisper returned an empty transcript with transformers.js 4; it now uses the public `return_timestamps: false` option and installs pinned dependency ranges.
- Scheduler uses cron-parser 5; OpenAI STT defaults to `gpt-transcribe`.
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/browser@0.3.0
  - @cogitator-ai/core@0.21.0
  - @cogitator-ai/mcp@19.0.0
  - @cogitator-ai/memory@0.8.0
  - @cogitator-ai/models@18.0.0
  - @cogitator-ai/rag@0.3.0
  - @cogitator-ai/types@0.24.0

## 0.3.0

### Minor Changes

- Full first audit of @cogitator-ai/channels: 59 issues found and fixed. Security fixes: any paired (non-owner) user could approve others via /pair; self-config tools let any chat user read or rewrite the config and .env (now owner/terminal only, with newline-injection protection and 0600 files); fileSystem.paths was only a prompt hint (file tools are now sandboxed, symlink-aware). Gateway bugs: a user-supplied sessionManager was ignored; compaction targeted the empty session-record thread and the 'summary' was just text truncation (now an LLM summary on the real thread, keeping the documented message-count threshold); interrupt mode never aborted runs; debounce bypassed the queue; a 90 s timer leaked per streamed message; streaming skipped platform markdown conversion; stats were hard-coded to 0. StreamBuffer lost text when splitting at the platform limit. Scheduler: cron tasks fired every 60 s (now uses cron-parser with timezone support) and a single store error stopped the scheduler for good. Channels: Telegram webhook mode never served updates; Discord DMs never arrived and long streamed answers spammed duplicate chunks; Slack had no groupId and used the wrong thread_ts; WhatsApp edits used the wrong key shape, stop() triggered reconnects, and the QR code was never shown (printQRInTerminal is deprecated); WebChat left unauthorized sockets open and crashed on EADDRINUSE; the terminal channel called process.exit(0) inside gateway.stop(). RuntimeBuilder: postgres config was silently ignored; date and core facts in instructions froze at startup; owner commands had no handlers; the Playwright cache path was macOS-only. Media and formatters: several decode and format bugs fixed. Docs, examples and the root README were corrected.

  **Breaking changes**
  - Channel adapters (Telegram, Discord, Slack, WhatsApp, WebChat) now throw from sendText/editText/sendFile/deleteMessage when not started, when the target is unavailable, or when the platform rejects the call. Previously they returned '' or swallowed the error.
  - DiscordChannel.sendText returns the id of the first chunk (was the last). Continuation chunks are tracked and edited or deleted together with it.
  - OwnerCommandsConfig.onCompact now receives a second threadId argument.
  - PairingMiddleware: only owners can approve /pair codes; approved non-owners no longer can.
  - TerminalChannel: Ctrl+C, Ctrl+D and /quit call onExit (default: raise SIGINT) instead of process.exit(0); stop() no longer exits the process.
  - StreamBuffer.forceNewMessage() now commits buffered text instead of discarding it. Splitting at maxMessageChars respects the limit and loses no text. replyTo applies to the first message only.
  - RuntimeBuilder: file tools are restricted to capabilities.fileSystem.paths; self-config tools work only for channel owners and the terminal; the gateway agent is now a per-message factory (BuiltRuntime.agent is still the base agent).
  - Gateway: compaction runs when the conversation thread holds at least `threshold` messages (the documented meaning), using an LLM summary; it no longer uses the session-record counter.
  - Removed the internal file src/media/index.ts (it was not reachable through package exports).

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/browser@0.2.0
  - @cogitator-ai/core@0.20.0
  - @cogitator-ai/mcp@18.0.0
  - @cogitator-ai/memory@0.7.0
  - @cogitator-ai/rag@0.2.0
  - @cogitator-ai/types@0.23.0

## 0.2.5

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.4
  - @cogitator-ai/memory@0.6.22
  - @cogitator-ai/rag@0.1.10
  - @cogitator-ai/browser@0.1.6
  - @cogitator-ai/mcp@17.0.11
  - @cogitator-ai/types@0.22.3
  - @cogitator-ai/config@0.5.6

## 0.2.4

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/browser@0.1.5
  - @cogitator-ai/config@0.5.5
  - @cogitator-ai/core@0.19.3
  - @cogitator-ai/mcp@17.0.10
  - @cogitator-ai/memory@0.6.21
  - @cogitator-ai/rag@0.1.9

## 0.2.3

### Patch Changes

- Publish audit hardening fixes for provider configuration, model registry data, core runtime behavior, shared runtime types, and channel delivery reliability.
- Updated dependencies
  - @cogitator-ai/config@0.5.4
  - @cogitator-ai/core@0.19.2
  - @cogitator-ai/models@17.1.8
  - @cogitator-ai/types@0.22.2
  - @cogitator-ai/browser@0.1.4
  - @cogitator-ai/mcp@17.0.9
  - @cogitator-ai/memory@0.6.20
  - @cogitator-ai/rag@0.1.8

## 0.2.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.1
  - @cogitator-ai/types@0.22.1
  - @cogitator-ai/browser@0.1.3
  - @cogitator-ai/config@0.5.3
  - @cogitator-ai/mcp@17.0.8
  - @cogitator-ai/memory@0.6.19
  - @cogitator-ai/rag@0.1.7
