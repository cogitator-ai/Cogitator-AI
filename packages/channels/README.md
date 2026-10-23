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
pnpm add @atproto/api              # Bluesky (Threads, GitHub and Teams need no SDK)
pnpm add nodemailer imapflow postal-mime   # Email: SMTP, IMAP and MIME parsing (webhooks need nodemailer, plus postal-mime for raw MIME)

# RuntimeBuilder (`cogitator up`)
pnpm add better-sqlite3            # SQLite memory, knowledge graph and core facts (always needed)
pnpm add pg                        # memory.adapter: postgres, PostgresPublishStore, PostgresTokenStore
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

Supports: DMs, channel messages (via @mention, the mention is stripped from the text, answered in a new Slack thread that is a conversation of its own without earlier history, `topicId` is the thread's `ts`), threads (replies go to the thread root and continue its conversation), file shares, Socket Mode (no public URL), streaming via chat.update, reactions. Set `mentionOnly: true` to ignore channel messages that do not mention the bot when the app also subscribes to `message.channels`. In `RuntimeBuilder`, Socket Mode is on when `SLACK_APP_TOKEN` is set; otherwise Slack runs in HTTP mode on `SLACK_PORT` (default 3000). Docs: [Slack](https://cogitator.app/docs/channels/slack).

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
  // routes: { '/github/webhook': github.webhookListener() }, // plain HTTP routes on the same port
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

### Bluesky

```bash
pnpm add @atproto/api
```

```typescript
import { blueskyChannel, FileTokenStore } from '@cogitator-ai/channels';

const bluesky = blueskyChannel({
  identifier: process.env.BLUESKY_HANDLE!, // yourbot.bsky.social
  appPassword: process.env.BLUESKY_APP_PASSWORD!, // Settings → Privacy and security → App passwords
  store: new FileTokenStore(), // keeps the session across restarts
});
```

The agent answers mentions, replies and quotes in their thread, and direct messages (the app password needs "Allow access to your direct messages"). The channel polls and keeps what it has seen on Bluesky itself, so it answers what arrived while it was stopped (`catchUp: false` starts from now). Bluesky cannot edit posts (`editable: false`), so answers go out finished, as a thread of 300-grapheme posts when long. A message's `channelId` is `post:<at-uri>`, `dm:<convoId>`, or `feed` for a new post. Docs: [Bluesky](https://cogitator.app/docs/channels/bluesky).

### Threads

```typescript
import { threadsChannel, FileTokenStore } from '@cogitator-ai/channels';

const threads = threadsChannel({
  accessToken: process.env.THREADS_ACCESS_TOKEN!, // a long-lived token, renewed before it expires
  store: new FileTokenStore(),
  webhook: {
    appSecret: process.env.THREADS_APP_SECRET!,
    verifyToken: process.env.THREADS_VERIFY_TOKEN!,
    port: 3200, // or mount threads.handleWebhook in your own server
  },
});
```

The agent answers replies to the bot's posts and mentions of it, from Meta's webhooks (verification and `X-Hub-Signature-256` checked) or, without `webhook`, by polling, which skips replies people make to each other. Answers go out finished, as a chain of 500-character replies when long. The Threads API has no direct messages. Docs: [Threads](https://cogitator.app/docs/channels/threads).

### GitHub

```typescript
import { githubChannel } from '@cogitator-ai/channels';

const github = githubChannel({
  token: process.env.GITHUB_CHANNEL_TOKEN!, // a bot account's fine-grained token, or () => an App installation token
  webhook: {
    secret: process.env.GITHUB_WEBHOOK_SECRET!, // checked against X-Hub-Signature-256
    port: 8787, // its own server at /github/webhook, or mount github.handleWebhook / webhookListener()
  },
  trigger: 'mention', // or 'all'
  repositories: ['acme/*'], // default: every repository that sends events, with a warning
  associations: ['OWNER', 'MEMBER', 'COLLABORATOR'], // the default, or 'any'
});
```

The agent answers new issues and pull requests, comments on them, reviews with a body and comments on lines of a diff, from a repository or organization webhook. Each issue or pull request is a conversation, `channelId` `owner/repo#number`, and answers are comments on it. A comment on a line is answered in its review thread, which is the message's `topicId`, so each review thread is a conversation of its own. Deliveries are answered at once and handled after, each once by its `X-GitHub-Delivery` and the comment it carries (remembered in memory). It answers only the repository's owner, members and collaborators unless `associations` or `authors` say otherwise, since what people write steers an agent that holds the token, so give the bot an account and a token of its own scoped to its repositories. The bot skips its own comments and other bots (`allowBots` lets them in), and by default answers only mentions of `@login`, outside code and quotes, plus the next comment of someone it answered and comments in review threads it replied in. Answers go out finished (GitHub notifies people of a comment's first text, `stream: true` edits a comment as it grows, at most every 3 seconds), as several comments past 65536 characters. Reactions use GitHub's eight. GitHub has no upload API for comments, so `sendFile` links a file with a public `url` and refuses a buffer. A GitHub App installation token cannot read `GET /user`: set `login` to `<app-slug>[bot]`. Docs: [GitHub](https://cogitator.app/docs/channels/github).

### Email

```typescript
import { emailChannel } from '@cogitator-ai/channels';

const email = emailChannel({
  address: 'assistant@example.com', // sends from it, never answers it
  allowFrom: ['example.com', 'ann@partner.org'], // default: nobody, with a warning
  imap: {
    host: 'imap.gmail.com',
    auth: { user: 'assistant@example.com', pass: process.env.EMAIL_IMAP_PASSWORD! },
  },
  smtp: {
    host: 'smtp.gmail.com',
    port: 587,
    auth: { user: 'assistant@example.com', pass: process.env.EMAIL_SMTP_PASSWORD! },
  }, // or { transport } for any nodemailer transport
  // or instead of imap, a provider's inbound webhook:
  // webhook: { provider: 'mailgun', signingKey: process.env.EMAIL_MAILGUN_SIGNING_KEY!, port: 8788 },
});
```

The agent answers mail in its thread. Mail comes from a mailbox over IMAP (IDLE reports new mail at once, a poll every minute catches the rest, a message is marked read once the Gateway took it, so a restart reads only new mail, a refused or dropped one stays or becomes unread again, mail over 25 MB is skipped, a dropped connection is opened again with a wait that doubles up to a minute) or from the inbound webhook of Mailgun (HMAC of timestamp and token, refused after 5 minutes and handled once), Postmark or SendGrid (neither signs, so the URL carries basic auth or a `token`), answered `503` when the Gateway does not take the mail, so the provider retries. Answers go out over SMTP with `nodemailer`, as HTML rendered from the Markdown with a plain text alternative, a `Re:` subject and `In-Reply-To` and `References` set, so mail clients keep the thread. A sender is a conversation partner: `channelId` and `userId` are the address in lower case, and `topicId` is the thread's first `Message-ID`, so each email thread is a conversation of its own. The agent reads the plain text part (or the HTML as text) without the quoted history and the signature, with the subject on a thread's first mail, and attachments up to 10 MB. Mail from the bot itself, mail with the `X-Cogitator` header it puts on what it sends, auto-replies, bounces and bulk mail are skipped, and each `Message-ID` is handled once. Email is spoofable: the bot answers only `allowFrom` and `owners` (the address outside the quotes of `From`), drops mail whose DKIM, SPF or DMARC results fail for the `From` domain (`senderAuth: 'required'` also drops mail without results), and gives owner mail to the agent only with a passing result. It trusts only results the receiving side wrote: Mailgun's and SendGrid's, Postmark's spam tests, and over IMAP the `Authentication-Results` of `trustedAuthservIds` (such as `mx.google.com`), without which IMAP mail has no sender authentication. Answers cannot be edited. Docs: [Email](https://cogitator.app/docs/channels/email).

### Microsoft Teams

```typescript
import { teamsChannel } from '@cogitator-ai/channels';

const teams = teamsChannel({
  appId: process.env.TEAMS_APP_ID!, // the Microsoft App ID of the Azure Bot
  appPassword: process.env.TEAMS_APP_PASSWORD!, // a client secret of its app registration
  tenantId: process.env.TEAMS_TENANT_ID!, // single-tenant: tokens come from this tenant
  webhook: { port: 3978 }, // or mount teams.webhookListener() at /api/messages
  // tenants: ['<tenant id>'], // default: only the bot's own tenant
  // users: ['<Entra object id>'], // answer only these users
});
```

The agent answers Microsoft Teams on the Bot Framework protocol, with no SDK. Bot Framework posts every activity with a JWT, checked with `node:crypto` alone: RS256 signed by a key of the published Bot Framework JWKS (cached, loaded again once a day, and for an unknown key at most every five minutes), issued by `https://api.botframework.com` for the App ID, valid now within five minutes of skew, with a `serviceurl` claim equal to the activity's `serviceUrl` and a key endorsed for `msteams` (`403` otherwise). Activities are answered at once and handled after, each once by its id. Answers go to the Bot Connector of the conversation's verified `serviceUrl` (optionally limited to `serviceUrlHosts`) with a client credentials token of the app registration (`appType: 'SingleTenant'` by default, `'MultiTenant'` for legacy bots, which take their token from `botframework.com`, or `'UserAssignedMSI'` with a `tokenProvider`), cached until shortly before it expires. Requests Teams throttles (`429`, `412`, `502`, `504`) are tried again with a backoff that doubles, with jitter, holding the whole conversation back meanwhile, and every request gives up after 30 seconds (`requestTimeout`). Requests to one conversation stay inside all four of Teams' limits (7 a second, 8 in 2 seconds, 60 in 30 seconds, 1800 an hour), edits and typing using at most three quarters of each, so new messages always find room. A user who blocked the bot fails with a `TeamsApiError` whose `errorCode` is `MessageWritesBlocked`, and the conversation gets nothing more until it writes again. `channelId` is the Teams conversation id of a personal chat, a group chat or a team channel, whose threads are topics (`topicId` is the thread's root message id), so every chat and every channel thread is a conversation of its own. `userId` is the user's Entra object id. In group chats and channels the bot answers @mentions, without the mention in the text (Teams sends it nothing else unless the app has the resource-specific consent `ChannelMessage.Read.Group` or `ChatMessage.Read.Chat`, then `trigger: 'all'` answers every message). It answers only users of its own tenant unless `tenants` says otherwise. Answers are Markdown (`textFormat: 'extendedmarkdown'`), up to 13653 characters a message (80 KB of JSON whatever the text), with images sent as links so an injected answer cannot leak through an image URL, and are edited as they stream, at most once a second per message. Buttons are Adaptive Cards: `Action.Execute`, whose press is answered in the response of its invoke, with an `Action.Submit` fallback, both delivered to `onAction`, so approval prompts get Approve and Deny buttons. `sendFile` uploads a buffer in personal chats through a file consent card (the manifest needs `supportsFiles`), and elsewhere sends an image with a public `url` inline and other files as a link. Docs: [Microsoft Teams](https://cogitator.app/docs/channels/teams).

## Platform Comparison

| Feature            | Telegram     | Discord | Slack     | WhatsApp | WebChat   | Bluesky            | Threads            | GitHub              | Email              | Teams         |
| ------------------ | ------------ | ------- | --------- | -------- | --------- | ------------------ | ------------------ | ------------------- | ------------------ | ------------- |
| Streaming (edit)   | ✅           | ✅      | ✅        | ✅       | ✅        | ❌ (sent finished) | ❌ (sent finished) | with `stream: true` | ❌ (sent finished) | ✅            |
| Reactions          | ✅           | ✅      | ✅        | ❌       | ❌        | ❌                 | ❌                 | ✅ (8 kinds)        | ❌                 | ❌            |
| Typing indicator   | ✅           | ✅      | ❌        | ✅       | ✅        | ❌                 | ❌                 | ❌                  | ❌                 | ✅            |
| Photos → vision    | ✅           | ✅      | ✅        | ✅       | ❌        | ❌                 | ❌                 | ❌                  | ✅ (attachments)   | ✅            |
| Voice → STT        | ✅           | ✅      | ✅        | ✅       | ❌        | ❌                 | ❌                 | ❌                  | ✅ (attachments)   | ❌            |
| Max message length | 4096         | 2000    | 40000     | 65536    | unlimited | 300 per post       | 500 per post       | 65536 per comment   | unlimited          | 13653         |
| Public URL needed  | webhook only | no      | HTTP only | no       | no        | no                 | webhooks only      | yes (webhook)       | webhooks only      | yes (webhook) |

Outbound calls (`sendText`, `editText`, `sendFile`, `deleteMessage`) throw when the channel is not started, the target chat is unavailable or the platform rejects the request — wrap direct calls in `try/catch`. WebChat is the exception: only `sendText` throws for a disconnected client, the other calls are dropped. `sendText` returns the platform message id (for Discord, the id of the first chunk; continuation chunks are edited and deleted with it).

## Social Feeds

Feeds publish posts instead of answering people. `BlueskyFeed` and `ThreadsFeed` publish text with a link card, images with alt text, tags, replies and quotes of other posts. `FeedPublisher` sends one post to several feeds, now or at `publishAt`:

```typescript
import {
  BlueskyFeed,
  FeedPublisher,
  FilePublishStore,
  FileTokenStore,
  ThreadsFeed,
} from '@cogitator-ai/channels';

const tokens = new FileTokenStore();
const publisher = new FeedPublisher({
  feeds: [
    new BlueskyFeed({
      identifier: process.env.BLUESKY_HANDLE!,
      appPassword: process.env.BLUESKY_APP_PASSWORD!,
      store: tokens,
    }),
    new ThreadsFeed({ accessToken: process.env.THREADS_ACCESS_TOKEN!, store: tokens }),
  ],
  store: new FilePublishStore(), // scheduled posts and retries survive a restart
});

const { job } = await publisher.publish(
  {
    text: 'A new open model runs on a laptop:',
    link: { url: 'https://example.com/story' },
    tags: ['AI'],
  },
  { key: 'story-42' } // publishing twice with one key publishes once
);
publisher.start(); // publishes scheduled posts and retries when they are due
```

- Each feed is tried on its own and each outcome saved as soon as it is known. A delivery keeps the feed's idempotency key from before its first attempt, so an attempt after a crash or a lost answer finds the post instead of publishing it twice (Bluesky publishes under that record key, Threads looks the post up). Retries wait as long as the feed asked or back off from one minute to an hour, and a full Threads quota is waited out without spending attempts.
- `replyTo` and `quote` name a post of one feed, so a reply or a quote goes to that feed only: take the id from that feed's delivery and publish with `feeds: [delivery.feed]`.
- Text is measured as each feed counts it (`graphemeLength` on Bluesky, with its 3000-byte limit too, `threadsLength` on Threads with emoji as their UTF-8 bytes) and fitted to each feed with an ellipsis (`overflow: 'fail'` fails instead). Each feed checks its rules before sending (images, links, tags) and fails with a `FeedError` that says whether retrying helps.
- Jobs live in `MemoryPublishStore`, `FilePublishStore` or `PostgresPublishStore` (several workers, claims with `FOR UPDATE SKIP LOCKED`). A worker takes one due job at a time, extends its claim while it works and saves only while the claim is its own. Sessions and tokens live in `MemoryTokenStore`, `FileTokenStore` (owner-only file, shared safely by the stores of one process) or `PostgresTokenStore`.
- The Threads token renews itself a week before its 60 days end. `BlueskyAccount` and `ThreadsAccount` share one session between a feed and a channel.

Docs: [Social Feeds](https://cogitator.app/docs/channels/feeds).

## Gateway

Routes incoming messages to your agent. Handles:

- Conversation threads: one per user per conversation (chat, forum topic, Slack thread, Bluesky or Threads post thread, GitHub issue, pull request or review thread, email thread, Teams chat or channel thread), answered one message at a time
- Session management (per-user, per-channel) with an optional custom `sessionManager`
- History compaction, hierarchical into a handoff of grounded atoms or with LLM-written summaries
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
    // default: `${channelType}:${conversation}:${userId}`, see Conversation threads below
    threadKey: (msg) => `${msg.channelType}:${msg.channelId}`, // one thread per chat, shared by its members
    // compact once a conversation holds 50 messages (or `threshold` tokens), keep about 4000 tokens of the newest turns verbatim
    compaction: {
      strategy: 'hierarchical',
      messageThreshold: 50,
      keepRecent: 10,
      keepRecentTokens: 4000,
    },
  },
  runTimeout: 120_000,
  brief: (msg) => `Current date and time: ${new Date().toISOString()}`, // sent with each run's input, not saved
});

gateway.stats; // { uptime, activeSessions, totalSessions, messagesToday, connectedChannels }
gateway.getSessions(); // [{ threadId: 'telegram:42:42', userName, messageCount, lastActiveAt, active }], one per conversation
await gateway.compactThread('telegram:42:42'); // force compaction of one conversation
await gateway.compactAll(); // every thread served since start and of every stored session: "Compacted 2 of 3 threads"
await gateway.injectMessage(msg); // feed a synthetic message and wait for its answer (used by the scheduler)
await gateway.idle(); // wait until every queued message is answered
await gateway.stop(); // answers what is queued first, up to drainTimeout (30 s), then aborts the rest
```

`GatewayConfig.owner` is deprecated and never read: set owners on `ownerCommands({ ownerIds })` and `dmPolicy({ ownerIds })` (see [Middleware](#middleware)).

### Conversation threads

A thread is the conversation memory and the queue of one user in one conversation. The default key is `channelType:conversation:userId`, where the conversation is the message's `conversationId` if it has one, else its `channelId` plus `:topicId` when it has a topic (`defaultThreadKey` computes it):

| Channel          | Conversation                                                                | Example thread                                                   |
| ---------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Telegram         | chat, plus the forum topic                                                  | `telegram:-100123:7:42`                                          |
| Slack            | DM, or the Slack thread of a channel message (`topicId`, the thread's `ts`) | `slack:C123:1712.5:U1`                                           |
| Discord          | channel, a thread is a channel of its own                                   | `discord:98765:1234`                                             |
| Bluesky, Threads | the post thread's root (`conversationId`), not the reply post               | `bluesky:thread:at://did:plc:a/app.bsky.feed.post/1:did:plc:b`   |
| GitHub           | issue or pull request, plus the review thread (`topicId`)                   | `github:acme/app#12:583231`, `github:acme/app#12:1840022:583231` |
| Email            | sender, plus the email thread (`topicId`, its first `Message-ID`)           | `email:ann@example.com:<a1@example.com>:ann@example.com`         |
| Teams            | chat, plus the channel thread (`topicId`, its root message)                 | `teams:19:ops@thread.tacv2:1700000000000:<entra id>`             |
| WhatsApp         | chat, a chat addressed by LID by the phone-number jid                       | `whatsapp:15550001111@s.whatsapp.net:15550001111`                |
| WebChat          | client                                                                      | `webchat:c7f2:c7f2`                                              |

So a user keeps a separate thread in their private chat, in each group and in each topic, and every reply in a Bluesky or Threads post thread lands in the same one. In a Slack channel each top-level message is answered in a new Slack thread, a conversation of its own without the history of earlier ones, and its follow-ups in that thread continue it, while a DM is one conversation. On GitHub each issue or pull request is a conversation, and each review thread another one. By email each thread is a conversation, however its subject changes. In Teams each personal and group chat is a conversation, and each thread of a team channel another one. A WhatsApp chat that reaches a person by LID gets their phone-number jid as its `conversationId` when WhatsApp shares it, so it stays one thread with the chat addressed by phone number.

The gateway keeps the conversations of each user in their session's metadata (`conversations`, up to 50, most recent first), and `compactAll()` finds their threads there after a restart. A run gets the `topicId` and `conversationId` of its message, and its tools see them in their context, so `schedule_task` stores them with the task and `HeartbeatScheduler` fires it into the same topic and thread, even when the user has moved on to another one. A task without them is answered in the topic and thread of the user's most recent conversation in its chat. With a custom `threadKey` the gateway keeps no conversations and leaves stored sessions out of `compactAll()`, except with `legacyThreadKey`, whose thread of each stored session it still finds.

Up to 0.15 the key was `channelType:userId`, one thread per user per channel type. Threads stored under it are not found by the new key. To keep them, pass `legacyThreadKey`:

```typescript
import { legacyThreadKey } from '@cogitator-ai/channels';

new Gateway({ ...config, session: { threadKey: legacyThreadKey } });
```

`session.compaction` is a `CompactionConfig`. With `strategy: 'hierarchical'` the older messages become a handoff of grounded atoms (facts, tasks, decisions, constraints, errors, files, open questions) and the newest `keepRecentTokens` stay verbatim, see [Hierarchical Compaction](https://cogitator.app/docs/memory#hierarchical-compaction). The gateway's summarizer asks the model and prompt each call names, falling back to `summaryModel` and `summaryPrompt`, then to the agent's model and a default prompt. `compactAll()` goes one thread at a time, past those that fail, and lists them after the count.

`brief(msg)` returns notes for the run of each message, passed as `RunOptions.brief`: they go with the input, after what memory recalls for it, and are not saved to the thread. Put what changes from message to message there, such as the current time, rather than in the agent's instructions, so the instructions stay the same and the prompt cache keeps serving them.

`stream` takes `flushInterval` and `minChunkSize` (ms / chars between edits), plus optional `minInitialChars` (wait for this much text before the first message), `maxMessageChars` (defaults to the platform limit) and `deleteOnAbort` (remove the partial answer when the run is interrupted). Telegram streams through message drafts when available and falls back to edits.

Docs: [Gateway](https://cogitator.app/docs/channels/gateway), [Streaming](https://cogitator.app/docs/channels/streaming).

## Approvals

Tools marked `requiresApproval` (for example `create_tool` from `capabilities.selfTools`) pause the run before they execute — unless the Cogitator has `guardrails.onToolApproval`, which then decides instead. The Gateway turns that pause into a chat conversation:

1. The paused run's text (if any) is sent, followed by a prompt listing each waiting call — tool name, description and compact JSON arguments (cut at 300 characters).
2. The user replies `approve` / `yes` to run the calls, or `deny` / `no` to refuse, optionally followed by a reason (`no, too risky`) that the agent sees. Replies are case-insensitive and may end with punctuation; `да` / `одобряю` and `нет` / `отклоняю` work out of the box.
3. The Gateway calls `cogitator.resume(agent, threadId, { userId, defaultDecision })` and delivers the result like any reply, streaming included. If the run pauses again, a new prompt is sent.

On channels with buttons (Telegram, Microsoft Teams), the prompt also carries **Approve** and **Deny** buttons. A press answers exactly like the reply words, through the same middleware and checks, and the buttons then show the decision. `approvals.buttons: false` turns them off and `approvals.buttonLabels` renames them. A press counts only from the user the prompt asked, while their run is still paused; any other press gets an alert (`notAllowedMessage`, or `expiredMessage` once the request was answered, dropped or predates a restart, when a reply word still works). A press in a group counts as a message of that group (`ChannelAction.groupId`), and a press while the Gateway stops gets `stoppingMessage` and leaves the request waiting.

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

Messages merge per chat, topic and user, keeping `topicId` and `replyTo`, so answers land in the topic they were asked in.

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

Control how the messages of one thread wait for each other. Different threads always run side by side.

```typescript
const gateway = new Gateway({
  // ...
  queueMode: 'sequential', // the default, or 'parallel' | 'interrupt' | 'collect'
});
```

- **sequential** - default, FIFO per thread: a message waits until the one before it is answered
- **parallel** - every message runs at once, also in the same thread (the default up to 0.15)
- **interrupt** - abort the current run (its signal is passed to `cogitator.run`), start the new message
- **collect** - buffer during processing, merge per chat and topic on idle

With a queue, a channel's message handler returns once the message is queued, so a channel that reads its updates one by one (Telegram long polling, the Bluesky and Threads polls) goes on to other chats, button presses and stop buttons while a thread is busy. `injectMessage` still resolves once the message is answered, and `idle()` waits for every queued message. Since the channel has confirmed a queued message to its platform already, `stop()` drains the queues before it stops the channels: it waits up to `drainTimeout` (default 30000 ms) for the queued messages and the runs in progress, then aborts the runs still going and drops what still waits. Messages that come in while it stops are dropped and reported to `onError`, a second `stop()` returns the same promise, and `injectMessage` rejects when its message was not answered (failed run, aborted or dropped by `stop()`).

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
        target === 'all'
          ? gateway.compactAll()
          : gateway.compactThread(target === 'current' ? threadId : target),
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

Schedule types: `cron` (recurring, next fire computed with `cron-parser`, honors `timezone`), `recurring` (interval), `fixed` (one-shot). Consecutive failures are carried across reschedules, and a one-shot job whose `onFire` throws stays pending to fire again (unless `bestEffort`). After `maxRetries` the job is skipped until `enableJob()`. A fired job reaches `onFire` as a message on the `channel` / `channelId` / `userId` / `topicId` / `conversationId` stored in its `metadata`, and `staggerMs` adds a random delay before the first poll. Docs: [Scheduler](https://cogitator.app/docs/channels/scheduler).

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

The gateway of a `RuntimeBuilder` uses the defaults: a thread per user per conversation, answered one message at a time. The `session` block of `cogitator.yml` changes them: `threadKey: legacy` keeps the threads stored up to 0.15 (`legacyThreadKey`), and `queueMode` takes any [queue mode](#queue-modes).

```yaml
session:
  threadKey: legacy # or conversation (default)
  queueMode: parallel # sequential (default), interrupt, collect
```

For a parsed YAML file, validate it first with `new RuntimeBuilder(AssistantConfigSchema.parse(yamlObject), process.env)` (the schema is exported, along with the `AssistantConfigInput` / `AssistantConfigOutput` types).

- **Channels:** the terminal REPL plus `channels.telegram` (`TG_TOKEN` or `TELEGRAM_TOKEN`), `channels.discord` (`DISCORD_TOKEN`) and `channels.slack` (`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, optional `SLACK_APP_TOKEN` / `SLACK_PORT`). A configured channel without its token is skipped with a warning. `channels.whatsapp` (`{ ownerIds?, sessionPath? }`, owner ids are phone numbers without `@s.whatsapp.net`, the session defaults to `~/.cogitator/whatsapp-session`) needs `@whiskeysockets/baileys`. `channels.webchat` (`{ port?, path? }`, default `8080` and `/ws`, no `ownerIds`) needs `ws` and starts only with `WEBCHAT_TOKEN` set, and clients connect with `?token=<WEBCHAT_TOKEN>`. `channels.bluesky` (`{ ownerIds?, posts?, directMessages?, pollInterval?, tokenPath? }`, owner ids are DIDs) needs `@atproto/api` and starts with `BLUESKY_HANDLE` and `BLUESKY_APP_PASSWORD`. `channels.threads` (`{ ownerIds?, webhook?: { port, path? }, pollInterval?, tokenPath? }`, owner ids are usernames) starts with `THREADS_ACCESS_TOKEN`, and with `THREADS_APP_SECRET` and `THREADS_VERIFY_TOKEN` for webhooks. Both keep their session or token in `tokenPath` (default `~/.cogitator/tokens.json`). `channels.github` (`{ ownerIds?, webhook?: { port?, path? }, trigger?, repositories?, associations?, authors?, login?, allowBots?, stream? }`, owner ids are numeric user ids, the webhook server defaults to port `8787` at `/github/webhook`) starts with `GITHUB_CHANNEL_TOKEN` (falling back to `GITHUB_TOKEN` with a warning) and `GITHUB_WEBHOOK_SECRET`, and calls `GITHUB_API_URL` when set (GitHub Enterprise Server). `channels.email` (`{ ownerIds?, address?, name?, aliases?, allowFrom?, senderAuth?, trustedAuthservIds?, subject?, imap?: { host?, port?, secure?, mailbox?, pollInterval?, lookbackDays? }, smtp?: { host?, port?, secure? }, webhook?: { provider, port?, path? } }`, owner ids are addresses, allowed and given owner rights with a passing sender authentication, the webhook server defaults to port `8788` at `/email/webhook`) needs `nodemailer`, plus `imapflow` and `postal-mime` for IMAP. It takes the address, hosts and ports from the file or `EMAIL_ADDRESS`, `EMAIL_IMAP_HOST`, `EMAIL_IMAP_PORT`, `EMAIL_SMTP_HOST` and `EMAIL_SMTP_PORT`, the passwords from `EMAIL_IMAP_PASSWORD` and `EMAIL_SMTP_PASSWORD` (users `EMAIL_IMAP_USER` and `EMAIL_SMTP_USER`, default the address), and reads over IMAP when `imap` is set or `EMAIL_IMAP_HOST` is. A Mailgun webhook needs `EMAIL_MAILGUN_SIGNING_KEY`, Postmark and SendGrid `EMAIL_WEBHOOK_TOKEN` (`?token=` in the URL) or `EMAIL_WEBHOOK_USER` and `EMAIL_WEBHOOK_PASSWORD` (basic auth). `channels.teams` (`{ ownerIds?, appType?, tenantId?, tenants?, users?, trigger?, serviceUrlHosts?, webhook?: { port?, path? } }`, owner ids are Entra object ids, the messaging endpoint defaults to port `3978` at `/api/messages`) starts with `TEAMS_APP_ID` and `TEAMS_APP_PASSWORD`, and `TEAMS_TENANT_ID` (or `tenantId`) for a single-tenant bot. A multi-tenant bot needs `tenants`, and a `UserAssignedMSI` one is built in code with a `tokenProvider`.

- **Memory:** `memory.adapter: sqlite` (default, `memory.path`, default `~/.cogitator/memory.db`) or `postgres` (`memory.connectionString`, `DATABASE_URL` or `POSTGRES_URL`, requires `pg`). Core facts always live in the SQLite file, as memory items with their history. The knowledge graph (`memory.knowledgeGraph`) and auto-extraction (`memory.autoExtract`) are on by default, and the memory tools keep memory items in the memory store too: `remember` keeps a fact as the user's (an `active` item, a core fact) only when its `quote` is in one of the run user's own messages on the thread's active branch, else as a suggestion, `recall` searches the items of the user and the thread, and `forget` lets go only the run's own that hold the query as whole words (a run without a user keeps its facts in the thread's memory). The assistant's agent id is its `name`, the same across restarts. `memory.compaction.threshold` enables history compaction, hierarchical, keeping about 4000 tokens of the newest turns verbatim.
- **Fresh context:** the gateway builds an agent per message: instructions (with known user facts) and the `/model` override are resolved each time. The current date and time go to each run as its `brief`, with the input, so they do not change the instructions and their prompt cache. `runtime.agent` is the base agent.
- **Owner commands wired:** `/status`, `/sessions`, `/users`, `/compact` (`/compact all` for every thread), `/model` (global or per user), `/restart`.
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

# Bluesky (session kept in ~/.cogitator/tokens.json)
BLUESKY_HANDLE=yourbot.bsky.social
BLUESKY_APP_PASSWORD=...         # an app password, with DM access to answer messages

# Threads (token renewed in ~/.cogitator/tokens.json)
THREADS_ACCESS_TOKEN=...         # a long-lived token
THREADS_APP_SECRET=...           # webhooks only
THREADS_VERIFY_TOKEN=...         # webhooks only

# GitHub (a webhook delivers to port 8787 at /github/webhook)
GITHUB_CHANNEL_TOKEN=github_pat_...  # a separate bot account's token, scoped to the repositories it answers in
GITHUB_TOKEN=ghp_...             # capabilities.github, and the channel's fallback (with a warning)
GITHUB_WEBHOOK_SECRET=...        # the secret set on the webhook
GITHUB_API_URL=...               # GitHub Enterprise Server only, https://<host>/api/v3

# Email (channels.email, hosts and ports may be in cogitator.yml instead)
EMAIL_ADDRESS=assistant@example.com
EMAIL_IMAP_HOST=imap.gmail.com   # reading over IMAP
EMAIL_IMAP_PORT=993
EMAIL_IMAP_USER=...              # default EMAIL_ADDRESS
EMAIL_IMAP_PASSWORD=...          # an app password for Gmail and Outlook
EMAIL_SMTP_HOST=smtp.gmail.com
EMAIL_SMTP_PORT=587              # 465 for TLS from the start
EMAIL_SMTP_USER=...              # default EMAIL_ADDRESS
EMAIL_SMTP_PASSWORD=...
EMAIL_MAILGUN_SIGNING_KEY=...    # webhook.provider: mailgun
EMAIL_WEBHOOK_TOKEN=...          # webhook.provider: postmark or sendgrid, ?token= in the URL
EMAIL_WEBHOOK_USER=...           # or basic auth in the URL, https://user:password@host/email/webhook
EMAIL_WEBHOOK_PASSWORD=...

# Microsoft Teams (channels.teams)
TEAMS_APP_ID=...                 # the Microsoft App ID of the Azure Bot
TEAMS_APP_PASSWORD=...           # a client secret of its app registration
TEAMS_TENANT_ID=...              # the tenant of the app registration (single-tenant)

# STT (optional, for voice messages — pick one)
DEEPGRAM_API_KEY=...         # highest priority
GROQ_API_KEY=...             # free tier
OPENAI_API_KEY=...           # fallback
```
