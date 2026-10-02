# @cogitator-ai/channels

Connect Cogitator agents to messaging platforms. Gateway routes messages across channels, handles sessions, streaming, media, and middleware.

## Install

```bash
pnpm add @cogitator-ai/channels

# Then install the adapters you need:
pnpm add grammy                    # Telegram
pnpm add discord.js                # Discord
pnpm add @slack/bolt               # Slack
pnpm add @whiskeysockets/baileys   # WhatsApp (+ qrcode-terminal to print the pairing QR)
pnpm add ws                        # WebChat
pnpm add pg                        # Postgres memory for RuntimeBuilder (optional)
```

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
    secretToken: process.env.TG_WEBHOOK_SECRET, // verified on every update
  },
  allowedUpdates: ['message'],
});
```

Supports: text, photos (→ vision), voice and audio (→ STT), video, documents, replies, streaming via drafts/editText, emoji reactions, sending files from buffers or URLs, 4096 char limit.

### Discord

**Get your token:** [Discord Developer Portal](https://discord.com/developers/applications) → New Application → Bot → Reset Token → copy it. **Enable "Message Content Intent"** under Privileged Gateway Intents. Invite via OAuth2 URL Generator with `bot` scope + `Send Messages`, `Read Message History`, `Add Reactions` permissions.

```typescript
import { discordChannel } from '@cogitator-ai/channels';

discordChannel({
  token: process.env.DISCORD_TOKEN!,
  mentionOnly: true, // only respond when @mentioned in servers
});
```

Supports: DMs, server messages, attachments (images → vision, audio → STT), replies, streaming, reactions, auto-chunking (2000 chars / 17 lines, code-block aware). Long streamed answers span several Discord messages that are edited in place.

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
  appToken: process.env.SLACK_APP_TOKEN!,
});
```

Supports: DMs, channel messages (via @mention), threads (replies go to the thread root), file shares, Socket Mode (no public URL), streaming via chat.update, reactions.

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

Supports: 1-on-1 and group chats, images/voice/video/documents with captions, quoted replies, message edits (streaming), typing indicators, auto-reconnect with exponential backoff, WhatsApp-native markdown.

### WebChat

WebSocket server for custom UIs, CLI tools, or any client.

```typescript
import { webchatChannel } from '@cogitator-ai/channels';

webchatChannel({
  port: 3100,
  path: '/ws',
  auth: (token) => token === process.env.WEBCHAT_SECRET,
  maxPayload: 1024 * 1024, // bytes per incoming frame (default 1 MiB)
});
```

Connect: `ws://localhost:3100/ws?token=YOUR_SECRET` (unauthorized sockets are closed with code 1008). Send `{"text": "Hello!", "id": "optional-client-id"}`.

Server frames: `connected` (`clientId`), `message` (`id`, `text`, `replyTo`), `edit` (`id`, `text`), `delete` (`id`), `typing`, `file` (`url` or base64 `data`).

Supports: streaming (via edit frames), typing indicators, token auth, no message limit.

### Terminal

Local REPL channel used by `cogitator up`. Active only when stdin is a TTY (or `COGITATOR_FORCE_TERMINAL` is set).

```typescript
import { terminalChannel } from '@cogitator-ai/channels';

terminalChannel({ userName: 'Alice', prompt: '> ', onExit: () => shutdown() });
```

Ctrl+C, Ctrl+D, `/quit`, `/exit` and `exit` call `onExit` (default: raise `SIGINT` so the host app shuts down gracefully); `stop()` closes readline without exiting the process.

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

Outbound calls (`sendText`, `editText`, `sendFile`, `deleteMessage`) throw when the channel is not started, the target chat/client is unavailable or the platform rejects the request — wrap direct calls in `try/catch`. `sendText` returns the platform message id (for Discord, the id of the first chunk; continuation chunks are edited and deleted with it).

## Gateway

Routes incoming messages to your agent. Handles:

