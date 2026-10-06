# @cogitator-ai/channels

Connect Cogitator agents to messaging platforms. Gateway routes messages across channels, handles sessions, streaming, media, and middleware.

Full documentation: [cogitator.app/docs/channels/gateway](https://cogitator.app/docs/channels/gateway).

## Install

```bash
pnpm add @cogitator-ai/channels

# Then install the adapters you need:
pnpm add grammy                    # Telegram
pnpm add discord.js                # Discord
pnpm add @slack/bolt               # Slack
pnpm add @whiskeysockets/baileys   # WhatsApp, 6.x or 7.x (+ qrcode-terminal to print the pairing QR)
pnpm add ws                        # WebChat

# RuntimeBuilder (`cogitator up`)
pnpm add better-sqlite3            # SQLite memory, knowledge graph and core facts (always needed)
pnpm add pg                        # memory.adapter: postgres
```

All adapters are optional peer dependencies, loaded only when the channel starts; a missing one fails `start()` with an install hint. RuntimeBuilder capabilities load `@cogitator-ai/browser`, `@cogitator-ai/rag`, `@cogitator-ai/mcp` and `@cogitator-ai/models` (vision detection) on demand. `LocalWhisper` needs `@huggingface/transformers` and `ogg-opus-decoder`, and installs them with `npm install --no-save` when missing.

## Quick Start

```typescript
import { Cogitator, Agent } from '@cogitator-ai/core';
import { Gateway, telegramChannel } from '@cogitator-ai/channels';

const cogitator = new Cogitator({
  llm: { providers: { google: { apiKey: process.env.GOOGLE_API_KEY! } } },
});
const agent = new Agent({
  name: 'bot',
  model: 'google/gemini-3.8-flash',
  instructions: 'You are a helpful assistant.',
});

const gateway = new Gateway({
  cogitator,
  agent,
  channels: [telegramChannel({ token: process.env.TG_TOKEN! })],
  stream: { flushInterval: 500, minChunkSize: 20 },
});

await gateway.start();
```

## Channels

### Telegram

**Get your token:** Open Telegram → search `@BotFather` → send `/newbot` → follow prompts → copy the token.

```typescript
import { telegramChannel } from '@cogitator-ai/channels';

telegramChannel({ token: process.env.TG_TOKEN! });

// Webhook mode (production): starts an HTTP server on `port` and registers `url` with Telegram
telegramChannel({
  token: process.env.TG_TOKEN!,
  webhook: {
    url: 'https://example.com/telegram',
    port: 8443,
    path: '/telegram', // optional, defaults to the pathname of `url`
    secretToken: process.env.TG_WEBHOOK_SECRET, // verified on every update
  },
  allowedUpdates: ['message'],
});
```

Built on the current Bot API, through grammY's raw API so newer methods work on any grammY:

- **Rich Markdown** (default on, `richMessages: false` to turn off): the agent's Markdown goes out as written, with headings, tables, code blocks, task lists, footnotes and formulas, up to 32,768 characters. A refused rich message falls back to classic Markdown, then plain text.
- **Streaming** through rich drafts with a **stop button**: a press stops the run and keeps what was written as the reply. Groups stream by editing.
- **Buttons** with colors, URLs, copy-text and disabled buttons (`SendOptions.buttons`); presses reach the `action:received` hook or `onAction`. Tool approval prompts get Approve and Deny buttons.
- **Topics** (forum topics and private chat topics), `@username` chat ids, captions, GIFs and voice notes, **albums** (`sendFiles`), silent, protected, ephemeral and effect messages, link preview options.
- **Command menus** by scope and language (`setCommands`, `setCommandMenu`), bot name and descriptions (`setProfile`), and `call(method, args)` for any other Bot API method.
- Incoming text, photos (→ vision), voice and audio (→ STT), video, video notes, GIFs, documents, replies and topics.

```typescript
const telegram = telegramChannel({ token: process.env.TG_TOKEN! });

await telegram.sendText(chatId, 'Publish the noon edition?', {
  buttons: [
    [
      { text: 'Publish', data: 'publish', style: 'success' },
      { text: 'Hold', data: 'hold', style: 'danger' },
    ],
  ],
});
await telegram.setCommands([{ command: 'status', description: 'What is going on' }], { chatId });
```

Docs: [Telegram](https://cogitator.app/docs/channels/telegram).

### Discord

**Get your token:** [Discord Developer Portal](https://discord.com/developers/applications) → New Application → Bot → Reset Token → copy it. **Enable "Message Content Intent"** under Privileged Gateway Intents. Invite via OAuth2 URL Generator with `bot` scope + `Send Messages`, `Read Message History`, `Add Reactions` permissions.

```typescript
import { discordChannel } from '@cogitator-ai/channels';

discordChannel({
  token: process.env.DISCORD_TOKEN!,
  mentionOnly: true, // only respond when @mentioned in servers
});
```

Supports: DMs, server messages, attachments (images → vision, audio → STT), replies, streaming, reactions, auto-chunking (2000 chars / 17 lines, code-block aware). Long streamed answers span several Discord messages that are edited in place. Docs: [Discord](https://cogitator.app/docs/channels/discord).

### Slack

**Get your tokens (3 total):**

1. [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch
2. Socket Mode → enable → generate App Token (`xapp-...`) → save as `SLACK_APP_TOKEN`
3. OAuth & Permissions → add scopes: `chat:write`, `app_mentions:read`, `im:history`, `im:read`, `im:write`, `users:read` (display names), `files:read` (attachments), `files:write` (sendFile), `reactions:write` (status reactions)
4. Event Subscriptions → enable → add: `message.im`, `app_mention`
5. Install App → copy Bot Token (`xoxb-...`) → save as `SLACK_BOT_TOKEN`
6. Basic Information → copy Signing Secret → save as `SLACK_SIGNING_SECRET`

```typescript
import { slackChannel } from '@cogitator-ai/channels';

slackChannel({
  token: process.env.SLACK_BOT_TOKEN!,
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  appToken: process.env.SLACK_APP_TOKEN!, // Socket Mode; omit to serve HTTP events on `port` (default 3000)
});
```

Supports: DMs, channel messages (via @mention, the mention is stripped from the text), threads (replies go to the thread root), file shares, Socket Mode (no public URL), streaming via chat.update, reactions. Set `mentionOnly: true` to ignore channel messages that do not mention the bot when the app also subscribes to `message.channels`. In `RuntimeBuilder`, Socket Mode is on when `SLACK_APP_TOKEN` is set; otherwise Slack runs in HTTP mode on `SLACK_PORT` (default 3000). Docs: [Slack](https://cogitator.app/docs/channels/slack).

### WhatsApp

No bot API — connects as a linked device to your WhatsApp account (like WhatsApp Web).

```typescript
import { whatsappChannel } from '@cogitator-ai/channels';

whatsappChannel({
  sessionPath: '.cogitator/whatsapp-session',
  printQr: true, // needs `qrcode-terminal`; or pass qrCallback: (qr) => render(qr)
});
```

**First run:** the QR code is printed to the terminal (or handed to `qrCallback`) → scan from WhatsApp → Settings → Linked Devices. Session is saved for future restarts.

Supports: 1-on-1 and group chats, images/voice/video/documents with captions, quoted replies, message edits (streaming), typing indicators, auto-reconnect with exponential backoff (stops when WhatsApp logs the device out), WhatsApp-native markdown.

Works with Baileys 6.x and 7.x. `userId` is the sender's phone number (the part before `@`). When WhatsApp addresses a person by LID (Baileys 7), the phone number is taken from `remoteJidAlt` / `participantAlt` whenever WhatsApp shares it, so owner lists and per-user memory keep matching. With `cogitator up`, enable it with `channels.whatsapp` in `cogitator.yml` (see [RuntimeBuilder](#runtimebuilder-yaml-assistants)). Docs: [WhatsApp](https://cogitator.app/docs/channels/whatsapp).

### WebChat

WebSocket server for custom UIs, CLI tools, or any client.

```typescript
import { webchatChannel } from '@cogitator-ai/channels';

webchatChannel({
  port: 3100,
  path: '/ws',
  auth: (token) => token === process.env.WEBCHAT_TOKEN,
  maxPayload: 1024 * 1024, // bytes per incoming frame (default 1 MiB)
});
```

Connect: `ws://localhost:3100/ws?token=YOUR_SECRET` (unauthorized sockets get an `{"type":"error","message":"unauthorized"}` frame and are closed with code 1008). Send `{"text": "Hello!", "id": "optional-client-id"}`. Each connection is its own user and chat (`clientId`).

Server frames: `connected` (`clientId`), `message` (`id`, `text`, `replyTo`), `edit` (`id`, `text`), `delete` (`id`), `typing`, `file` (`filename`, `mimeType`, and `url` or base64 `data`).

Supports: streaming (via edit frames), typing indicators, token auth, no message limit. Text only on the way in (no attachments). With `cogitator up`, enable it with `channels.webchat` in `cogitator.yml` plus `WEBCHAT_TOKEN` (see [RuntimeBuilder](#runtimebuilder-yaml-assistants)). Docs: [WebChat](https://cogitator.app/docs/channels/webchat).

### Terminal

Local REPL channel used by `cogitator up`. Active only when stdin is a TTY (or `COGITATOR_FORCE_TERMINAL` is set).

```typescript
import { terminalChannel } from '@cogitator-ai/channels';

terminalChannel({ userName: 'Alice', prompt: '> ', onExit: () => shutdown() });
```

Ctrl+C, Ctrl+D, `/quit`, `/exit` and `exit` call `onExit` (default: raise `SIGINT` so the host app shuts down gracefully); `stop()` closes readline without exiting the process. Docs: [Terminal](https://cogitator.app/docs/channels/terminal).

## Platform Comparison

| Feature            | Telegram     | Discord | Slack     | WhatsApp | WebChat   |
| ------------------ | ------------ | ------- | --------- | -------- | --------- |
| Streaming (edit)   | ✅           | ✅      | ✅        | ✅       | ✅        |
| Reactions          | ✅           | ✅      | ✅        | ❌       | ❌        |
| Typing indicator   | ✅           | ✅      | ❌        | ✅       | ✅        |
| Photos → vision    | ✅           | ✅      | ✅        | ✅       | ❌        |
| Voice → STT        | ✅           | ✅      | ✅        | ✅       | ❌        |
| Max message length | 4096         | 2000    | 40000     | 65536    | unlimited |
| Public URL needed  | webhook only | no      | HTTP only | no       | no        |

Outbound calls (`sendText`, `editText`, `sendFile`, `deleteMessage`) throw when the channel is not started, the target chat is unavailable or the platform rejects the request — wrap direct calls in `try/catch`. WebChat is the exception: only `sendText` throws for a disconnected client, the other calls are dropped. `sendText` returns the platform message id (for Discord, the id of the first chunk; continuation chunks are edited and deleted with it).

## Gateway

Routes incoming messages to your agent. Handles:

- Session management (per-user, per-channel) with an optional custom `sessionManager`
- History compaction with LLM-written summaries
- Streaming with `StreamBuffer` when `stream` is set (message editing, splits at the platform limit without losing text); without `stream` the full answer is sent once the run finishes
- Typing keep-alive (re-sends typing indicator every 4s)
- Media processing (images → vision, voice → STT)
- Middleware pipeline
- Platform-specific markdown conversion
- Status reactions, debouncing, envelope formatting, queue modes
- Run timeouts (`runTimeout`, defaults to the agent's `timeout`)
- Tool approvals over chat (see [Approvals](#approvals))

```typescript
const gateway = new Gateway({
  cogitator,
  agent, // or (user) => Agent | Promise<Agent> for per-user agents
  channels,
  memory, // MemoryAdapter — enables sessions and history
  session: {
    threadKey: (msg) => `${msg.channelType}:${msg.userId}`,
    // compact once a conversation holds 50 messages (or `threshold` tokens), keep the last 10 verbatim
    compaction: { strategy: 'summary', messageThreshold: 50, keepRecent: 10 },
  },
  runTimeout: 120_000,
});

gateway.stats; // { uptime, activeSessions, totalSessions, messagesToday, connectedChannels }
gateway.getSessions(); // [{ threadId, userName, messageCount, lastActiveAt, active }]
await gateway.compactThread('telegram:42'); // force compaction of one conversation
await gateway.injectMessage(msg); // feed a synthetic message (used by the scheduler)
await gateway.stop();
```

`GatewayConfig.owner` is deprecated and never read: set owners on `ownerCommands({ ownerIds })` and `dmPolicy({ ownerIds })` (see [Middleware](#middleware)).

`stream` takes `flushInterval` and `minChunkSize` (ms / chars between edits), plus optional `minInitialChars` (wait for this much text before the first message), `maxMessageChars` (defaults to the platform limit) and `deleteOnAbort` (remove the partial answer when the run is interrupted). Telegram streams through message drafts when available and falls back to edits.

Docs: [Gateway](https://cogitator.app/docs/channels/gateway), [Streaming](https://cogitator.app/docs/channels/streaming).

## Approvals

Tools marked `requiresApproval` (for example `create_tool` from `capabilities.selfTools`) pause the run before they execute — unless the Cogitator has `guardrails.onToolApproval`, which then decides instead. The Gateway turns that pause into a chat conversation:

1. The paused run's text (if any) is sent, followed by a prompt listing each waiting call — tool name, description and compact JSON arguments (cut at 300 characters).
2. The user replies `approve` / `yes` to run the calls, or `deny` / `no` to refuse, optionally followed by a reason (`no, too risky`) that the agent sees. Replies are case-insensitive and may end with punctuation; `да` / `одобряю` and `нет` / `отклоняю` work out of the box.
3. The Gateway calls `cogitator.resume(agent, threadId, { userId, defaultDecision })` and delivers the result like any reply, streaming included. If the run pauses again, a new prompt is sent.

On channels with buttons (Telegram), the prompt also carries **Approve** and **Deny** buttons. A press answers exactly like the reply words, through the same middleware and checks, and the buttons then show the decision. `approvals.buttons: false` turns them off and `approvals.buttonLabels` renames them. A press counts only from the user the prompt asked, while their run is still paused; any other press gets an alert (`notAllowedMessage`, or `expiredMessage` once the request was answered, dropped or predates a restart, when a reply word still works).

Any other message on a paused thread runs as usual, and the runtime answers the waiting calls as declined. An approve-only word with more text after it (`yes, but rename it`) counts as a new message, so nothing runs by accident.

Only the user who started the run can answer it: the runtime checks the run's `userId` on resume. In a shared thread (a `threadKey` per group chat), someone else replying `approve` gets `notAllowedMessage` and the pause stays put.

Pauses survive restarts when the runtime persists them (in the thread's memory once the Cogitator has a memory adapter, or in `runCheckpoints`): the first approve/deny reply on a thread the Gateway has not seen since it started tries `resume`, and runs as a normal message if nothing is paused. On threads it has already seen, the Gateway resumes only pauses it sent a prompt for, so one Gateway process should serve a given thread.

```typescript
const gateway = new Gateway({
  // ...
  approvals: {
    approveWords: ['approve', 'yes', 'да'],
    denyWords: ['deny', 'no', 'нет'],
    format: (approvals, { approveWords, denyWords }) =>
      `Разрешить ${approvals.map((a) => a.toolName).join(', ')}? ` +
      `Ответьте «${approveWords[0]}» или «${denyWords[0]}».`,
    notAllowedMessage: 'Подтвердить может только автор запроса.',
  },
});

hooks.on('approval:requested', ({ threadId, approvals }) => {
  audit.log(threadId, approvals);
});
hooks.on('approval:resolved', ({ threadId, decision, superseded }) => {
  audit.log(threadId, decision, superseded);
});
```

`ApprovalRequestedEvent` and `ApprovalResolvedEvent` are exported types; `superseded` is `true` when the user sent a new message instead of answering. With `RuntimeBuilder` / `cogitator up`, the words and `notAllowedMessage` can be set in the `approvals` block of `cogitator.yml` (see [RuntimeBuilder](#runtimebuilder-yaml-assistants)). `DEFAULT_APPROVE_WORDS`, `DEFAULT_DENY_WORDS` and `DEFAULT_NOT_ALLOWED_MESSAGE` hold the defaults.

`parseApprovalReply(text, words)` and `formatApprovalPrompt(approvals, words)` are exported for custom channels and UIs.

## Status Reactions

Emoji progress indicators on the user's message:

```typescript
const gateway = new Gateway({
  // ...
  reactions: {
    enabled: true,
    emojis: { queued: '👀', thinking: '🤔', tool: '🔥', done: '👍', error: '😱' },
    debounceMs: 700,
    stallSoftMs: 10000,
    stallHardMs: 30000,
  },
});
```

## Inbound Debouncing

Merge rapid messages into a single LLM call:

```typescript
const gateway = new Gateway({
  // ...
  debounce: {
    enabled: true,
    delayMs: 1500,
    byChannel: { discord: 2000 },
  },
});
```

## Envelope Formatting

Wrap messages with context so the LLM knows who's talking, on which platform, and when:

`[Oct 2, 14:23 | telegram | alice | DM | +2m30s] Hello world`

```typescript
const gateway = new Gateway({
  // ...
  envelope: {
    enabled: true,
    includeTimestamp: true,
    includeElapsed: true,
    includeSender: true,
    includeChannel: true,
    includeChatType: true,
    timezone: 'Europe/Moscow',
  },
});
```

## Queue Modes

Control concurrent message handling per user:

```typescript
const gateway = new Gateway({
  // ...
  queueMode: 'sequential', // 'parallel' | 'sequential' | 'interrupt' | 'collect'
});
```

- **parallel** — default, all messages processed immediately
- **sequential** — FIFO per thread, wait for current to finish
- **interrupt** — abort the current run (its signal is passed to `cogitator.run`), start the new message
- **collect** — buffer during processing, merge on idle

## Formatting Pipeline

Platform-specific markdown conversion applied automatically (code spans and fences are never touched):

- **Telegram** — `**bold**` → `*bold*`, `# headers` → bold, `* item` → `• item`
- **Discord** — native Markdown, auto-chunks at 2000 chars with code block integrity
- **Slack** — mrkdwn: `**bold**` → `*bold*`, `[text](url)` → `<url|text>`, `~~x~~` → `~x~`, `&<>` escaped
- **WhatsApp** — `**bold**` → `*bold*`, `~~strike~~` → `~strike~`, headers → bold, links → `text (url)`

`chunkMessage(text, limit)` splits long answers at paragraph → line → word boundaries and closes/reopens code fences across chunks.

## Middleware

```typescript
import { rateLimit, ownerCommands, DmPolicyMiddleware, autoExtract } from '@cogitator-ai/channels';

// `gateway` is referenced lazily by the command handlers

const gateway: Gateway = new Gateway({
  // ...
  middleware: [
    new DmPolicyMiddleware({
      mode: 'pairing',
      ownerIds: { telegram: '123' },
      groupPolicy: 'open',
    }),
    ownerCommands({
      ownerIds: { telegram: '123' },
      authorizedUserIds: ['telegram:456'],
      publicCommands: ['help'],
      onStatus: () => JSON.stringify(gateway.stats),
      onCompact: (target, threadId) =>
        gateway.compactThread(target === 'current' ? threadId : target),
    }),
    rateLimit({ maxPerMinute: 30 }),
    autoExtract({ extractor, graphAdapter, agentId: 'jarvis' }),
  ],
});
```

### DM Policy Modes

- **open** — anyone can DM the bot
- **allowlist** — only pre-approved users
- **pairing** — unknown users get a code, owner approves via `/pair CODE`
- **disabled** — DMs blocked entirely

`groupPolicy` (`open` | `allowlist` | `disabled`, with `groupAllowlist`) does the same for group chats. Approved users are persisted to `storePath` (default `~/.cogitator/dm-allowlist.json`; a leading `~` expands to the home directory). `dmPolicy(config)` is the factory form. Docs: [Middleware](https://cogitator.app/docs/channels/middleware).

### Command Authorization Levels

Commands have 3 access levels: `owner`, `authorized`, `public`. Built-in commands: `/status`, `/sessions`, `/help` (authorized) and `/users`, `/compact`, `/model <name> [@user]`, `/restart` (owner). Each command calls the matching `on*` handler you provide. `/cmd@botname` (Telegram groups) is recognized. Only owners can approve `/pair` codes. Docs: [Owner Commands](https://cogitator.app/docs/channels/owner-commands).

### Rate Limit

`rateLimit({ maxPerMinute, message })` — sliding one-minute window per user; the limit notice is sent once per window.

## Lifecycle Hooks

Subscribe to events across the message lifecycle:

```typescript
import { createHookRegistry } from '@cogitator-ai/channels';

const hooks = createHookRegistry();
hooks.on('message:received', (e) => console.log('New message:', e.msg.text));
hooks.on('agent:after_run', (e) => console.log('Response:', e.output));
hooks.on('agent:error', (e) => console.error('Agent failed:', e.error.message));

const gateway = new Gateway({ /* ... */ hooks });
```

Handlers are typed by hook name through `HookPayloads` (exported here and from `@cogitator-ai/types`, which also exports each event type):

| Hook                 | Payload                  | Fields                                                                          |
| -------------------- | ------------------------ | ------------------------------------------------------------------------------- |
| `message:received`   | `MessageReceivedEvent`   | `msg`, `threadId`, `user`                                                       |
| `message:sending`    | `MessageSendingEvent`    | `msg`, `threadId`, `text`, `channelId`                                          |
| `message:sent`       | `MessageSentEvent`       | `msg`, `threadId`, `text`, `messageId` (first chunk)                            |
| `agent:before_run`   | `AgentBeforeRunEvent`    | `msg`, `threadId`, `agent` (agent name)                                         |
| `agent:after_run`    | `AgentAfterRunEvent`     | `msg`, `threadId`, `output`                                                     |
| `agent:error`        | `AgentErrorEvent`        | `msg`, `threadId`, `error` (always an `Error`)                                  |
| `session:created`    | `SessionCreatedEvent`    | `session`, `threadId`                                                           |
| `session:compacted`  | `SessionCompactedEvent`  | `threadId`, `result` (`CompactionResult`)                                       |
| `stream:started`     | `StreamStartedEvent`     | `msg`, `threadId`                                                               |
| `stream:finished`    | `StreamFinishedEvent`    | `msg`, `threadId`, `messageIds`                                                 |
| `approval:requested` | `ApprovalRequestedEvent` | `msg`, `threadId`, `userId`, `approvals`                                        |
| `approval:resolved`  | `ApprovalResolvedEvent`  | `msg`, `threadId`, `userId`, `decision`, `approvals?`, `superseded`             |
| `action:received`    | `ActionReceivedEvent`    | `action`, `answer(options?)`: a button press the Gateway does not handle itself |

A handler typed `HookHandler` (`unknown` payload) is still accepted for any hook. Errors in one handler don't affect others (they are logged). Unsubscribe with `hooks.off(name, handler)`. Docs: [Lifecycle Hooks](https://cogitator.app/docs/channels/gateway#lifecycle-hooks).

## Media & STT

Attachments are processed when the Gateway has a `mediaProcessor`; without one only the message text reaches the agent. `RuntimeBuilder` always wires one and picks the STT provider from env vars (highest priority first):

1. **Deepgram** — `DEEPGRAM_API_KEY` → `DeepgramSttProvider` (`nova-3`)
2. **Groq** — `GROQ_API_KEY` → `GroqSttProvider` (`whisper-large-v3`)
3. **OpenAI** — `OPENAI_API_KEY` → `OpenAISttProvider` (`gpt-transcribe`)
4. **Local Whisper** — no key: `LocalWhisper` (`Xenova/whisper-tiny`, ~75MB, offline). It transcribes only once the model is downloaded; until then the agent gets a `download_stt_model` tool (`createWhisperDownloadTool`) and asks the user before downloading.

Images are passed to the LLM as vision input if the model supports it. Attachments that arrive only as URLs (Discord) are downloaded (default cap 25 MiB). Text-like files (`.md`, `.json`, `text/*`, …) are inlined into the prompt; other files and videos are announced to the model.

```typescript
import { MediaProcessor, LocalWhisper, GroqSttProvider } from '@cogitator-ai/channels';

const media = new MediaProcessor(new LocalWhisper(), () => true, new GroqSttProvider({ apiKey }), {
  maxInlineTextChars: 20_000,
  maxDownloadBytes: 25 * 1024 * 1024,
});
const gateway = new Gateway({ /* ... */ mediaProcessor: media });
```

Local Whisper decodes OGG/Opus and WAV (8/16/24/32-bit, any channel count); use a cloud provider for other formats. Custom providers implement `SttProvider` (`transcribe(buffer, mimeType)`).

## Scheduler

```typescript
import { HeartbeatScheduler, SimpleTimerStore, getNextCronMs } from '@cogitator-ai/channels';

const store = new SimpleTimerStore({
  persistPath: '.cogitator/timers.json',
  resolveCronFiresAt: (cron, tz) => getNextCronMs(cron, Date.now(), tz), // validates and schedules cron entries
});
const scheduler = new HeartbeatScheduler(store, {
  onFire: (msg) => gateway.injectMessage(msg),
  pollInterval: 30_000,
  maxRetries: 5,
  retentionMs: 7 * 24 * 60 * 60 * 1000, // prune fired entries after a week
  onRunComplete: (entry, status, error, durationMs) => {
    console.log(`Job ${entry.id}: ${status} (${durationMs}ms)`);
  },
  onError: (err, entry) => console.error('scheduler', entry?.id, err.message),
  onClaimLost: (entry) => console.warn('scheduler: claim lost', entry.id),
});
scheduler.start();
```

Schedule types: `cron` (recurring, next fire computed with `cron-parser`, honors `timezone`), `recurring` (interval), `fixed` (one-shot). Consecutive failures are carried across reschedules; after `maxRetries` the job is skipped until `enableJob()`. A fired job reaches `onFire` as a message on the `channel` / `channelId` / `userId` stored in its `metadata`, and `staggerMs` adds a random delay before the first poll. Docs: [Scheduler](https://cogitator.app/docs/channels/scheduler).

With a store that claims timers (`claimTtl` / `renew` / `release`, e.g. the Redis/Postgres timer stores of `@cogitator-ai/workflows`), the claim is renewed right before a task fires and every `claimTtl / 3` while it runs; `onClaimLost(entry)` reports a claim that is gone (the task is skipped before firing, or another worker may fire it too). Claims are released for disabled tasks, tasks over `maxRetries` and overdue tasks not reached before `stop()`.

```typescript
await scheduler.listJobs();
await scheduler.enableJob(id);
await scheduler.disableJob(id);
await scheduler.cancelJob(id);
```

## RuntimeBuilder (YAML assistants)

`RuntimeBuilder` turns an assistant config (the shape of `cogitator.yml`) into a running assistant — this is what `cogitator up` uses. It takes the config as written (`AssistantConfigInput`) and applies `AssistantConfigSchema` itself, so a config built in code only sets what it needs (defaults fill `memory.autoExtract`, `memory.knowledgeGraph`, the security policies, …); an invalid config throws when the builder is created.

```typescript
import { RuntimeBuilder } from '@cogitator-ai/channels';

const runtime = await new RuntimeBuilder(
  {
    name: 'Jarvis',
    personality: 'You are a personal assistant for Alice.',
    llm: { provider: 'google', model: 'gemini-3.8-flash' },
    channels: { telegram: { ownerIds: ['123'] } },
    capabilities: { scheduler: true },
  },
  process.env,
  {
    onRestart: () => process.exit(78), // default behaviour (RESTART_EXIT_CODE)
    hooks, // HookRegistry passed to the gateway
    approvals: { format: (approvals) => `Run ${approvals.map((a) => a.toolName).join(', ')}?` },
  }
).build();
await runtime.gateway.start(); // the scheduler (if enabled) is already running
// ...
await runtime.cleanup();
```

`hooks` and `approvals` are passed to the gateway; `approvals` is merged over the config's `approvals` block (`approveWords`, `denyWords`, `notAllowedMessage`) and wins, so use it for what YAML cannot hold, such as a custom `format`.

For a parsed YAML file, validate it first with `new RuntimeBuilder(AssistantConfigSchema.parse(yamlObject), process.env)` (the schema is exported, along with the `AssistantConfigInput` / `AssistantConfigOutput` types).

- **Channels:** the terminal REPL plus `channels.telegram` (`TG_TOKEN` or `TELEGRAM_TOKEN`), `channels.discord` (`DISCORD_TOKEN`) and `channels.slack` (`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, optional `SLACK_APP_TOKEN` / `SLACK_PORT`). A configured channel without its token is skipped with a warning. `channels.whatsapp` (`{ ownerIds?, sessionPath? }`; owner ids are phone numbers without `@s.whatsapp.net`, the session defaults to `~/.cogitator/whatsapp-session`) needs `@whiskeysockets/baileys`. `channels.webchat` (`{ port?, path? }`, default `8080` and `/ws`, no `ownerIds`) needs `ws` and starts only with `WEBCHAT_TOKEN` set; clients connect with `?token=<WEBCHAT_TOKEN>`.

- **Memory:** `memory.adapter: sqlite` (default, `memory.path`, default `~/.cogitator/memory.db`) or `postgres` (`memory.connectionString`, `DATABASE_URL` or `POSTGRES_URL`; requires `pg`). Core facts always live in the SQLite file. The knowledge graph (`memory.knowledgeGraph`) and auto-extraction (`memory.autoExtract`) are on by default; `memory.compaction.threshold` enables history compaction.
- **Fresh context:** the gateway builds an agent per message — instructions (current date/time and known user facts) and the `/model` override are resolved each time. `runtime.agent` is the base agent.
- **Owner commands wired:** `/status`, `/sessions`, `/users`, `/compact`, `/model` (global or per user), `/restart`.
- **Security:** `fileSystem.paths` is enforced — file tools refuse paths outside the allowed roots (symlinks resolved). Self-config tools (`config_*`, `env_*`) only work for channel owners and the local terminal. `security` sets the DM/group policy, allowlists and command access.

Docs: [Wizard Setup](https://cogitator.app/docs/channels/wizard), [Smart Memory](https://cogitator.app/docs/channels/smart-memory).

## Environment Variables

```bash
# LLM Provider
GOOGLE_API_KEY=...           # or ANTHROPIC_API_KEY, OPENAI_API_KEY

# Telegram
TG_TOKEN=7204891735:AAHr...   # or TELEGRAM_TOKEN

# Discord
DISCORD_TOKEN=MTI...

# Slack (3 tokens)
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...     # omit for HTTP mode
SLACK_PORT=3000              # HTTP mode port

# WhatsApp — no token, uses QR pairing

# Postgres memory (memory.adapter: postgres)
DATABASE_URL=postgres://user:pass@localhost:5432/cogitator   # or POSTGRES_URL

# WebChat
WEBCHAT_TOKEN=your-secret        # required by channels.webchat in cogitator.yml

# STT (optional, for voice messages — pick one)
DEEPGRAM_API_KEY=...         # highest priority
GROQ_API_KEY=...             # free tier
OPENAI_API_KEY=...           # fallback
```
