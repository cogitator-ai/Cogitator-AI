# @cogitator-ai/cli

## 0.11.4

### Patch Changes

- Updated dependencies [[`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b), [`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b)]:
  - @cogitator-ai/memory@0.26.0
  - @cogitator-ai/core@0.62.0
  - @cogitator-ai/types@0.71.0
  - @cogitator-ai/config@0.25.0
  - create-cogitator-app@0.13.0
  - @cogitator-ai/channels@0.18.4
  - @cogitator-ai/studio@0.3.21
  - @cogitator-ai/mcp@19.5.29
  - @cogitator-ai/deploy@0.6.35

## 0.11.3

### Patch Changes

- Updated dependencies [[`213e3fb`](https://github.com/cogitator-ai/Cogitator-AI/commit/213e3fba0f0ed9a1290fdd1499dd4a0e4101b6e2)]:
  - @cogitator-ai/types@0.70.0
  - @cogitator-ai/core@0.61.1
  - @cogitator-ai/channels@0.18.3
  - @cogitator-ai/config@0.24.8
  - @cogitator-ai/deploy@0.6.34
  - @cogitator-ai/mcp@19.5.28
  - @cogitator-ai/memory@0.25.6
  - @cogitator-ai/studio@0.3.20

## 0.11.2

### Patch Changes

- Updated dependencies [[`091fa9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/091fa9e659341bc0f39344e46ec0c56ba0338f83)]:
  - @cogitator-ai/types@0.69.0
  - @cogitator-ai/core@0.61.0
  - create-cogitator-app@0.12.0
  - @cogitator-ai/channels@0.18.2
  - @cogitator-ai/config@0.24.7
  - @cogitator-ai/deploy@0.6.33
  - @cogitator-ai/mcp@19.5.27
  - @cogitator-ai/memory@0.25.5
  - @cogitator-ai/studio@0.3.19

## 0.11.1

### Patch Changes

- Updated dependencies [[`8b099ce`](https://github.com/cogitator-ai/Cogitator-AI/commit/8b099ce06be7587aa7e350a0c3986eeb057c526e)]:
  - @cogitator-ai/types@0.68.0
  - @cogitator-ai/channels@0.18.1
  - @cogitator-ai/config@0.24.6
  - @cogitator-ai/core@0.60.3
  - @cogitator-ai/deploy@0.6.32
  - @cogitator-ai/mcp@19.5.26
  - @cogitator-ai/memory@0.25.4
  - @cogitator-ai/studio@0.3.18

## 0.11.0

### Minor Changes

- [#278](https://github.com/cogitator-ai/Cogitator-AI/pull/278) [`4c4ad3a`](https://github.com/cogitator-ai/Cogitator-AI/commit/4c4ad3a898675f7730236d1b2c6482b2fe108b32) - Channels: a Microsoft Teams channel on the Bot Framework protocol, with no SDK.

  - `teamsChannel({ appId, appPassword, tenantId })` takes activities on a webhook, on a server of the channel's own (`/api/messages`, bodies up to 1 MB, other routes such as a GitHub webhook served on the same port) or through `handleWebhook` and `webhookListener()`. Every request must carry a Bot Framework JWT, checked with `node:crypto` alone: RS256 only, signed by a key of the published JWKS (cached, loaded again in the background once a day, and for an unknown key at most every five minutes), issued by `https://api.botframework.com` for the App ID, valid now within five minutes of skew, with a `serviceurl` claim equal to the activity's `serviceUrl` and a key endorsed for `msteams`. Activities are answered at once and handled after, each once, and the bot's own are skipped.
  - Answers go to the Bot Connector of the conversation's verified `serviceUrl` (optionally limited to `serviceUrlHosts`), with a client credentials token from the bot's own tenant (`appType: 'SingleTenant'` by default, `'MultiTenant'` for legacy bots, `'UserAssignedMSI'` with a `tokenProvider`), cached until shortly before it expires. Requests to one conversation stay inside all four of Teams' limits (7 a second, 8 in 2 seconds, 60 in 30 seconds, 1800 an hour), with edits and typing kept to three quarters of each so new messages always find room. Throttled and failing requests (`429`, `412`, `502`, `504`) are tried again with a backoff that doubles, with jitter, holding the conversation back meanwhile, every request has a timeout, and errors are `TeamsApiError`s with the Bot Connector's `errorCode`. After `MessageWritesBlocked` (the user blocked the bot) the conversation gets nothing more until it writes again.
  - Each personal chat, group chat and channel thread is a conversation of its own: `channelId` is the conversation id, a channel thread's root message is its `topicId`, and `userId` is the user's Entra object id. In group chats and channels the bot answers @mentions without the mention in the text (`trigger: 'all'` answers every message an app with resource-specific consent gets), and only users of its own tenant unless `tenants` says otherwise.
  - Answers are Markdown with `textFormat: 'extendedmarkdown'`, up to 13653 characters a message (80 KB of JSON), with images sent as links so injected text cannot leak data through an image URL, and stream into a message the bot edits. Buttons are Adaptive Cards with `Action.Execute`, answered in the invoke response, and an `Action.Submit` fallback, both delivered to `onAction`, so approval prompts get Approve and Deny buttons. Files upload in personal chats through a file consent card, and elsewhere go out by their public URL. A message the Gateway refuses while it stops is answered `503`.
  - `ChannelType` includes `'teams'`, and a channel thread is a `topicId`.
  - `ChannelAction.groupId` names the group a button was pressed in. The Gateway checks an approval press against the group policy like a message of that group (Telegram and Teams set it), and a press while the Gateway stops gets `approvals.stoppingMessage` and leaves the request waiting instead of being lost.
  - `chunkMessage` never cuts an emoji or another surrogate pair in two, on every channel.
  - In `cogitator.yml`, `channels.teams` takes owners (Entra object ids), `appType`, `tenantId`, `tenants`, `users`, `trigger`, `serviceUrlHosts` and the webhook port and path (default `3978`), with the secrets from `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD` and `TEAMS_TENANT_ID`. `cogitator init`, `cogitator wizard` and create-cogitator-app (`--channels teams`) set up a single-tenant bot. Projects that `cogitator init` and create-cogitator-app generate serve its messaging endpoint on the WebChat port when WebChat runs, and the GitHub webhook on the Teams port when both run, while `cogitator wizard` writes `cogitator.yml` with a port per channel (3978 for Teams). `UserAssignedMSI` is built in code with a `tokenProvider`.

### Patch Changes

- Updated dependencies [[`4c4ad3a`](https://github.com/cogitator-ai/Cogitator-AI/commit/4c4ad3a898675f7730236d1b2c6482b2fe108b32)]:
  - @cogitator-ai/channels@0.18.0
  - @cogitator-ai/types@0.67.0
  - create-cogitator-app@0.11.0
  - @cogitator-ai/config@0.24.5
  - @cogitator-ai/core@0.60.2
  - @cogitator-ai/deploy@0.6.31
  - @cogitator-ai/mcp@19.5.25
  - @cogitator-ai/memory@0.25.3
  - @cogitator-ai/studio@0.3.17

## 0.10.0

### Minor Changes

- [#276](https://github.com/cogitator-ai/Cogitator-AI/pull/276) [`9b5004a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9b5004a447439427e934531f0ed7c4668f41ad30) - Channels: an email channel, so an agent answers mail in the thread it came in.

  - `emailChannel({ address, smtp, imap, allowFrom })` reads unread mail of a mailbox over IMAP with `imapflow` and `postal-mime`: IDLE reports new mail at once and a poll catches the rest, mail is flagged `\Seen` only once the Gateway took it, so a restart reads only new mail, and a dropped connection is opened again with a wait that doubles from 1 s up to 60 s. Mail is fetched in batches, mail over `maxBytes` (25 MB) is skipped by its size, the rest is parsed a few at once and handed over in order. `start()` fails at once when `imapflow`, `postal-mime` or `nodemailer` is missing.
  - Inbound webhooks of Mailgun, Postmark and SendGrid work instead of IMAP or with it, on a server of the channel's own (bodies up to 10 MB) or through `handleWebhook({ method, query, headers, rawBody })`. Mailgun requests must carry a valid HMAC of timestamp and token (or of the body in JSON mode), at most 5 minutes old, and a replayed signature is not handled again. Postmark and SendGrid do not sign, so their URL carries basic auth or a `token`, compared in constant time. SendGrid fields are decoded in the character sets SendGrid names. A request whose mail the Gateway does not take is answered `503`, so the provider sends it again.
  - Answers go out over SMTP with `nodemailer`, or any transport with `sendMail`, as HTML rendered from the Markdown with a plain text alternative, with a `Re:` subject and `In-Reply-To` and `References` set, so mail clients keep the thread. A reminder with only a topic answers the thread's latest mail. Files are sent as attachments. Sent mail cannot be edited (`editable: false`), and an answer is one mail however long.
  - A message's `channelId` and `userId` are the sender's address in lower case, `topicId` is the thread's first `Message-ID`, and `replyTo` is `In-Reply-To`, so each email thread is a conversation of its own. The agent reads the plain text part, or the HTML as text, without the quoted history (`On ... wrote:` in several languages, Outlook headers, a trailing `>` block) and the signature, with the subject on a thread's first mail, and attachments up to 10 MB.
  - The bot never answers itself, its `aliases` or mail with the `X-Cogitator` header it puts on everything it sends, and skips auto-replies, bounces and bulk or list mail. Each `Message-ID` is handled once.
  - Email is spoofable, so the bot answers only `allowFrom` (addresses, domains, `*.domain` or `*`, nobody by default with a warning) and `owners`, reading the address outside the quoted strings and comments of `From`. It drops mail whose DKIM, SPF or DMARC results fail for the `From` domain, using only results the receiving side wrote: Mailgun's (two copies of a header fail) and SendGrid's reports, Postmark's spam tests, and over IMAP the topmost `Authentication-Results` of `trustedAuthservIds`, without which IMAP mail counts as not reported. `senderAuth: 'required'` also drops mail without results, and owner mail reaches the agent only with a passing result.
  - A channel learns which messages the Gateway does not answer because it stops: the new optional `Channel.redeliver(msg)` gets a message that comes in while the Gateway stops (before its handler resolves) and the queued or running ones `stop()` drops after `drainTimeout`, before the channels stop. The email channel leaves such mail unread or marks it unread again, and answers the webhook `503`.
  - `htmlToText` and `markdownToHtml` are exported, and `ChannelType` includes `'email'`.
  - In `cogitator.yml`, `channels.email` takes the address, `allowFrom`, owners (always answered), `imap`, `smtp` and a `webhook` provider, checked as addresses and domains, with the secrets and, where the file leaves them out, hosts and ports from `EMAIL_*` variables. `cogitator init`, `cogitator wizard` and create-cogitator-app (`--channels email`) set up a bot that reads a mailbox over IMAP.

### Patch Changes

- Updated dependencies [[`9b5004a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9b5004a447439427e934531f0ed7c4668f41ad30)]:
  - @cogitator-ai/channels@0.17.0
  - @cogitator-ai/types@0.66.0
  - create-cogitator-app@0.10.0
  - @cogitator-ai/config@0.24.4
  - @cogitator-ai/core@0.60.1
  - @cogitator-ai/deploy@0.6.30
  - @cogitator-ai/mcp@19.5.24
  - @cogitator-ai/memory@0.25.2
  - @cogitator-ai/studio@0.3.16

## 0.9.0

### Minor Changes

- [#272](https://github.com/cogitator-ai/Cogitator-AI/pull/272) [`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899) - Channels: a GitHub channel, so an agent answers issues, pull requests, comments and code reviews.

  - `githubChannel({ token, webhook: { secret, port } })` takes events from a repository or organization webhook: opened issues and pull requests, issue and pull request comments, reviews with a body and comments on lines of a diff. Every delivery is checked against `X-Hub-Signature-256` with the webhook secret, answered at once and handled after, and each `X-GitHub-Delivery` is handled once. It runs a webhook server of its own on `port` (bodies up to 1 MB), or `handleWebhook` is mounted in any HTTP server with the raw body.
  - Each issue or pull request is a conversation, `channelId` `owner/repo#number`, answered with a comment on it. A comment on a line is answered in its review thread, which is the message's `topicId`, so every review thread is a conversation of its own.
  - It answers only the repository's owner, the organization's members and collaborators (`author_association`), whatever the trigger: `associations` names others or `'any'`, and `authors` lists logins answered whatever their association. What people write steers an agent that holds the bot's token, so the docs recommend a bot account with a fine-grained token scoped to its repositories, `repositories` set (`start()` warns without it) and approvals for tools that write.
  - By default the bot answers only mentions of `@login` (outside fenced, indented and inline code and quotes), plus the next comment of someone it answered (such as the answer to an approval prompt) and comments in review threads it replied in. `trigger: 'all'` answers every event, and `repositories` limits it to `owner/repo` or `owner/*`. It skips its own comments, with or without an app's `[bot]`, and other bots unless `allowBots` is set.
  - Deliveries are handled once by `X-GitHub-Delivery` and by the comment, issue or review they carry, remembered in memory. A delivery that comes while the bot's login cannot be loaded is still answered `200` and the login is tried again before the event is dropped. Once stopped the channel answers `503`.
  - Answers are sent finished, since GitHub notifies people of a comment's first text, and `stream: true` streams them into a comment it edits, at most every 3 seconds (`GITHUB_MIN_EDIT_INTERVAL`) with the latest text. Answers past 65536 characters go out as several comments. `setReaction` uses GitHub's eight reactions and replaces the bot's earlier one, one after another per message, and `sendFile` links files with a public URL, as GitHub has no upload API for comments.
  - `token` takes a function too, for GitHub App installation tokens that expire, with `login` set to `<app-slug>[bot]`. `apiUrl` points it at GitHub Enterprise Server. REST errors are `FeedError`s with `retryAfter` from `Retry-After` or the rate limit reset.
  - `webhookListener()` is the webhook as a Node request listener, and `webchatChannel({ routes })` serves plain HTTP routes on the WebChat port, so a project with both takes GitHub's webhook on the WebChat port.
  - `ChannelType` includes `'github'`. In `cogitator.yml`, `channels.github` reads `GITHUB_CHANNEL_TOKEN` (falling back to `GITHUB_TOKEN`, the token of the `github_api` tool, with a warning) and `GITHUB_WEBHOOK_SECRET`, and checks `repositories`, `webhook.path` and numeric `ownerIds`. `cogitator init`, `cogitator wizard` and create-cogitator-app (`--channels github`) set it up with `GITHUB_CHANNEL_TOKEN`, and with WebChat too the scaffolded webhook is a route of the WebChat server.

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
  - @cogitator-ai/channels@0.16.0
  - @cogitator-ai/types@0.65.0
  - create-cogitator-app@0.9.0
  - @cogitator-ai/core@0.60.0
  - @cogitator-ai/config@0.24.3
  - @cogitator-ai/deploy@0.6.29
  - @cogitator-ai/mcp@19.5.23
  - @cogitator-ai/memory@0.25.1
  - @cogitator-ai/studio@0.3.15

## 0.8.26

### Patch Changes

- Updated dependencies [[`e979cea`](https://github.com/cogitator-ai/Cogitator-AI/commit/e979cea3c2031e03c03adcf34eba97c1a8c8c698)]:
  - @cogitator-ai/core@0.59.0
  - @cogitator-ai/types@0.64.0
  - @cogitator-ai/memory@0.25.0
  - @cogitator-ai/channels@0.15.12
  - @cogitator-ai/mcp@19.5.22
  - @cogitator-ai/studio@0.3.14
  - @cogitator-ai/config@0.24.2
  - @cogitator-ai/deploy@0.6.28

## 0.8.25

### Patch Changes

- Updated dependencies [[`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357), [`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357)]:
  - @cogitator-ai/core@0.58.0
  - @cogitator-ai/types@0.63.0
  - @cogitator-ai/channels@0.15.11
  - @cogitator-ai/mcp@19.5.21
  - @cogitator-ai/studio@0.3.13
  - @cogitator-ai/config@0.24.1
  - @cogitator-ai/deploy@0.6.27
  - @cogitator-ai/memory@0.24.5

## 0.8.24

### Patch Changes

- Updated dependencies [[`d936a95`](https://github.com/cogitator-ai/Cogitator-AI/commit/d936a952fb233dcb22b961d421ac42ce03841d29)]:
  - @cogitator-ai/channels@0.15.10

## 0.8.23

### Patch Changes

- Updated dependencies [[`2d00dd2`](https://github.com/cogitator-ai/Cogitator-AI/commit/2d00dd2dda98ab9aa59c1c7d38ad96b652d7979f)]:
  - @cogitator-ai/types@0.62.0
  - @cogitator-ai/config@0.24.0
  - @cogitator-ai/core@0.57.0
  - @cogitator-ai/channels@0.15.9
  - @cogitator-ai/deploy@0.6.26
  - @cogitator-ai/mcp@19.5.20
  - @cogitator-ai/memory@0.24.4
  - @cogitator-ai/studio@0.3.12
  - create-cogitator-app@0.8.13

## 0.8.22

### Patch Changes

- Updated dependencies [[`afb3815`](https://github.com/cogitator-ai/Cogitator-AI/commit/afb3815d149086f411063b6a0cf2beaa299adcdc)]:
  - @cogitator-ai/memory@0.24.3
  - @cogitator-ai/channels@0.15.8
  - @cogitator-ai/core@0.56.4
  - @cogitator-ai/studio@0.3.11
  - @cogitator-ai/mcp@19.5.19

## 0.8.21

### Patch Changes

- Updated dependencies [[`a11b786`](https://github.com/cogitator-ai/Cogitator-AI/commit/a11b78613707a9092d7f0c49ed6982f239368e34)]:
  - @cogitator-ai/types@0.61.0
  - @cogitator-ai/channels@0.15.7
  - @cogitator-ai/config@0.23.4
  - @cogitator-ai/core@0.56.3
  - @cogitator-ai/deploy@0.6.25
  - @cogitator-ai/mcp@19.5.18
  - @cogitator-ai/memory@0.24.2
  - @cogitator-ai/studio@0.3.10

## 0.8.20

### Patch Changes

- Updated dependencies [[`3f81cdb`](https://github.com/cogitator-ai/Cogitator-AI/commit/3f81cdb928c80f4c70548911d4e6fd07cf2b1e52)]:
  - @cogitator-ai/types@0.60.0
  - @cogitator-ai/studio@0.3.9
  - @cogitator-ai/channels@0.15.6
  - @cogitator-ai/config@0.23.3
  - @cogitator-ai/core@0.56.2
  - @cogitator-ai/deploy@0.6.24
  - @cogitator-ai/mcp@19.5.17
  - @cogitator-ai/memory@0.24.1

## 0.8.19

### Patch Changes

- Updated dependencies [[`e205fef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e205fefeeabd060cf84e5a4b125c4c64e42d57c3)]:
  - @cogitator-ai/types@0.59.0
  - @cogitator-ai/memory@0.24.0
  - @cogitator-ai/channels@0.15.5
  - @cogitator-ai/config@0.23.2
  - @cogitator-ai/core@0.56.1
  - @cogitator-ai/deploy@0.6.23
  - @cogitator-ai/mcp@19.5.16
  - @cogitator-ai/studio@0.3.8

## 0.8.18

### Patch Changes

- Updated dependencies [[`a99a45a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a99a45a28af69326c4fc5e5453ccf188db85f682)]:
  - @cogitator-ai/types@0.58.0
  - @cogitator-ai/memory@0.23.0
  - @cogitator-ai/core@0.56.0
  - @cogitator-ai/channels@0.15.4
  - @cogitator-ai/config@0.23.1
  - @cogitator-ai/deploy@0.6.22
  - @cogitator-ai/mcp@19.5.15
  - @cogitator-ai/studio@0.3.7

## 0.8.17

### Patch Changes

- Updated dependencies [[`dedb431`](https://github.com/cogitator-ai/Cogitator-AI/commit/dedb4311ba307f4023d32c4e1391a4b166a58b76)]:
  - @cogitator-ai/types@0.57.0
  - @cogitator-ai/memory@0.22.0
  - @cogitator-ai/core@0.55.0
  - @cogitator-ai/config@0.23.0
  - @cogitator-ai/channels@0.15.3
  - @cogitator-ai/deploy@0.6.21
  - @cogitator-ai/mcp@19.5.14
  - @cogitator-ai/studio@0.3.6
  - create-cogitator-app@0.8.12

## 0.8.16

### Patch Changes

- Updated dependencies [[`855d1bc`](https://github.com/cogitator-ai/Cogitator-AI/commit/855d1bc54282a487a4770e233091040831f05627)]:
  - @cogitator-ai/types@0.56.0
  - @cogitator-ai/memory@0.21.0
  - @cogitator-ai/core@0.54.0
  - @cogitator-ai/config@0.22.0
  - @cogitator-ai/channels@0.15.2
  - @cogitator-ai/deploy@0.6.20
  - @cogitator-ai/mcp@19.5.13
  - @cogitator-ai/studio@0.3.5
  - create-cogitator-app@0.8.11

## 0.8.15

### Patch Changes

- Updated dependencies [[`d9caa65`](https://github.com/cogitator-ai/Cogitator-AI/commit/d9caa654df5b716feee2b66d46e3b8b717949c51), [`e83c1ef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e83c1efd7788d1df6b78e818599210e2b99153a7)]:
  - @cogitator-ai/types@0.55.0
  - @cogitator-ai/memory@0.20.0
  - @cogitator-ai/core@0.53.0
  - @cogitator-ai/config@0.21.0
  - @cogitator-ai/channels@0.15.1
  - @cogitator-ai/deploy@0.6.19
  - @cogitator-ai/mcp@19.5.12
  - @cogitator-ai/studio@0.3.4
  - create-cogitator-app@0.8.10

## 0.8.14

### Patch Changes

- Updated dependencies [[`c29c8a0`](https://github.com/cogitator-ai/Cogitator-AI/commit/c29c8a00c9fce4a22af1c697246f065045a2f014)]:
  - @cogitator-ai/types@0.54.0
  - @cogitator-ai/memory@0.19.0
  - @cogitator-ai/core@0.52.0
  - @cogitator-ai/config@0.20.0
  - @cogitator-ai/channels@0.15.0
  - @cogitator-ai/deploy@0.6.18
  - @cogitator-ai/mcp@19.5.11
  - @cogitator-ai/studio@0.3.3
  - create-cogitator-app@0.8.9

## 0.8.13

### Patch Changes

- Updated dependencies [[`99ceb01`](https://github.com/cogitator-ai/Cogitator-AI/commit/99ceb0107f7403fba0a95e31fd2d10b743144a03)]:
  - @cogitator-ai/types@0.53.0
  - @cogitator-ai/memory@0.18.0
  - @cogitator-ai/core@0.51.0
  - @cogitator-ai/channels@0.14.0
  - @cogitator-ai/config@0.19.0
  - @cogitator-ai/deploy@0.6.17
  - @cogitator-ai/mcp@19.5.10
  - @cogitator-ai/studio@0.3.2
  - create-cogitator-app@0.8.8

## 0.8.12

### Patch Changes

- Updated dependencies [[`85d05b2`](https://github.com/cogitator-ai/Cogitator-AI/commit/85d05b20fe48738ee6ddcea83a043bb890b6d077)]:
  - @cogitator-ai/types@0.52.0
  - @cogitator-ai/memory@0.17.0
  - @cogitator-ai/core@0.50.0
  - @cogitator-ai/channels@0.13.0
  - @cogitator-ai/config@0.18.0
  - @cogitator-ai/deploy@0.6.16
  - @cogitator-ai/mcp@19.5.9
  - @cogitator-ai/studio@0.3.1
  - create-cogitator-app@0.8.7

## 0.8.11

### Patch Changes

- Updated dependencies [[`c46adb9`](https://github.com/cogitator-ai/Cogitator-AI/commit/c46adb9429ef9686697a020d4d97634c907117d0)]:
  - @cogitator-ai/types@0.51.0
  - @cogitator-ai/memory@0.16.0
  - @cogitator-ai/core@0.49.0
  - @cogitator-ai/studio@0.3.0
  - @cogitator-ai/channels@0.12.7
  - @cogitator-ai/config@0.17.6
  - @cogitator-ai/deploy@0.6.15
  - @cogitator-ai/mcp@19.5.8

## 0.8.10

### Patch Changes

- Updated dependencies [[`92bcc11`](https://github.com/cogitator-ai/Cogitator-AI/commit/92bcc119e71742eaf2a4a3bffdeceaa18b153e5d)]:
  - @cogitator-ai/types@0.50.0
  - @cogitator-ai/memory@0.15.0
  - @cogitator-ai/core@0.48.0
  - @cogitator-ai/channels@0.12.6
  - @cogitator-ai/config@0.17.5
  - @cogitator-ai/deploy@0.6.14
  - @cogitator-ai/mcp@19.5.7
  - @cogitator-ai/studio@0.2.2

## 0.8.9

### Patch Changes

- Updated dependencies [[`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913), [`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913), [`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913)]:
  - @cogitator-ai/types@0.49.0
  - @cogitator-ai/memory@0.14.0
  - @cogitator-ai/core@0.47.0
  - create-cogitator-app@0.8.6
  - @cogitator-ai/channels@0.12.5
  - @cogitator-ai/config@0.17.4
  - @cogitator-ai/deploy@0.6.13
  - @cogitator-ai/mcp@19.5.6
  - @cogitator-ai/studio@0.2.1

## 0.8.8

### Patch Changes

- Updated dependencies [[`b42f62e`](https://github.com/cogitator-ai/Cogitator-AI/commit/b42f62ecd300cd945c42a91014b1297bc4e10c43)]:
  - @cogitator-ai/core@0.46.0
  - @cogitator-ai/types@0.48.0
  - @cogitator-ai/studio@0.2.0
  - @cogitator-ai/channels@0.12.4
  - @cogitator-ai/mcp@19.5.5
  - @cogitator-ai/config@0.17.3
  - @cogitator-ai/deploy@0.6.12
  - @cogitator-ai/memory@0.13.3

## 0.8.7

### Patch Changes

- Updated dependencies [[`ed48837`](https://github.com/cogitator-ai/Cogitator-AI/commit/ed4883796a82b5f2b832a5bb45ba861fb0b17f45)]:
  - @cogitator-ai/core@0.45.0
  - @cogitator-ai/types@0.47.0
  - @cogitator-ai/channels@0.12.3
  - @cogitator-ai/mcp@19.5.4
  - @cogitator-ai/studio@0.1.12
  - @cogitator-ai/config@0.17.2
  - @cogitator-ai/deploy@0.6.11
  - @cogitator-ai/memory@0.13.2

## 0.8.6

### Patch Changes

- Updated dependencies [[`f68ebd8`](https://github.com/cogitator-ai/Cogitator-AI/commit/f68ebd892ee493279058212105381e8acb73b70e)]:
  - @cogitator-ai/core@0.44.0
  - @cogitator-ai/types@0.46.0
  - @cogitator-ai/channels@0.12.2
  - @cogitator-ai/mcp@19.5.3
  - @cogitator-ai/studio@0.1.11
  - @cogitator-ai/config@0.17.1
  - @cogitator-ai/deploy@0.6.10
  - @cogitator-ai/memory@0.13.1

## 0.8.5

### Patch Changes

- Updated dependencies [[`f903fc1`](https://github.com/cogitator-ai/Cogitator-AI/commit/f903fc15fca7e29f5187f1fc60e099a8a9b28a03), [`f903fc1`](https://github.com/cogitator-ai/Cogitator-AI/commit/f903fc15fca7e29f5187f1fc60e099a8a9b28a03)]:
  - @cogitator-ai/mcp@19.5.2
  - create-cogitator-app@0.8.5

## 0.8.4

### Patch Changes

- Updated dependencies [[`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b)]:
  - @cogitator-ai/memory@0.13.0
  - @cogitator-ai/core@0.43.0
  - @cogitator-ai/types@0.45.0
  - @cogitator-ai/config@0.17.0
  - @cogitator-ai/channels@0.12.1
  - @cogitator-ai/studio@0.1.10
  - @cogitator-ai/mcp@19.5.1
  - @cogitator-ai/deploy@0.6.9
  - create-cogitator-app@0.8.4

## 0.8.3

### Patch Changes

- Updated dependencies [[`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22), [`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22), [`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22)]:
  - @cogitator-ai/channels@0.12.0
  - @cogitator-ai/types@0.44.0
  - @cogitator-ai/core@0.42.0
  - @cogitator-ai/mcp@19.5.0
  - create-cogitator-app@0.8.3
  - @cogitator-ai/config@0.16.1
  - @cogitator-ai/deploy@0.6.8
  - @cogitator-ai/memory@0.12.9
  - @cogitator-ai/studio@0.1.9

## 0.8.2

### Patch Changes

- Updated dependencies [[`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765)]:
  - @cogitator-ai/core@0.41.0
  - @cogitator-ai/mcp@19.4.0
  - @cogitator-ai/types@0.43.0
  - @cogitator-ai/config@0.16.0
  - create-cogitator-app@0.8.2
  - @cogitator-ai/channels@0.11.4
  - @cogitator-ai/studio@0.1.8
  - @cogitator-ai/deploy@0.6.7
  - @cogitator-ai/memory@0.12.8

## 0.8.1

### Patch Changes

- Updated dependencies [[`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd)]:
  - @cogitator-ai/types@0.42.0
  - @cogitator-ai/config@0.15.0
  - @cogitator-ai/models@18.5.0
  - @cogitator-ai/core@0.40.0
  - @cogitator-ai/channels@0.11.3
  - @cogitator-ai/deploy@0.6.6
  - @cogitator-ai/mcp@19.3.7
  - @cogitator-ai/memory@0.12.7
  - @cogitator-ai/studio@0.1.7
  - create-cogitator-app@0.8.1

## 0.8.0

### Minor Changes

- [#201](https://github.com/cogitator-ai/Cogitator-AI/pull/201) [`f3a8929`](https://github.com/cogitator-ai/Cogitator-AI/commit/f3a892913c8d532095c3cd3b3065561e9549dd9f) - The scaffolder offers to start the project's compose services once the project is created. When the stack has Postgres, Redis, MongoDB, Qdrant, Jaeger or the Ollama container and Docker is running, it asks whether to run `docker compose up --wait` and waits until they are healthy, so the first `dev` finds its database. The Ollama container pulls the model in the background, and the next steps point at `docker compose logs -f ollama-pull` instead of `ollama pull`. An Ollama that already answers at `OLLAMA_BASE_URL` is left alone and the compose one is not started, since it could not take the port. Nothing starts with `--yes`, `--json`, without a TTY, in CI or in a dry run. `cogitator init` makes the same offer and leaves the compose Postgres out when you give a database URL of your own.

  `startServices`, `dockerComposeAvailable`, `servicesToStart`, `offerServices` and `isInteractive` are exported. `offerServices` asks at the terminal, so programmatic callers check `isInteractive` first. `ProjectPlan.oneShotServices` names the services that run a task and exit.

  `resolveOllamaUrl` now answers with the Ollama the generated project talks to: `OLLAMA_BASE_URL`, which its `cogitator.yml` reads, else `http://localhost:11434`. It no longer reads `OLLAMA_HOST`, the address the Ollama server listens on, which the project ignores. With the common `OLLAMA_HOST=0.0.0.0` the scaffolder used to look for Ollama on port 80 and report a running one as missing.

### Patch Changes

- [#201](https://github.com/cogitator-ai/Cogitator-AI/pull/201) [`f3a8929`](https://github.com/cogitator-ai/Cogitator-AI/commit/f3a892913c8d532095c3cd3b3065561e9549dd9f) - Projects created for Yarn 2 and later work out of the box, from create-cogitator-app, `--example` and `cogitator init` alike. They get a `.yarnrc.yml` with `nodeLinker: node-modules`, because tsx, vitest and Cogitator Studio could not find their packages under Plug'n'Play, Yarn's default, and the `.gitignore` entries Yarn recommends for `.yarn/`. Projects pinned to Yarn 1 get no `.yarnrc.yml`, Yarn 1 never reads it. Generated projects also declare `vite`, which vitest needs as a peer and which Yarn, unlike npm, pnpm and Bun, does not install by itself, so `yarn test` failed. The first install no longer fails under CI with Yarn 4, which refused to write the lockfile there (`YN0028`).

  To fix a Yarn project created earlier, add a `.yarnrc.yml` with `nodeLinker: node-modules`, run `yarn add -D vite` and install again.

- Updated dependencies [[`f3a8929`](https://github.com/cogitator-ai/Cogitator-AI/commit/f3a892913c8d532095c3cd3b3065561e9549dd9f), [`f3a8929`](https://github.com/cogitator-ai/Cogitator-AI/commit/f3a892913c8d532095c3cd3b3065561e9549dd9f)]:
  - create-cogitator-app@0.8.0

## 0.7.4

### Patch Changes

- [#199](https://github.com/cogitator-ai/Cogitator-AI/pull/199) [`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a) - `cogitator build` bundles with its own esbuild, now a dependency of the CLI. It used to look for esbuild in the project and found it only when the package manager happened to hoist the copy that tsx brings along, so with pnpm's `hoist: false`, a globally installed CLI or a project without tsx it stopped with "esbuild is required". Projects can drop the `esbuild` dev dependency they added for it.
- Updated dependencies [[`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a)]:
  - @cogitator-ai/channels@0.11.2
  - @cogitator-ai/config@0.14.2
  - @cogitator-ai/core@0.39.1
  - @cogitator-ai/deploy@0.6.5
  - @cogitator-ai/mcp@19.3.6
  - @cogitator-ai/memory@0.12.6
  - @cogitator-ai/models@18.4.1
  - @cogitator-ai/studio@0.1.6
  - @cogitator-ai/types@0.41.1
  - create-cogitator-app@0.7.1

## 0.7.3

### Patch Changes

- Updated dependencies [[`6481bdf`](https://github.com/cogitator-ai/Cogitator-AI/commit/6481bdfc871d20fe3633392ce0ea2f0fd0e17052)]:
  - @cogitator-ai/channels@0.11.1

## 0.7.2

### Patch Changes

- Updated dependencies [[`9a31e38`](https://github.com/cogitator-ai/Cogitator-AI/commit/9a31e3897e0992061744bbcc5cf4075db2848b77), [`fba532a`](https://github.com/cogitator-ai/Cogitator-AI/commit/fba532a5fadc4d193f855c8aee0b44f48f9e0619)]:
  - @cogitator-ai/channels@0.11.0
  - @cogitator-ai/types@0.41.0
  - @cogitator-ai/core@0.39.0
  - @cogitator-ai/config@0.14.1
  - @cogitator-ai/deploy@0.6.4
  - @cogitator-ai/mcp@19.3.5
  - @cogitator-ai/memory@0.12.5
  - @cogitator-ai/studio@0.1.5

## 0.7.1

### Patch Changes

- Updated dependencies [[`d7f5fcf`](https://github.com/cogitator-ai/Cogitator-AI/commit/d7f5fcf044784ac278a12772ae1cd0acea708cea)]:
  - @cogitator-ai/channels@0.10.1

## 0.7.0

### Minor Changes

- [#155](https://github.com/cogitator-ai/Cogitator-AI/pull/155) [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292) - Bluesky and Threads channels in the scaffolder, `cogitator init` and `cogitator wizard`. A generated project keeps the Bluesky session and the Threads token in `.cogitator/tokens.json`, which is ignored by git, and `cogitator wizard --edit` keeps their settings.

### Patch Changes

- Updated dependencies [[`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292), [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292), [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292)]:
  - @cogitator-ai/core@0.38.0
  - @cogitator-ai/types@0.40.0
  - @cogitator-ai/models@18.4.0
  - @cogitator-ai/config@0.14.0
  - @cogitator-ai/studio@0.1.4
  - @cogitator-ai/channels@0.10.0
  - create-cogitator-app@0.7.0
  - @cogitator-ai/mcp@19.3.4
  - @cogitator-ai/deploy@0.6.3
  - @cogitator-ai/memory@0.12.4

## 0.6.5

### Patch Changes

- Updated dependencies [[`60e8e89`](https://github.com/cogitator-ai/Cogitator-AI/commit/60e8e8930d7d7645bbf8dfe7a6ebf20da9d004ea)]:
  - @cogitator-ai/studio@0.1.3

## 0.6.4

### Patch Changes

- [#151](https://github.com/cogitator-ai/Cogitator-AI/pull/151) [`90a5055`](https://github.com/cogitator-ai/Cogitator-AI/commit/90a50551e802a308655b46ad50547856f1e420cd) - The install runs with the package manager that launched the scaffolder, from the `npm_execpath` it sets, and falls back to the one on PATH. A pnpm started by its full path or as a standalone binary, which is not on PATH, failed the install with "pnpm is not installed". `cogitator add` installs the same way.
- Updated dependencies [[`90a5055`](https://github.com/cogitator-ai/Cogitator-AI/commit/90a50551e802a308655b46ad50547856f1e420cd), [`6ff6a3f`](https://github.com/cogitator-ai/Cogitator-AI/commit/6ff6a3f8a2b6a617bc04007ff46908e30c81cc2f), [`398426b`](https://github.com/cogitator-ai/Cogitator-AI/commit/398426b3fb620937e94535c3a66e18b1fb330b38)]:
  - create-cogitator-app@0.6.1

## 0.6.3

### Patch Changes

- [#150](https://github.com/cogitator-ai/Cogitator-AI/pull/150) [`73237de`](https://github.com/cogitator-ai/Cogitator-AI/commit/73237de96e86412051697491c8109a5887eb564a) - The telemetry event of a failed scaffold says where and why it failed. `failedStep` is `create` (the options, the directory, downloading or writing files) or `install`, and `errorCode` is the code it failed with: the package manager's own from a closed set of known codes (`ERR_PNPM_NO_MATCHING_VERSION`, npm's `ETARGET`, Yarn's `YN0035`, a code for the messages of Bun and Yarn 1, `ERR_PNPM_OTHER` or `NPM_OTHER` for any other, since install scripts print into the same output), a Node network or file system code (`ENOTFOUND`), or the scaffolder's (`DIRECTORY_NOT_EMPTY`, `HTTP_404`). Both are `none` on success. The event never holds the error message or the install output, which can contain paths and package names.

  An `--example` or `--template` whose install failed was counted as a success. It is a failure now, like a generated project.

  In the library, `payloadFor(spec, failure?, kind)` takes a `ScaffoldFailure` (`{ step, error }`) in place of the outcome, and `installFailure(result)` gives the one of a scaffold whose install failed. `telemetryErrorCode`, `installErrorCode` and `CodedError`, the error with a code the scaffolder throws, are exported too.

- Updated dependencies [[`73237de`](https://github.com/cogitator-ai/Cogitator-AI/commit/73237de96e86412051697491c8109a5887eb564a)]:
  - create-cogitator-app@0.6.0

## 0.6.2

### Patch Changes

- Updated dependencies [[`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e), [`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e)]:
  - @cogitator-ai/core@0.37.0
  - @cogitator-ai/types@0.39.0
  - @cogitator-ai/config@0.13.0
  - @cogitator-ai/channels@0.9.3
  - @cogitator-ai/mcp@19.3.3
  - @cogitator-ai/studio@0.1.2
  - @cogitator-ai/deploy@0.6.2
  - @cogitator-ai/memory@0.12.3

## 0.6.1

### Patch Changes

- Updated dependencies [[`d1a874c`](https://github.com/cogitator-ai/Cogitator-AI/commit/d1a874ce75b702eea77ca2a24945f383e8b63198)]:
  - @cogitator-ai/core@0.36.0
  - @cogitator-ai/types@0.38.0
  - @cogitator-ai/config@0.12.2
  - @cogitator-ai/channels@0.9.2
  - @cogitator-ai/mcp@19.3.2
  - @cogitator-ai/studio@0.1.1
  - @cogitator-ai/deploy@0.6.1
  - @cogitator-ai/memory@0.12.2

## 0.6.0

### Minor Changes

- [#139](https://github.com/cogitator-ai/Cogitator-AI/pull/139) [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa) - New commands: `cogitator add` grows a scaffolded project with rag, mcp, workflows, evals, memory, deploy and the rest, merging into files you changed and refusing with a diff when it cannot; `cogitator dev` opens Cogitator Studio; `cogitator mcp` serves the bundled docs and the project's registry to Claude Code, Cursor and Codex; `cogitator doctor` checks that a project can run; `cogitator eval` runs eval suites for CI. `cogitator init` generates the `channels` preset of create-cogitator-app. Every command now exits `0`, `1` or `2` (wrong command line), reports failures with hints on stderr (stack traces with `COGITATOR_DEBUG`), prints JSON with `--json` (now also on `models`, `status` and `deploy`), and ends its help with examples.

  `cogitator mcp --project <path>` serves another project, and `cogitator add` installs when an addition removes dependencies too, so the lockfile follows package.json. `cogitator doctor` finds packages installed with Yarn Plug'n'Play and packages hoisted to a parent node_modules.

  **Breaking:**

  - Errors and warnings go to stderr, and a wrong command line (unknown option, missing argument, invalid value) exits with `2` instead of `1`. Scripts that read errors from stdout or check for `1` need to follow.
  - `cogitator init` generates a different project: the agent moves from `src/agent.ts` to `src/agents/assistant.ts` and the registry `src/cogitator.ts`, and `src/index.ts` starts the gateway for `dev` and `start`. `src/gateway.ts` still exports `gateway`, so `cogitator assistant`, `build` and `daemon` work as before. Existing projects are not touched.

### Patch Changes

- Updated dependencies [[`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa)]:
  - @cogitator-ai/core@0.35.0
  - @cogitator-ai/deploy@0.6.0
  - create-cogitator-app@0.5.0
  - @cogitator-ai/memory@0.12.1
  - @cogitator-ai/channels@0.9.1
  - @cogitator-ai/studio@0.1.0
  - @cogitator-ai/types@0.37.0
  - @cogitator-ai/mcp@19.3.1
  - @cogitator-ai/config@0.12.1

## 0.5.20

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Projects from `cogitator init` deploy as they are. `init` writes a runtime `cogitator.yml` with the provider, model and memory, and a `deploy` section that runs the gateway as a worker, publishes the WebChat port and lists the API key and channel tokens as secrets, so `cogitator deploy` no longer ships a container without them that restarts forever. The SQLite memory directory is created at start (the first `pnpm dev` failed without it) and lives on a volume when deployed, and `package.json` pins the pnpm, Yarn or Bun version that ran `init` in `packageManager`.

  `cogitator deploy -c <file>` reads the model, memory and deploy section from that file instead of mixing it with the default one, finds `.cogitator.yml` like `loadConfig` does, and shows the project kind, volumes and which services Fly does not provision.

  `cogitator run` loads the `.env` next to the config file, and with an assistant config from `cogitator wizard` runs its `llm.provider` and `llm.model` instead of silently falling back to a local Ollama model.

  `cogitator build` bundles only the project's own code and leaves every package to `node_modules`, so a project with the Docker sandbox (whose `ssh2` dependency ships a native addon) or optional media dependencies builds again.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `CompactionConfig.threshold` means tokens everywhere. The Gateway compared it with the number of messages while `CompactionService` compared it with tokens, so `threshold: 8000` from the memory docs waited for 8000 messages in a channel. The new `messageThreshold` counts messages, and a thread is compacted once either limit is reached (`threshold` is now optional, at least one is required). Gateway configs that meant messages should switch to `messageThreshold`. The `memory.compaction.threshold` of an assistant YAML config still counts messages, and `cogitator init` generates `messageThreshold`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Installing `@cogitator-ai/core` or `@cogitator-ai/memory` no longer installs every database driver. They were optional dependencies, so each install pulled `mongodb`, `pg`, `ioredis`, `@qdrant/js-client-rest` and a native build of `better-sqlite3` (about 141 MB in a basic project) and bundlers warned about them. They are now optional peer dependencies: install the driver of the store you use. A missing driver fails `connect()` with the command to install it (`PostgresAdapter`, `SQLiteGraphAdapter` and `PostgresTraceStore` now say so too). The CLI, whose assistant always keeps memory in SQLite, depends on `better-sqlite3` itself, `@cogitator-ai/channels` lists it as an optional peer, and the memory template of `create-cogitator-app` adds `ioredis`.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `OLLAMA_HOST`, `OLLAMA_URL` and the new `OLLAMA_BASE_URL` are read the way Ollama reads `OLLAMA_HOST`. `OLLAMA_HOST=0.0.0.0`, set so `ollama serve` listens on every interface, used to send every call to port 80 and fail with `ECONNREFUSED`. Now a value without a scheme gets port 11434 and a wildcard address is reached as `localhost`, in `loadConfig` and in the CLI alike (`resolveOllamaHost()`). These variables also no longer replace an explicit `llm.providers.ollama.baseUrl` from cogitator.yml, they apply only when the file sets none (`loadEnvDefaults()`), while `COGITATOR_OLLAMA_BASE_URL` still overrides it. `loadEnvConfig()` therefore no longer returns them.

  `loadConfig` looks for `cogitator.yml`, `cogitator.yaml`, `.cogitator.yml` and `.cogitator.yaml` in that order, the same order `cogitator run` and `cogitator deploy` use (`findConfigFile()`).

- Updated dependencies [[`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281)]:
  - @cogitator-ai/core@0.34.0
  - @cogitator-ai/types@0.36.0
  - @cogitator-ai/models@18.3.0
  - @cogitator-ai/config@0.12.0
  - @cogitator-ai/channels@0.9.0
  - @cogitator-ai/memory@0.12.0
  - @cogitator-ai/deploy@0.5.0

## 0.5.19

### Patch Changes

- Updated dependencies [[`151d675`](https://github.com/cogitator-ai/Cogitator-AI/commit/151d6758803e4f01f79bb1546784010aa702493e)]:
  - @cogitator-ai/core@0.33.0
  - @cogitator-ai/types@0.35.0
  - @cogitator-ai/channels@0.8.6
  - @cogitator-ai/config@0.11.8
  - @cogitator-ai/deploy@0.4.8
  - @cogitator-ai/memory@0.11.8

## 0.5.18

### Patch Changes

- Updated dependencies [[`3750d25`](https://github.com/cogitator-ai/Cogitator-AI/commit/3750d2597c58c2aa7654a1d842f28489d29dc774)]:
  - @cogitator-ai/types@0.34.0
  - @cogitator-ai/core@0.32.0
  - @cogitator-ai/channels@0.8.5
  - @cogitator-ai/config@0.11.7
  - @cogitator-ai/deploy@0.4.7
  - @cogitator-ai/memory@0.11.7

## 0.5.17

### Patch Changes

- Updated dependencies [[`561f0be`](https://github.com/cogitator-ai/Cogitator-AI/commit/561f0beb7c33c9f1fb214c2bc205a5f2f9347af2), [`51338f4`](https://github.com/cogitator-ai/Cogitator-AI/commit/51338f448b0a6310ecf47b1e0ba63e7d9fffd006)]:
  - @cogitator-ai/core@0.31.0
  - @cogitator-ai/types@0.33.2
  - @cogitator-ai/channels@0.8.4
  - @cogitator-ai/config@0.11.6
  - @cogitator-ai/deploy@0.4.6
  - @cogitator-ai/memory@0.11.6

## 0.5.16

### Patch Changes

- Updated dependencies [[`f52311d`](https://github.com/cogitator-ai/Cogitator-AI/commit/f52311d225c550419398e4978cb480231f9a4e1b)]:
  - @cogitator-ai/core@0.30.4
  - @cogitator-ai/channels@0.8.3

## 0.5.15

### Patch Changes

- Updated dependencies [[`7bffbeb`](https://github.com/cogitator-ai/Cogitator-AI/commit/7bffbeb32394ea52a5662eac5fd104e8e76ed32a)]:
  - @cogitator-ai/core@0.30.3
  - @cogitator-ai/channels@0.8.2

## 0.5.14

### Patch Changes

- [#117](https://github.com/cogitator-ai/Cogitator-AI/pull/117) [`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b) - npm keywords for every package, so a search for what a package does finds it, and packages are now published with provenance: npm shows that each version was built and signed by the repository's release workflow, from which commit.
- Updated dependencies [[`0caa714`](https://github.com/cogitator-ai/Cogitator-AI/commit/0caa714e0d52b0effb983f63c5edca499a22235b)]:
  - @cogitator-ai/channels@0.8.1
  - @cogitator-ai/config@0.11.5
  - @cogitator-ai/core@0.30.2
  - @cogitator-ai/deploy@0.4.5
  - @cogitator-ai/memory@0.11.5
  - @cogitator-ai/models@18.2.1
  - @cogitator-ai/types@0.33.1

## 0.5.13

### Patch Changes

- Updated dependencies [[`7886808`](https://github.com/cogitator-ai/Cogitator-AI/commit/7886808f11282b2d3a0c6820ba593417865f9139)]:
  - @cogitator-ai/channels@0.8.0
  - @cogitator-ai/types@0.33.0
  - @cogitator-ai/config@0.11.4
  - @cogitator-ai/core@0.30.1
  - @cogitator-ai/deploy@0.4.4
  - @cogitator-ai/memory@0.11.4

## 0.5.12

### Patch Changes

- Updated dependencies [[`77087fc`](https://github.com/cogitator-ai/Cogitator-AI/commit/77087fc85bc28235ec36bf39b90da8bc138d0e80)]:
  - @cogitator-ai/core@0.30.0
  - @cogitator-ai/types@0.32.0
  - @cogitator-ai/channels@0.7.6
  - @cogitator-ai/config@0.11.3
  - @cogitator-ai/deploy@0.4.3
  - @cogitator-ai/memory@0.11.3

## 0.5.11

### Patch Changes

- Updated dependencies [[`f9bada3`](https://github.com/cogitator-ai/Cogitator-AI/commit/f9bada3e466b559f22c5906cf9639e00151b6cb8)]:
  - @cogitator-ai/core@0.29.0
  - @cogitator-ai/channels@0.7.5

## 0.5.10

### Patch Changes

- Updated dependencies [[`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406), [`a74da9a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a74da9aa11d338175c7a929fedb98d887e078406)]:
  - @cogitator-ai/core@0.28.0
  - @cogitator-ai/config@0.11.2
  - @cogitator-ai/deploy@0.4.2
  - @cogitator-ai/memory@0.11.2
  - @cogitator-ai/types@0.31.0
  - @cogitator-ai/channels@0.7.4

## 0.5.9

### Patch Changes

- Updated dependencies [[`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`13f8ca5`](https://github.com/cogitator-ai/Cogitator-AI/commit/13f8ca50083debbadeebbc2e30e4432c3234b0fe), [`26745cd`](https://github.com/cogitator-ai/Cogitator-AI/commit/26745cdeb375bd6193e782b4a6f72d649da1e1d9), [`9c8ca91`](https://github.com/cogitator-ai/Cogitator-AI/commit/9c8ca914282662b93d0a42f5913c2dde8064eb57), [`a208f5f`](https://github.com/cogitator-ai/Cogitator-AI/commit/a208f5f123b6ba86e58223829fd8435ba766c5e9), [`65786f6`](https://github.com/cogitator-ai/Cogitator-AI/commit/65786f66fc66bac3ee0997c7a467546b403e07c7), [`69ff26f`](https://github.com/cogitator-ai/Cogitator-AI/commit/69ff26fff42fe23e5be9ec3eef483837f304aac6), [`f6f8c58`](https://github.com/cogitator-ai/Cogitator-AI/commit/f6f8c58a837be665febfb99d2b670e913df2ff36), [`5caa2aa`](https://github.com/cogitator-ai/Cogitator-AI/commit/5caa2aa17e737fb7c5fcd56f3acab57744af7217), [`8a386b3`](https://github.com/cogitator-ai/Cogitator-AI/commit/8a386b3fb79bf12a89db0ae72b66216b0a828bc7), [`063ee72`](https://github.com/cogitator-ai/Cogitator-AI/commit/063ee7289ebb670da69951b93843652bbf0465b2)]:
  - @cogitator-ai/core@0.27.0
  - @cogitator-ai/deploy@0.4.1
  - @cogitator-ai/memory@0.11.1
  - @cogitator-ai/models@18.2.0
  - @cogitator-ai/types@0.30.0
  - @cogitator-ai/channels@0.7.3
  - @cogitator-ai/config@0.11.1

## 0.5.8

### Patch Changes

- Updated dependencies [[`de07e80`](https://github.com/cogitator-ai/Cogitator-AI/commit/de07e80fd5a1b4b066dc1d4e8710716a53959d41)]:
  - @cogitator-ai/core@0.26.2
  - @cogitator-ai/channels@0.7.2

## 0.5.7

### Patch Changes

- Updated dependencies [9a7b6f4]
  - @cogitator-ai/core@0.26.1
  - @cogitator-ai/channels@0.7.1

## 0.5.6

### Patch Changes

- d626dfb: Fix `cogitator up` and `cogitator wizard --edit`:

  - `up` loads `.env` into `process.env` (without overriding variables already set), so tools that read it, such as `web_search` and `github_api`, see keys written by the wizard.
  - `up` supervises the assistant for restarts even without `selfConfig`, so the owner `/restart` command (exit code 78) restarts it instead of stopping it.
  - `wizard --edit` keeps a postgres memory config and the WhatsApp/WebChat channels instead of overwriting them.

- cee7c73: The `cogitator up` startup summary listed every configured channel, including ones skipped because their token (e.g. `WEBCHAT_TOKEN`) is missing. It now lists the channels the gateway actually runs, and warns when none are running.
- cee7c73: `cogitator up` treated every `./cogitator.yml` as an assistant config, so in a project from create-cogitator-app (whose `cogitator.yml` is an `@cogitator-ai/config` runtime config) it failed with assistant validation errors. A runtime config is now recognised: `up` starts the project's Docker Compose services, or explains what the file is when there are none, and `cogitator daemon` no longer picks it as the entry to run.
- Updated dependencies [9175c69]
- Updated dependencies [e70e482]
- Updated dependencies [8963e1e]
- Updated dependencies [1df914a]
- Updated dependencies [f43f6af]
- Updated dependencies [8d520c0]
- Updated dependencies [a3c2ee1]
- Updated dependencies [8bcf914]
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
- Updated dependencies [0736823]
- Updated dependencies [7d6952d]
- Updated dependencies [0736823]
- Updated dependencies [0736823]
- Updated dependencies [bb17767]
- Updated dependencies [b8c9eca]
- Updated dependencies [9175c69]
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
  - @cogitator-ai/channels@0.7.0
  - @cogitator-ai/memory@0.11.0
  - @cogitator-ai/config@0.11.0
  - @cogitator-ai/deploy@0.4.0

## 0.5.5

### Patch Changes

- Updated dependencies [e211b6a]
- Updated dependencies [333e4ad]
- Updated dependencies [0ef09fc]
- Updated dependencies [6b16db1]
- Updated dependencies [1368ff8]
- Updated dependencies [452a248]
- Updated dependencies [57ac053]
- Updated dependencies [7482f93]
- Updated dependencies [b8c7c3d]
- Updated dependencies [e561607]
- Updated dependencies [35701f9]
  - @cogitator-ai/core@0.25.0
  - @cogitator-ai/memory@0.10.0
  - @cogitator-ai/types@0.28.0
  - @cogitator-ai/channels@0.6.1
  - @cogitator-ai/config@0.10.1
  - @cogitator-ai/deploy@0.3.4

## 0.5.4

### Patch Changes

- Updated dependencies [a7cb81b]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [0933009]
- Updated dependencies [7bee3ef]
- Updated dependencies [7bee3ef]
- Updated dependencies [4964fb6]
  - @cogitator-ai/core@0.24.0
  - @cogitator-ai/models@18.1.0
  - @cogitator-ai/types@0.27.0
  - @cogitator-ai/config@0.10.0
  - @cogitator-ai/channels@0.6.0
  - @cogitator-ai/deploy@0.3.3
  - @cogitator-ai/memory@0.9.1

## 0.5.3

### Patch Changes

- Updated dependencies [9ff5a06]
- Updated dependencies [ed996c4]
  - @cogitator-ai/types@0.26.0
  - @cogitator-ai/core@0.23.0
  - @cogitator-ai/config@0.9.0
  - @cogitator-ai/memory@0.9.0
  - @cogitator-ai/channels@0.5.1
  - @cogitator-ai/deploy@0.3.2

## 0.5.2

### Patch Changes

- 9eae101: Slack: answer @mentions in channels. The adapter only listened to `message` events, so a mention delivered as `app_mention` (the documented subscription) was dropped. Mentions are now handled, the `<@bot>` token is stripped from the text, a message that arrives both as `message` and `app_mention` is handled once, and the new `mentionOnly` option ignores channel messages that do not mention the bot. `RuntimeBuilder` now passes `SLACK_APP_TOKEN` (Socket Mode) and `SLACK_PORT`, and warns when Slack falls back to HTTP mode; `cogitator wizard` and `cogitator init` ask for the app token.
- Updated dependencies [480f2a3]
- Updated dependencies [c4a4252]
- Updated dependencies [f134b01]
- Updated dependencies [6404340]
- Updated dependencies [c1cd7a1]
- Updated dependencies [22f47c9]
- Updated dependencies [51d581e]
- Updated dependencies [9eae101]
- Updated dependencies [5b12191]
- Updated dependencies [f36a121]
  - @cogitator-ai/core@0.22.0
  - @cogitator-ai/types@0.25.0
  - @cogitator-ai/config@0.8.0
  - @cogitator-ai/channels@0.5.0
  - @cogitator-ai/deploy@0.3.1
  - @cogitator-ai/memory@0.8.1

## 0.5.1

### Patch Changes

- Updated dependencies [4940750]
  - @cogitator-ai/core@0.21.1
  - @cogitator-ai/channels@0.4.1

## 0.5.0

### Minor Changes

- `cogitator init` writes a `pnpm-workspace.yaml` that allows the native builds pnpm 10.26+/11 would otherwise refuse; generated projects require Node 22.12+ and `build` targets node22.
- Prompts (clack 1): pressing Enter on an empty field no longer saves the grey placeholder as the value. Extra positional arguments are now an error instead of being silently dropped (commander 15).
- Current model lists and Ollama defaults (`qwen3:8b`).
- **Breaking:** requires Node.js 22.12 or newer (Node 20 reached end of life).

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/channels@0.4.0
  - @cogitator-ai/config@0.7.0
  - @cogitator-ai/core@0.21.0
  - @cogitator-ai/deploy@0.3.0
  - @cogitator-ai/memory@0.8.0
  - @cogitator-ai/models@18.0.0
  - @cogitator-ai/types@0.24.0

## 0.4.0

### Minor Changes

- Several CLI flows did not work and are now fixed. init pinned @cogitator-ai/\* to ^0.1.0 (which resolves to 0.1.x), ignored the memory choice, never loaded .env, and suggested a `cogitator up` that fails. The daemon ran `node src/gateway.ts`, which never started anything; piped its logs through the exiting parent; could SIGKILL an unrelated process when a PID was reused; and installed a systemd unit with WantedBy=multi-user.target, which never starts in the user manager. build produced a bundle that did not start the gateway. up started HeartbeatScheduler twice (duplicate reminders) and did not forward SIGTERM to the restart child. models --pull reported Ollama errors as success and dropped NDJSON lines split across chunks. run ignored -c precedence and llm.defaultModel. skill create/remove allowed path traversal, so remove could rm -rf outside the skills dir. wizard --edit lost .env comments, MCP servers and other settings. Removed @ts-expect-error in favour of a type-guarded optional module loader. Removed the assistant 'pause' hotkey, which did nothing. All shell-string docker/launchctl calls now go through execFile. README, docs page, wizard docs and examples were rewritten.

  **Breaking changes**
  - `run`: an explicit -c now wins over COGITATOR_CONFIG, and a missing explicit or env config file is an error instead of a silent fallback.
  - `daemon start/restart/install`: -c no longer defaults to src/gateway.ts. The entry is auto-detected (dist/cogitator.mjs, then cogitator.yml, then src/gateway.ts). The PID file is now JSON (legacy plain PIDs are still read).
  - `daemon logs --json` was removed (it did nothing).
  - The `assistant` 'p' (pause) hotkey was removed (it did nothing).
  - `skill create` requires kebab-case names. Generated tool names are snake_case.
  - `up` without cogitator.yml and with no Docker running exits with 'No cogitator.yml or docker-compose.yml found' as before. `up` gained -c/--config, and --no-restart-loop is now a documented option.

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/channels@0.3.0
  - @cogitator-ai/config@0.6.0
  - @cogitator-ai/core@0.20.0
  - @cogitator-ai/deploy@0.2.0
  - @cogitator-ai/memory@0.7.0
  - @cogitator-ai/types@0.23.0

## 0.3.16

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.4
  - @cogitator-ai/memory@0.6.22
  - @cogitator-ai/types@0.22.3
  - @cogitator-ai/channels@0.2.5
  - @cogitator-ai/config@0.5.6
  - @cogitator-ai/deploy@0.1.9

## 0.3.15

### Patch Changes

- Republish packages with resolved internal dependency versions so npm installs do not receive workspace protocol dependencies.
- Updated dependencies
  - @cogitator-ai/channels@0.2.4
  - @cogitator-ai/config@0.5.5
  - @cogitator-ai/core@0.19.3
  - @cogitator-ai/deploy@0.1.8
  - @cogitator-ai/memory@0.6.21

## 0.3.14

### Patch Changes

- Updated dependencies
  - @cogitator-ai/deploy@0.1.7

## 0.3.13

### Patch Changes

- Updated dependencies
  - @cogitator-ai/channels@0.2.3
  - @cogitator-ai/config@0.5.4
  - @cogitator-ai/core@0.19.2
  - @cogitator-ai/models@17.1.8
  - @cogitator-ai/types@0.22.2
  - @cogitator-ai/deploy@0.1.6
  - @cogitator-ai/memory@0.6.20

## 0.3.12

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.19.1
  - @cogitator-ai/types@0.22.1
  - @cogitator-ai/channels@0.2.2
  - @cogitator-ai/config@0.5.3
  - @cogitator-ai/deploy@0.1.5
  - @cogitator-ai/memory@0.6.19

## 0.3.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.7

## 0.3.9

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.6

## 0.3.8

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.3
  - @cogitator-ai/core@0.18.5
  - @cogitator-ai/config@0.5.2
  - @cogitator-ai/deploy@0.1.4

## 0.3.7

### Patch Changes

- @cogitator-ai/core@0.18.4

## 0.3.6

### Patch Changes

- @cogitator-ai/core@0.18.3

## 0.3.5

### Patch Changes

- Updated dependencies
  - @cogitator-ai/types@0.21.1
  - @cogitator-ai/core@0.18.2
  - @cogitator-ai/config@0.5.1
  - @cogitator-ai/deploy@0.1.3

## 0.3.4

### Patch Changes

- Updated dependencies
  - @cogitator-ai/deploy@0.1.2

## 0.3.3

### Patch Changes

- fix(cli): exclude test files from compiled dist

## 0.3.2

### Patch Changes

- fix(cli): audit — 5 bugs & improvements
  - Fix: `loadConfig()` in `run.ts` now passes `configPath` for YAML config files (was ignoring user config)
  - Fix: `printBanner()` reads version from package.json dynamically (was hardcoded as v0.1.0)
  - Refactor: extract shared `findDockerCompose()` and `checkDocker()` to `utils/docker.ts`
  - Fix: parent dir traversal in `findDockerCompose()` now checks both `.yml` and `.yaml`
  - Add `vitest.config.ts` to restrict test discovery to `src/` only
  - Add 22 new unit tests covering `docker.ts`, `models.ts`, and `run.ts` utilities

## 0.3.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.18.1

## 0.3.0

### Minor Changes

- Add one-command deployment engine (`cogitator deploy`)
  - New deploy types: `DeployTarget`, `DeployConfig`, `DeployResult`, `DeployPlan`
  - Deploy section in `cogitator.yml` schema with target, port, region, instances, registry, services, secrets
  - CLI `deploy` command with `--target`, `--dry-run`, `--push`, `status`, and `destroy` subcommands

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @cogitator-ai/core@0.18.0
  - @cogitator-ai/types@0.20.0
  - @cogitator-ai/config@0.4.0
  - @cogitator-ai/deploy@0.1.1

## 0.2.25

### Patch Changes

- fix: update repository URLs for GitHub Packages linking
- Updated dependencies
  - @cogitator-ai/core@0.17.4
  - @cogitator-ai/config@0.3.13

## 0.2.24

### Patch Changes

- Configure GitHub Packages publishing
  - Add GitHub Packages registry configuration to all packages
  - Add integration tests for LLM backends (OpenAI, Anthropic, Google, Ollama)
  - Add comprehensive context-manager tests

- Updated dependencies
  - @cogitator-ai/core@0.17.3
  - @cogitator-ai/config@0.3.12

## 0.2.23

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.17.2

## 0.2.22

### Patch Changes

- @cogitator-ai/config@0.3.11
- @cogitator-ai/core@0.17.1

## 0.2.21

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.17.0
  - @cogitator-ai/config@0.3.10

## 0.2.20

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.16.0
  - @cogitator-ai/config@0.3.9

## 0.2.19

### Patch Changes

- Updated dependencies [6b09d54]
  - @cogitator-ai/core@0.15.0
  - @cogitator-ai/config@0.3.8

## 0.2.18

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.14.0
  - @cogitator-ai/config@0.3.7

## 0.2.17

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.13.0
  - @cogitator-ai/config@0.3.6

## 0.2.16

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.12.0
  - @cogitator-ai/config@0.3.5

## 0.2.15

### Patch Changes

- Updated dependencies
  - @cogitator-ai/config@0.3.4
  - @cogitator-ai/core@0.11.5

## 0.2.14

### Patch Changes

- @cogitator-ai/config@0.3.3
- @cogitator-ai/core@0.11.4

## 0.2.13

### Patch Changes

- @cogitator-ai/config@0.3.2
- @cogitator-ai/core@0.11.3

## 0.2.12

### Patch Changes

- @cogitator-ai/config@0.3.1
- @cogitator-ai/core@0.11.2

## 0.2.11

### Patch Changes

- @cogitator-ai/core@0.11.1

## 0.2.10

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.11.0
  - @cogitator-ai/config@0.3.0

## 0.2.9

### Patch Changes

- Updated dependencies [58a7271]
  - @cogitator-ai/core@0.10.0
  - @cogitator-ai/config@0.2.8

## 0.2.8

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.9.0
  - @cogitator-ai/config@0.2.7

## 0.2.7

### Patch Changes

- Updated dependencies [faed1e7]
  - @cogitator-ai/core@0.8.0
  - @cogitator-ai/config@0.2.6

## 0.2.6

### Patch Changes

- Updated dependencies [70679b8]
- Updated dependencies [2f599f0]
- Updated dependencies [10956ae]
- Updated dependencies [218d91f]
  - @cogitator-ai/core@0.7.0
  - @cogitator-ai/config@0.2.5

## 0.2.5

### Patch Changes

- Updated dependencies [29ce518]
  - @cogitator-ai/core@0.6.1

## 0.2.4

### Patch Changes

- Updated dependencies [a7c2b43]
  - @cogitator-ai/core@0.6.0
  - @cogitator-ai/config@0.2.4

## 0.2.3

### Patch Changes

- Updated dependencies [f874e69]
  - @cogitator-ai/core@0.5.0
  - @cogitator-ai/config@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.4.0
  - @cogitator-ai/config@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies
  - @cogitator-ai/core@0.3.0
  - @cogitator-ai/config@0.2.1

## 0.2.0

### Features

- **New command: `cogitator status`** - Show status of Docker services and Ollama
- **New command: `cogitator logs`** - View Docker service logs with follow mode
- **New command: `cogitator models`** - List and pull Ollama models
- **Environment variables**: `COGITATOR_MODEL` and `COGITATOR_CONFIG` support
- **Interactive mode improvements**:
  - `/model <name>` - Switch models mid-conversation
  - `/clear` - Reset conversation history
  - `/help` - Show available commands
  - Message counter in prompt

### Fixes

- Version now reads from package.json instead of hardcoded value
- Config loading errors are now logged as warnings instead of silently ignored

## 0.1.1

### Patch Changes

- @cogitator-ai/config@0.1.1
- @cogitator-ai/core@0.1.1

## 0.1.0

### Initial Release

- `cogitator init <name>` - Create new project with Docker setup
- `cogitator up` - Start Docker services (Redis, PostgreSQL, Ollama)
- `cogitator down` - Stop Docker services
- `cogitator run [message]` - Run agent with streaming support
