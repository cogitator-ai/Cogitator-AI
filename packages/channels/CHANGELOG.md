# @cogitator-ai/channels

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
