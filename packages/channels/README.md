# @cogitator-ai/channels

Connect Cogitator agents to messaging platforms. Gateway routes messages across channels, handles sessions, streaming, media, and middleware.

## Install

```bash
pnpm add @cogitator-ai/channels

# Then install the adapters you need:
pnpm add grammy                    # Telegram
pnpm add discord.js                # Discord
pnpm add @slack/bolt               # Slack
pnpm add @whiskeysockets/baileys   # WhatsApp
pnpm add ws                        # WebChat
```

## Quick Start

```typescript
import { Cogitator, Agent } from '@cogitator-ai/core';
import { Gateway, telegramChannel } from '@cogitator-ai/channels';

const cogitator = new Cogitator({ llm: { defaultModel: 'google/gemini-2.5-flash' } });
const agent = new Agent({ name: 'bot', instructions: 'You are a helpful assistant.' });

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

// Webhook mode (production):
telegramChannel({
  token: process.env.TG_TOKEN!,
  webhook: { url: 'https://example.com/telegram', port: 8443 },
});
```

Supports: text, photos (→ vision), voice (→ STT), documents, streaming via editText, emoji reactions, 4096 char limit.

### Discord

**Get your token:** [Discord Developer Portal](https://discord.com/developers/applications) → New Application → Bot → Reset Token → copy it. **Enable "Message Content Intent"** under Privileged Gateway Intents. Invite via OAuth2 URL Generator with `bot` scope + `Send Messages`, `Read Message History`, `Add Reactions` permissions.

```typescript
import { discordChannel } from '@cogitator-ai/channels';

discordChannel({
  token: process.env.DISCORD_TOKEN!,
  mentionOnly: true, // only respond when @mentioned in servers
});
```

Supports: DMs, server messages, streaming, reactions, auto-chunking (2000 char limit, code-block aware).

### Slack

**Get your tokens (3 total):**

1. [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From scratch
2. Socket Mode → enable → generate App Token (`xapp-...`) → save as `SLACK_APP_TOKEN`
3. OAuth & Permissions → add scopes: `chat:write`, `app_mentions:read`, `im:history`, `im:read`, `im:write`
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

Supports: DMs, channel messages (via @mention), Socket Mode (no public URL), streaming via chat.update.

### WhatsApp

No bot API — connects as a linked device to your WhatsApp account (like WhatsApp Web).

```typescript
import { whatsappChannel } from '@cogitator-ai/channels';

whatsappChannel({
  sessionPath: '.cogitator/whatsapp-session',
  printQr: true,
});
```

**First run:** QR code prints to terminal → scan from WhatsApp → Settings → Linked Devices. Session is saved for future restarts.

Supports: 1-on-1 and group chats, typing indicators, auto-reconnect, WhatsApp-native markdown. No streaming (WhatsApp doesn't support editing).

### WebChat

WebSocket server for custom UIs, CLI tools, or any client.

```typescript
import { webchatChannel } from '@cogitator-ai/channels';

webchatChannel({
  port: 3100,
  path: '/ws',
  auth: (token) => token === process.env.WEBCHAT_SECRET,
});
```

Connect: `ws://localhost:3100/ws?token=YOUR_SECRET`. Send `{"text": "Hello!"}`, receive `{"type": "message", "id": "...", "text": "..."}`.

Supports: streaming (via edit messages), typing indicators, token auth, no message limit.

## Platform Comparison

| Feature            | Telegram     | Discord | Slack     | WhatsApp | WebChat   |
| ------------------ | ------------ | ------- | --------- | -------- | --------- |
| Streaming (edit)   | ✅           | ✅      | ✅        | ❌       | ✅        |
| Reactions          | ✅           | ✅      | ❌        | ❌       | ❌        |
| Typing indicator   | ✅           | ✅      | ⚠️        | ✅       | ✅        |
| Photos → vision    | ✅           | ❌      | ❌        | ❌       | ❌        |
| Voice → STT        | ✅           | ❌      | ❌        | ❌       | ❌        |
| Max message length | 4096         | 2000    | ~4000     | ~65536   | unlimited |
| Public URL needed  | webhook only | no      | HTTP only | no       | no        |

## Gateway

Routes incoming messages to your agent. Handles:

- Session management (per-user, per-channel)
- Streaming with `StreamBuffer` (chunked message editing)
- Typing keep-alive (re-sends typing indicator every 4s)
- Media processing (images → vision, voice → STT)
- Middleware pipeline
- Platform-specific markdown conversion
- Status reactions, debouncing, envelope formatting, queue modes

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

Wrap messages with context: `[telegram Alice +2m30s Feb 28 20:15] Hello world`

```typescript
const gateway = new Gateway({
  // ...
  envelope: { enabled: true, includeTimestamp: true, includeElapsed: true, timezone: 'utc' },
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
- **interrupt** — abort current, start new message
- **collect** — buffer during processing, merge on idle

## Formatting Pipeline

Platform-specific markdown conversion applied automatically:

- **Telegram** — `# headers` → bold, preserves code blocks
- **Discord** — native Markdown, auto-chunks at 2000 chars with code block integrity
- **Slack** — `**bold**` → `*bold*`, headers → bold
- **WhatsApp** — `**bold**` → `*bold*`, `~~strike~~` → `~strike~`

## Middleware

```typescript
import { rateLimit, ownerCommands, pairing, autoExtract } from '@cogitator-ai/channels';

const gateway = new Gateway({
  // ...
  middleware: [
    rateLimit({ maxPerMinute: 30 }),
    ownerCommands({ ownerIds: { telegram: '123' } }),
    pairing({ ownerIds: { telegram: '123' } }),
    autoExtract({ extractor }),
  ],
});
```

## Media & STT

Voice messages are transcribed automatically:

1. **API-based** (recommended) — set `GROQ_API_KEY` (free) or `OPENAI_API_KEY` in env
2. **Local Whisper** — downloads ~75MB model on first use, runs offline

Images are passed to the LLM as vision input if the model supports it.

## Scheduler

```typescript
import { HeartbeatScheduler, SimpleTimerStore } from '@cogitator-ai/channels';

const store = new SimpleTimerStore({ persistPath: '.cogitator/timers.json' });
const scheduler = new HeartbeatScheduler(store, {
  onFire: (msg) => gateway.injectMessage(msg),
  pollInterval: 30_000,
  maxRetries: 5,
  onRunComplete: (entry, status, error, durationMs) => {
    console.log(`Job ${entry.id}: ${status} (${durationMs}ms)`);
  },
});
scheduler.start();
```

Schedule types: `cron` (recurring), `recurring` (interval), `fixed` (one-shot). Error tracking with auto-backoff.

```typescript
await scheduler.listJobs();
await scheduler.enableJob(id);
await scheduler.disableJob(id);
await scheduler.cancelJob(id);
```

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

# WebChat
WEBCHAT_SECRET=your-secret

# STT (optional, for voice messages)
GROQ_API_KEY=...             # or OPENAI_API_KEY
```