- Session management (per-user, per-channel) with an optional custom `sessionManager`
- History compaction with LLM-written summaries
- Streaming with `StreamBuffer` (message editing, splits at the platform limit without losing text)
- Typing keep-alive (re-sends typing indicator every 4s)
- Media processing (images → vision, voice → STT)
- Middleware pipeline
- Platform-specific markdown conversion
- Status reactions, debouncing, envelope formatting, queue modes
- Run timeouts (`runTimeout`, defaults to the agent's `timeout`)

```typescript
const gateway = new Gateway({
  cogitator,
  agent, // or (user) => Agent | Promise<Agent> for per-user agents
  channels,
  memory, // MemoryAdapter — enables sessions and history
  session: {
    threadKey: (msg) => `${msg.channelType}:${msg.userId}`,
    // compact once a conversation holds 50 messages, keep the last 10 verbatim
    compaction: { strategy: 'summary', threshold: 50, keepRecent: 10 },
  },
  runTimeout: 120_000,
});

gateway.stats; // { uptime, activeSessions, totalSessions, messagesToday, connectedChannels }
gateway.getSessions(); // [{ threadId, userName, messageCount, lastActiveAt, active }]
await gateway.compactThread('telegram:42'); // force compaction of one conversation
await gateway.injectMessage(msg); // feed a synthetic message (used by the scheduler)
```

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

const gateway = new Gateway({
  // ...
  middleware: [
    new DmPolicyMiddleware({
      mode: 'pairing',
      ownerIds: { telegram: '123' },
      storePath: '~/.cogitator/dm-allowlist.json',
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

### Command Authorization Levels

Commands have 3 access levels: `owner`, `authorized`, `public`. Built-in commands: `/status`, `/sessions`, `/help` (authorized) and `/users`, `/compact`, `/model <name> [@user]`, `/restart` (owner). Each command calls the matching `on*` handler you provide. `/cmd@botname` (Telegram groups) is recognized. Only owners can approve `/pair` codes.

### Rate Limit

`rateLimit({ maxPerMinute, message })` — sliding one-minute window per user; the limit notice is sent once per window.

## Lifecycle Hooks

Subscribe to events across the message lifecycle:

```typescript
import { createHookRegistry } from '@cogitator-ai/channels';

const hooks = createHookRegistry();
hooks.on('message:received', (e) => console.log('New message:', e));
hooks.on('agent:after_run', (e) => console.log('Response:', e));
hooks.on('agent:error', (e) => console.error('Agent failed:', e));

const gateway = new Gateway({ /* ... */ hooks });
```

Available hooks: `message:received`, `message:sending`, `message:sent`, `agent:before_run`, `agent:after_run`, `agent:error`, `session:created`, `session:compacted`, `stream:started`, `stream:finished`.

Errors in one handler don't affect others.

## Media & STT

Voice messages are transcribed automatically. STT provider is selected by available env vars (highest priority first):

1. **Deepgram** — set `DEEPGRAM_API_KEY` (nova-3 model, fast and accurate)
2. **Groq** — set `GROQ_API_KEY` (free tier available)
3. **OpenAI** — set `OPENAI_API_KEY` (`gpt-transcribe` model)
4. **Local Whisper** — downloads ~75MB model on first use, runs offline (no API key needed)

Images are passed to the LLM as vision input if the model supports it. Attachments that arrive only as URLs (Discord) are downloaded (default cap 25 MiB). Text-like files (`.md`, `.json`, `text/*`, …) are inlined into the prompt; other files and videos are announced to the model.

```typescript
import { MediaProcessor, LocalWhisper, GroqSttProvider } from '@cogitator-ai/channels';

const media = new MediaProcessor(new LocalWhisper(), () => true, new GroqSttProvider({ apiKey }), {
  maxInlineTextChars: 20_000,
  maxDownloadBytes: 25 * 1024 * 1024,
});
const gateway = new Gateway({ /* ... */ mediaProcessor: media });
```

Local Whisper decodes OGG/Opus and WAV (8/16/24/32-bit, any channel count); use a cloud provider for other formats.

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
});
scheduler.start();
```

Schedule types: `cron` (recurring, next fire computed with `cron-parser`, honors `timezone`), `recurring` (interval), `fixed` (one-shot). Consecutive failures are carried across reschedules; after `maxRetries` the job is skipped until `enableJob()`.

```typescript
await scheduler.listJobs();
await scheduler.enableJob(id);
await scheduler.disableJob(id);
await scheduler.cancelJob(id);
```

## RuntimeBuilder (YAML assistants)

`RuntimeBuilder` turns a validated `cogitator.yml` (`AssistantConfigSchema`) into a running assistant — this is what `cogitator up` uses.

```typescript
import { AssistantConfigSchema, RuntimeBuilder } from '@cogitator-ai/channels';

const config = AssistantConfigSchema.parse(yamlObject);
const runtime = await new RuntimeBuilder(config, process.env, {
  onRestart: () => process.exit(78), // default behaviour
}).build();
await runtime.gateway.start(); // the scheduler (if enabled) is already running
// ...
await runtime.cleanup();
```

- **Memory:** `memory.adapter: sqlite` (default, `memory.path`) or `postgres` (`memory.connectionString` or `DATABASE_URL`; requires `pg`). Knowledge graph + core facts + auto-extraction included.
- **Fresh context:** the gateway builds an agent per message — instructions (current date/time and known user facts) and the `/model` override are resolved each time. `runtime.agent` is the base agent.
- **Owner commands wired:** `/status`, `/sessions`, `/users`, `/compact`, `/model` (global or per user), `/restart`.
- **Security:** `fileSystem.paths` is enforced — file tools refuse paths outside the allowed roots (symlinks resolved). Self-config tools (`config_*`, `env_*`) only work for channel owners and the local terminal.

## Environment Variables

```bash
# LLM Provider
GOOGLE_API_KEY=...           # or ANTHROPIC_API_KEY, OPENAI_API_KEY

# Telegram
TG_TOKEN=7204891735:AAHr...

# Discord
DISCORD_TOKEN=MTI...

# Slack (3 tokens)
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...

# WhatsApp — no token, uses QR pairing

# Postgres memory (memory.adapter: postgres)
DATABASE_URL=postgres://user:pass@localhost:5432/cogitator

# WebChat
WEBCHAT_SECRET=your-secret

# STT (optional, for voice messages — pick one)
DEEPGRAM_API_KEY=...         # highest priority
GROQ_API_KEY=...             # free tier
OPENAI_API_KEY=...           # fallback
```
