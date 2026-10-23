# @cogitator-ai/channels

## 0.18.4

### Patch Changes

- Updated dependencies [[`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b), [`a19a0d6`](https://github.com/cogitator-ai/Cogitator-AI/commit/a19a0d6c3d1dfd281e336dea6e5307b20af1a34b)]:
  - @cogitator-ai/memory@0.26.0
  - @cogitator-ai/core@0.62.0
  - @cogitator-ai/types@0.71.0
  - @cogitator-ai/rag@0.9.3
  - @cogitator-ai/browser@0.4.47
  - @cogitator-ai/mcp@19.5.29

## 0.18.3

### Patch Changes

- Updated dependencies [[`213e3fb`](https://github.com/cogitator-ai/Cogitator-AI/commit/213e3fba0f0ed9a1290fdd1499dd4a0e4101b6e2)]:
  - @cogitator-ai/types@0.70.0
  - @cogitator-ai/core@0.61.1
  - @cogitator-ai/browser@0.4.46
  - @cogitator-ai/mcp@19.5.28
  - @cogitator-ai/memory@0.25.6
  - @cogitator-ai/rag@0.9.2

## 0.18.2

### Patch Changes

- Updated dependencies [[`091fa9e`](https://github.com/cogitator-ai/Cogitator-AI/commit/091fa9e659341bc0f39344e46ec0c56ba0338f83)]:
  - @cogitator-ai/types@0.69.0
  - @cogitator-ai/core@0.61.0
  - @cogitator-ai/browser@0.4.45
  - @cogitator-ai/mcp@19.5.27
  - @cogitator-ai/memory@0.25.5
  - @cogitator-ai/rag@0.9.1

## 0.18.1

### Patch Changes

- Updated dependencies [[`8b099ce`](https://github.com/cogitator-ai/Cogitator-AI/commit/8b099ce06be7587aa7e350a0c3986eeb057c526e)]:
  - @cogitator-ai/types@0.68.0
  - @cogitator-ai/browser@0.4.44
  - @cogitator-ai/core@0.60.3
  - @cogitator-ai/mcp@19.5.26
  - @cogitator-ai/memory@0.25.4
  - @cogitator-ai/rag@0.8.18

## 0.18.0

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
  - @cogitator-ai/types@0.67.0
  - @cogitator-ai/browser@0.4.43
  - @cogitator-ai/core@0.60.2
  - @cogitator-ai/mcp@19.5.25
  - @cogitator-ai/memory@0.25.3
  - @cogitator-ai/rag@0.8.17

## 0.17.0

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
  - @cogitator-ai/types@0.66.0
  - @cogitator-ai/browser@0.4.42
  - @cogitator-ai/core@0.60.1
  - @cogitator-ai/mcp@19.5.24
  - @cogitator-ai/memory@0.25.2
  - @cogitator-ai/rag@0.8.16

## 0.16.0

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

### Patch Changes

- Updated dependencies [[`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899), [`c2abc6b`](https://github.com/cogitator-ai/Cogitator-AI/commit/c2abc6be10fb86aa696b324e3c170efd0e8f7899)]:
  - @cogitator-ai/types@0.65.0
  - @cogitator-ai/core@0.60.0
  - @cogitator-ai/browser@0.4.41
  - @cogitator-ai/mcp@19.5.23
  - @cogitator-ai/memory@0.25.1
  - @cogitator-ai/rag@0.8.15

## 0.15.12

### Patch Changes

- Updated dependencies [[`e979cea`](https://github.com/cogitator-ai/Cogitator-AI/commit/e979cea3c2031e03c03adcf34eba97c1a8c8c698)]:
  - @cogitator-ai/core@0.59.0
  - @cogitator-ai/types@0.64.0
  - @cogitator-ai/memory@0.25.0
  - @cogitator-ai/browser@0.4.40
  - @cogitator-ai/mcp@19.5.22
  - @cogitator-ai/rag@0.8.14

## 0.15.11

### Patch Changes

- Updated dependencies [[`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357), [`6cdb9e0`](https://github.com/cogitator-ai/Cogitator-AI/commit/6cdb9e049b6be5f2257cb52e84caaff1ff129357)]:
  - @cogitator-ai/core@0.58.0
  - @cogitator-ai/types@0.63.0
  - @cogitator-ai/browser@0.4.39
  - @cogitator-ai/mcp@19.5.21
  - @cogitator-ai/memory@0.24.5
  - @cogitator-ai/rag@0.8.13

## 0.15.10

### Patch Changes

- [#258](https://github.com/cogitator-ai/Cogitator-AI/pull/258) [`d936a95`](https://github.com/cogitator-ai/Cogitator-AI/commit/d936a952fb233dcb22b961d421ac42ce03841d29) Thanks [@bhushan4work](https://github.com/bhushan4work)! - Validate `codeLength` and `expiresIn` in `PairingMiddleware`, `pairingCodeLength` and `pairingExpiresMs` in `DmPolicyMiddleware`, and `maxPerMinute` in `RateLimitMiddleware` constructors to reject invalid and non-positive numbers immediately at middleware creation time.

## 0.15.9

### Patch Changes

- Updated dependencies [[`2d00dd2`](https://github.com/cogitator-ai/Cogitator-AI/commit/2d00dd2dda98ab9aa59c1c7d38ad96b652d7979f)]:
  - @cogitator-ai/types@0.62.0
  - @cogitator-ai/core@0.57.0
  - @cogitator-ai/browser@0.4.38
  - @cogitator-ai/mcp@19.5.20
  - @cogitator-ai/memory@0.24.4
  - @cogitator-ai/rag@0.8.12

## 0.15.8

### Patch Changes

- Updated dependencies [[`afb3815`](https://github.com/cogitator-ai/Cogitator-AI/commit/afb3815d149086f411063b6a0cf2beaa299adcdc)]:
  - @cogitator-ai/memory@0.24.3
  - @cogitator-ai/core@0.56.4
  - @cogitator-ai/rag@0.8.11
  - @cogitator-ai/browser@0.4.37
  - @cogitator-ai/mcp@19.5.19

## 0.15.7

### Patch Changes

- Updated dependencies [[`a11b786`](https://github.com/cogitator-ai/Cogitator-AI/commit/a11b78613707a9092d7f0c49ed6982f239368e34)]:
  - @cogitator-ai/types@0.61.0
  - @cogitator-ai/browser@0.4.36
  - @cogitator-ai/core@0.56.3
  - @cogitator-ai/mcp@19.5.18
  - @cogitator-ai/memory@0.24.2
  - @cogitator-ai/rag@0.8.11

## 0.15.6

### Patch Changes

- Updated dependencies [[`3f81cdb`](https://github.com/cogitator-ai/Cogitator-AI/commit/3f81cdb928c80f4c70548911d4e6fd07cf2b1e52)]:
  - @cogitator-ai/types@0.60.0
  - @cogitator-ai/browser@0.4.35
  - @cogitator-ai/core@0.56.2
  - @cogitator-ai/mcp@19.5.17
  - @cogitator-ai/memory@0.24.1
  - @cogitator-ai/rag@0.8.10

## 0.15.5

### Patch Changes

- Updated dependencies [[`e205fef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e205fefeeabd060cf84e5a4b125c4c64e42d57c3)]:
  - @cogitator-ai/types@0.59.0
  - @cogitator-ai/memory@0.24.0
  - @cogitator-ai/browser@0.4.34
  - @cogitator-ai/core@0.56.1
  - @cogitator-ai/mcp@19.5.16
  - @cogitator-ai/rag@0.8.9

## 0.15.4

### Patch Changes

- Updated dependencies [[`a99a45a`](https://github.com/cogitator-ai/Cogitator-AI/commit/a99a45a28af69326c4fc5e5453ccf188db85f682)]:
  - @cogitator-ai/types@0.58.0
  - @cogitator-ai/memory@0.23.0
  - @cogitator-ai/core@0.56.0
  - @cogitator-ai/browser@0.4.33
  - @cogitator-ai/mcp@19.5.15
  - @cogitator-ai/rag@0.8.8

## 0.15.3

### Patch Changes

- Updated dependencies [[`dedb431`](https://github.com/cogitator-ai/Cogitator-AI/commit/dedb4311ba307f4023d32c4e1391a4b166a58b76)]:
  - @cogitator-ai/types@0.57.0
  - @cogitator-ai/memory@0.22.0
  - @cogitator-ai/core@0.55.0
  - @cogitator-ai/browser@0.4.32
  - @cogitator-ai/mcp@19.5.14
  - @cogitator-ai/rag@0.8.7

## 0.15.2

### Patch Changes

- Updated dependencies [[`855d1bc`](https://github.com/cogitator-ai/Cogitator-AI/commit/855d1bc54282a487a4770e233091040831f05627)]:
  - @cogitator-ai/types@0.56.0
  - @cogitator-ai/memory@0.21.0
  - @cogitator-ai/core@0.54.0
  - @cogitator-ai/browser@0.4.31
  - @cogitator-ai/mcp@19.5.13
  - @cogitator-ai/rag@0.8.6

## 0.15.1

### Patch Changes

- Updated dependencies [[`d9caa65`](https://github.com/cogitator-ai/Cogitator-AI/commit/d9caa654df5b716feee2b66d46e3b8b717949c51), [`e83c1ef`](https://github.com/cogitator-ai/Cogitator-AI/commit/e83c1efd7788d1df6b78e818599210e2b99153a7)]:
  - @cogitator-ai/types@0.55.0
  - @cogitator-ai/memory@0.20.0
  - @cogitator-ai/core@0.53.0
  - @cogitator-ai/browser@0.4.30
  - @cogitator-ai/mcp@19.5.12
  - @cogitator-ai/rag@0.8.5

## 0.15.0

### Minor Changes

- [#229](https://github.com/cogitator-ai/Cogitator-AI/pull/229) [`c29c8a0`](https://github.com/cogitator-ai/Cogitator-AI/commit/c29c8a00c9fce4a22af1c697246f065045a2f014) - What a conversation established is kept as memory items, extracted after each run, grounded in quotes, trusted by who said them and kept with when they held, and runs read them as their facts.

  - Types: `MemoryItem` (`kind` `fact`, `event`, `preference`, `instruction`, `opinion` or `lesson`, `status` `suggested`, `active`, `stale` or `superseded`, `trust` `user`, `system`, `model`, `tool` or `web`, a `scope` of `agentId` and optional `userId`, `projectId` and `threadId`, `evidence` and `verified`, `saidAt`, `sessionAt`, `about` as `{ text, start, end, precision }`, bitemporal `validFrom` and `validTo` for the items of a slot and `recordedAt` and `expiredAt`, `supersedes` and `supersededBy`), `NewMemoryItem`, `MemoryEntity`, `MemoryItemAdapter`, `MemoryItemFilter` (with storage-side scope filters `visibleTo` and `scope`), `MemoryEntityFilter`, `MemoryItemQuery` (`active` and `superseded` by default with the state that holds read from `validFrom` and `validTo`, `asOf` world time defaulting to `knownAt`, `knownAt` memory time defaulting to now, `includeClosed`, `text`, `limit`) and `MemoryExtractionConfig`, `MemoryConfig.extraction`. `RunEndEvent.memoryAgentId` (the id the agent's memory is kept under), `BuildContextOptions.memoryAgentId` and `SummarizeOptions.maxTokens`.
  - Memory: `MemoryItems` keeps the rules over any `MemoryItemAdapter`. Writes only add, and one agent's writes go one after another within a process, items of one millisecond recorded a millisecond apart. An item said again merges into the newest open one no other value followed since, else it is a new state, and on a merge the trust and `verified` come together from the better source (the more trusted one first, then the one whose quotes hold), so a `system` item stays `system` and a user's unverified claim stays the user's but `suggested`. Values of a slot compare by text (`sameValue`: spacing aside, case and signs count), content compares normalized. After every write of a state, the `active` and `superseded` items of its slot (its `subject` linked to an entity, and its `attribute`) and exact scope are laid out by time: each closed (`superseded`, `validTo`) when the next starts, the last open. So racing writers, a state told late (it fits between the ones around it) and a failed close converge, a state set to start later leaves the current one in place until it starts, and a state let go keeps its place, so the one before does not come back. `expire` and `purge` reopen nothing. `link` reuses an entity the writer's scope sees (its own or a broader one, such as the user's for a thread), so a slot is the same in a thread and in the user's memory, settles duplicates of racing writers on the first made and adds no aliases. An item becomes `active` on its own from `system`, or from `user` with quotes that hold at `activationConfidence` (default 0.7), everything else stays `suggested`, so what a model, a tool or a page wrote cannot plant itself. An opinion said again gains 0.1 only when the new statement has quotes that hold, and loses 0.2 when a less trusted source contradicts it. `query` (`asOf`, `knownAt`, `includeClosed`, `text`, recording time filtered only by an explicit `knownAt`), `history`, `activate`, `markStale`, `expire` (an item with a future `expiredAt` is found until then), `purge`, `link`, and `visibleIn`, `normalizeName`, `sameValue`, `slotOf`, `isMemoryItemAdapter`.
  - Memory: `resolveTime(expression, sessionAt, timeZone)` turns time words a model marked up (`date`, `relative`, `weekday`, `TimeExpression`) into an interval in a time zone, `end` exclusive, with its precision. `MemoryExtractor` reads entries in windows of `windowTokens` (default 4000), one call each with `EXTRACTION_PROMPT` and the session date (`sessionLine`), shows each message with its date, checks every quote against its entry, gives each item the trust of the least trusted entry among its quotes that hold (`parseExtraction`, `trustOfEntry(entry, userId)`, `web` for tools that fetch pages, `model` for another user's message), resolves relative dates from the date of the first message it quotes (its `saidAt` and `sessionAt`), and writes the items through `MemoryItems`. A `null` or blank field is read as absent, an item that does not fit is dropped, and only an answer with no JSON array fails (`ExtractionAnswerError`, `WindowError` from `extract` with the window's own entries). Each call asks for up to 8000 tokens, and `extract` takes `onWindow` and `skip` to keep its place and go on without a window. `isTimeZone` tells an IANA time zone.
  - Memory: every built-in adapter stores memory items: `InMemoryAdapter`, `SQLiteAdapter` (`memory_items`, `memory_entities`, `memory_entity_names`), `PostgresAdapter` (`memory_items`, `memory_entities`), `RedisAdapter` (never under the thread `ttl`) and `MongoDBAdapter` (`<prefix>items`, `<prefix>entities`). SQLite and Postgres keep the scope in `user_id`, `project_id` and `thread_id` columns and MongoDB at the top of the document, so `findItems` filters by scope in the store. With `includeFacts`, `ContextBuilder` reads the items the run's agent, user and thread see that hold now as its facts (`ContextBuilderDeps.memoryItems`), in place of `FactAdapter`: one state per slot (the one that started last, the narrowest scope on a tie), instructions and preferences first, newest first, an item that superseded another as `(previously: X)` only when the run sees that value and memory did not let it go.
  - Memory: `CoreFactsStore` keeps its API over memory items, each key the slot `core:<key>` of `system` items in a new optional `scope` (`{ agentId: 'core' }` by default): `set` supersedes the current value, `delete` lets it go and keeps the history. `PostgresAdapter`'s `FactAdapter` keeps its API over items too, each fact in its own slot `fact:<id>`: `updateFact` with new content supersedes the current item and keeps the old one as history, `deleteFact` deletes the fact with its history.
  - Core: `memory.extraction` extracts memory items after a run on the thread's active branch (a run whose leaf other runs appended after included, runs of one thread one after another), from the entries since the last extraction (the cursor in the thread's `metadata.memoryExtraction`, `EXTRACTION_CURSOR`) or for a first extraction the run's own, by `extraction.model` (the model the run ended on by default). The thread keeps its place after every window, a cursor on an abandoned branch is replaced by the run's branch point, and a window the model could not answer three extractions in a row is left out (counted in the cursor's `failures` and `failedThrough`), never one a provider, storage or abort failure stopped. A first extraction that fails stores where it started (`through` the branch point, `null` for the thread's start), so the next one takes those entries too. Items are kept under the agent's memory id, its configured id, else its name (`memoryAgentId(agent)`, exported), and belong to the run's own user (never the thread's owner) by default (`scope` `user`, `agent` or `thread`), to the thread for a run without a user, relative dates are resolved in the thread's `metadata.timeZone` when it is a valid IANA zone, else `timeZone`, else UTC, the calls are counted in the run's costs and `usage`, `afterExtract(items)` gets what was written, and an extraction that fails is logged while the run keeps its result, the thread left alone for a minute, doubled after each failure in a row up to an hour. It is the built-in middleware `cogitator:memory-extraction` (`memoryExtractionMiddleware`), whose `afterRun` runs before `cogitator:memory-compaction`. A Cogitator gives the context builder memory items for every store that keeps them, so `includeFacts` works on every built-in store, `memory` included. User messages a run with a user saves carry `metadata.userId`. `CompactionRun` is exported, and the runtime's summarizers pass `maxTokens`.
  - Core: `createMemoryTools` takes `items` (memory items `remember` writes to the user's scope, or the thread's for a run without a user, `recall` searches the user's and the thread's, and `forget` lets go only the run's own that hold the query as whole words, past and suggested states included) and `memory` (the thread store). `remember` takes a `quote`, and with `memory` it keeps a fact as the user's (graph `source: 'user'`, an item trusted as `user`, a core fact) only when the quote is in one of the run user's own messages among the 200 newest entries of the thread's active branch, else as a suggestion that never becomes a core fact. Its item is trusted as `user` whenever its graph node is the user's, and stays `suggested` without a quote that holds. `forget` says it forgets: graph facts are deleted, items expire.
  - Config: `MemoryExtractionConfigSchema` validates `memory.extraction`.
  - Channels: `RuntimeBuilder` gives the memory tools the memory store and memory items, so the assistant's `remember` checks quotes, and the assistant's agent id is its `name`.
  - Test utils: `memoryItemAdapterConformanceCases` checks a `MemoryItemAdapter` against the contract the built-in stores keep, scope filters (`find-visible-to`, `find-scope`) included.
  - Breaking: Postgres schema version 3. The first `connect()` after upgrading moves every row of `facts` into a memory item and renames the table `facts_legacy`. Upgrade every process that shares the database at once.
  - Breaking: `CoreFactsStore` keeps its facts in memory item tables. A database with the old `core_facts` and `core_facts_history` tables is moved on `initialize()`, and the tables are renamed `core_facts_legacy` and `core_facts_history_legacy`. Setting the value a key already holds no longer adds a history entry.
  - Breaking: `remember` given `memory` no longer trusts a fact whose quote is missing or not found in the run user's own messages on the thread's active branch: it is kept as a suggestion (graph `source: 'inferred'`, confidence 0.6) and is not saved as a core fact.
  - Breaking: the agent `RuntimeBuilder` builds has its `name` as its id instead of a generated one.
  - Breaking: a `FactAdapter` fact with empty evidence comes back without the `evidence` field.
  - Breaking: `RunEndEvent` has a required `memoryAgentId`, so code that builds one must pass it.
  - Breaking: a Cogitator keeps an agent's memory items under its configured `id`, else its `name`, so an agent without an id keeps them under its name, and agents of one name without an id share them.

### Patch Changes

- Updated dependencies [[`c29c8a0`](https://github.com/cogitator-ai/Cogitator-AI/commit/c29c8a00c9fce4a22af1c697246f065045a2f014)]:
  - @cogitator-ai/types@0.54.0
  - @cogitator-ai/memory@0.19.0
  - @cogitator-ai/core@0.52.0
  - @cogitator-ai/browser@0.4.29
  - @cogitator-ai/mcp@19.5.11
  - @cogitator-ai/rag@0.8.4

## 0.14.0

### Minor Changes

- [#228](https://github.com/cogitator-ai/Cogitator-AI/pull/228) [`99ceb01`](https://github.com/cogitator-ai/Cogitator-AI/commit/99ceb0107f7403fba0a95e31fd2d10b743144a03) - A thread can be compacted into a tree of grounded atoms that is never summarized again and does not lose what is still open, and a Cogitator compacts a run's thread after the run.

  - `CompactionStrategy` gains `hierarchical`. The entries new since the last compaction, up to the kept tail, are read in chapters of about `chapterTokens` tokens (default 4000), each opening with the end of the one before, one at a time (`chapterConcurrency` reads more at once), and the summarizer lists the atoms of each, told the items still open before it so it can close them (`CompactionAtom`: `kind` `fact`, `task`, `decision`, `constraint`, `error`, `file` or `thread`, `status` `open` or `closed`, `text`, `evidence`, `verified`). Every quote is checked against its entry, an answer that is not a valid array is asked for again up to three tries, a constraint or a decision only tool outputs show is not verified, and files tool calls worked on, failed tool calls (known by their tool and files, or arguments when they name no files, and closed by a later call of the same tool on them that succeeds) and task lines (`TODO:`, `- [ ]`, closed by `- [x]`) are taken from the entries with no model. The transcript indents further lines of an entry and cuts one at about `chapterTokens`, and a part to compact under a tenth of the kept tail is left for later. Chapters beyond `chaptersPerArc` (default 4) fold into arcs and arcs beyond `arcsPerSaga` (default 4) into the saga, which keeps every open item and the newest 200 facts and files (`SAGA_ATOMS`), with no model, and an open item is closed only by an atom whose evidence holds. A control item is closed or opened again only by an atom whose evidence holds, and `messageThreshold` counts only the entries written since the last summary. The summary is written only when every open item of the one before is still there or was closed, else `compact()` throws and the thread stays as it was. The whole tree is one `compaction` entry, `CompactionEvent.levels` (`CompactionLevels` of `CompactionNode`s), and its message is the handoff, laid out as open tasks, constraints, decisions, unresolved errors, open questions, files, facts and done, in the same order every time so it stays in the prompt cache. `CompactionService.chapterAtoms(window, config, { own, open })` returns the checked atoms of one window. On an adapter without branches the levels are kept in the summary entry's metadata (`compactionLevels`).
  - `CompactionConfig.keepRecentTokens` keeps the newest tokens of the conversation verbatim for the `hierarchical` strategy, as whole turns that open with a user message, so a tool call keeps its result.
  - `memory.compaction` (`MemoryCompactionConfig`) compacts a run's thread `hierarchical`ly after the run once the conversation of its branch passes `at` (default 0.8) of the window of the model the run ended on, keeping `keepRecentTokens` (default the less of 20000 and a quarter of the window, unless only `keepRecent` is set). `beforeCompact({ threadId, tokens, threshold })` can return `false` to skip it or `{ instructions }` to add to the summarizer's prompt, and `afterCompact(result)` gets the `CompactionResult`. A thread that outgrows its window again within two turns of its last compaction is not compacted again, with a warning to clear tool outputs (`context.clearToolOutputs`) instead, a run on another branch than the active one is left alone, and a compaction that fails is logged while the run keeps its result, and the thread is left alone for a minute, doubled after each failure in a row up to an hour. The summarizer's calls are counted in the run's costs and in the `usage` it returns, and they stop with the run's signal. `compact()` refuses `chapterTokens`, `chapterConcurrency`, `chaptersPerArc` and `arcsPerSaga` that are not whole numbers above 0 (`checkCompactionSettings`). It is the built-in middleware `cogitator:memory-compaction` (`memoryCompactionMiddleware`), and `MemoryCompactionConfigSchema` validates it in `@cogitator-ai/config`.
  - Run middleware gets an `afterRun({ result, model }, context)` hook (`RunEndEvent`), called once a run finished and its writes settled, before `run()` returns. It is not called for a run that failed or paused, and an error it throws is logged without failing the run, the next hook still running.
  - Core: `anthropicCompactionSummarizer({ model, client?, apiKey?, maxTokens? })` is a `SummarizeFn` that has Anthropic's compaction on request (`ANTHROPIC_COMPACTION_BETA`, `compact-2026-09-04`) write the answer, with the prompt as its instructions. The answer is parsed and checked like any other, and the signed block is not kept, so the conversation goes on with Cogitator's own summary on every model.
  - Channels: the gateway's summarizer asks the model and prompt each call names, falling back to `summaryModel` and `summaryPrompt`, then to the agent's model. `Gateway.compactAll()` compacts every thread served since the start and the thread of every stored session (unless `session.threadKey` is set), one at a time past those that fail, and `/compact all` with `RuntimeBuilder` calls it instead of compacting a thread named `all`.
  - Breaking: `RuntimeBuilder` (`cogitator up`) compacts chat threads with the `hierarchical` strategy, keeping about 4000 tokens (`keepRecentTokens`) of the newest turns verbatim, instead of the `summary` strategy that kept the 10 newest messages. A thread compacted before is read on: its old summary becomes one closed, unverified fact of the first chapter.

### Patch Changes

- Updated dependencies [[`99ceb01`](https://github.com/cogitator-ai/Cogitator-AI/commit/99ceb0107f7403fba0a95e31fd2d10b743144a03)]:
  - @cogitator-ai/types@0.53.0
  - @cogitator-ai/memory@0.18.0
  - @cogitator-ai/core@0.51.0
  - @cogitator-ai/browser@0.4.28
  - @cogitator-ai/mcp@19.5.10
  - @cogitator-ai/rag@0.8.3

## 0.13.0

### Minor Changes

- [#226](https://github.com/cogitator-ai/Cogitator-AI/pull/226) [`85d05b2`](https://github.com/cogitator-ai/Cogitator-AI/commit/85d05b20fe48738ee6ddcea83a043bb890b6d077) - A context is assembled by partitions and ordered for the prompt cache, and old tool outputs can be cleared before anything is summarized.

  - `ContextAssembler` shares a token budget among the partitions of a context (`ContextPartition`): `system`, `pinned`, `index`, `summaries`, `facts`, `recall`, `brief`, `recent` and `final`. Each has a `ContextPartitionBudget` (`share`, `required`). By default (`DEFAULT_PARTITIONS`) `system`, `pinned`, `index`, `summaries`, `brief` and `final` are required, `facts` takes 15%, `recall` 35% and `recent` the rest. Required partitions are fitted first, the others split what they leave by their shares, and what the shares cannot place goes to the partitions still short of room in fill order, `recent` last. The shares of the partitions that are not required add up to 1 at most, or the constructor throws. A text block is left out as a duplicate when a block a more lasting partition kept holds all of it, word for word. `fitInOrder` is the default fit.
  - `ContextBuilder` builds on it. Its config takes `partitions`, merged over the defaults, and `build()` takes `pinned`, `index`, `brief` and `reserveTokens`. It counts `currentInput` in the budget as the `final` partition. `BuiltContext` gains `memoryContext` (the brief, facts, search results and graph context as one text) and `partitions` (tokens per partition), and `DroppedContext.blocks` lists every left out block (`DroppedBlock`) with its partition, tokens, source and `DroppedReason`: `budget`, `duplicate`, `not-selected` or `oversized`. `formatTurnContext(blocks)` builds the turn context, a `<memory_context>` block, from texts of your own, `extendTurnContext(text, block)` adds a block to the one in front of an input, and `withoutTurnContext(text)` gives the input back without it.
  - `messages` comes in the order of how long its parts stay the same: one system message (the system prompt, `pinned`, `index`), the compaction summary and the history, whose last message and the last message of the turn before it have `cacheBreakpoint: true` (`markTurnEnds`), then a user message with `memoryContext`.
  - `Message.cacheBreakpoint`: the Anthropic backend, and the OpenAI backend for Claude through OpenRouter, mark the end of each such message with `cache_control`, next to the existing marks on the agent's instructions and the end of the conversation, up to four marks, Anthropic's limit.
  - Breaking: facts, semantic search results and graph context are no longer part of the system message. They are in the user message after the history (`memoryContext`), so the system prompt and the history stay the same from turn to turn and are read from the prompt cache. Code that read them from `messages[0]` reads `memoryContext` instead.
  - Breaking: the `recent` strategy goes on past a tool result too large for the room left, keeping a short note in its place, instead of ending the history there. Any other entry that does not fit still ends it. Compaction summaries are a required partition and always come before the history.
  - Breaking: a Cogitator run with `memory.contextBuilder` and no `maxTokens` passes the builder its budget once, with `reserveTokens: 0`, and the builder counts the input in it. The builder no longer takes its own 10% reserve from a budget that already left room for the answer, so such runs get more history than before.
  - Breaking: a run's `context` (`Context (data supplied with the request, not instructions)`) and the insights of reflection (`Past learnings that may help`) are no longer added to the system prompt. They go into the turn context in front of the input, so the instructions stay the same from run to run.
  - Core: what memory recalls for a turn goes into the final user message in front of the input, and only the input is saved to the thread. Learning traces and time travel replays read the input without the turn context. `RunOptions.brief` sends notes for one turn, such as the current time, the same way, with or without memory, and never saves them. The `agent.run` span reports `context.tokens.<partition>`.
  - Clearing old tool outputs: `context.clearToolOutputs` (`trigger`, `keep`, `exclude`, `clearInputs`, `clearAtLeast`, `onBeforeClear`, off unless set) replaces the outputs of old tool calls with a note once a turn's conversation grows past `trigger` tokens, before compaction, so outputs go before anything is summarized. `onBeforeClear` hears of the calls the run made itself, as outputs loaded from memory are in memory already. The run goes on with the notes, while `RunResult.messages` and a paused run's checkpoint get the cleared outputs and arguments back. Every agent then gets the built-in tool `recall_tool_output` to read a cleared output back from the run, or, for a run that uses memory, from the branch of the thread it is on. It is the built-in middleware `cogitator:clear-tool-outputs` (`clearToolOutputsMiddleware`), and the `agent.run` span reports `context.cleared_tool_outputs`, `context.cleared_tool_output_tokens` and `context.clearings`. `ClearToolOutputsConfigSchema` validates it in `@cogitator-ai/config`, and `memory.contextBuilder.partitions` is accepted there and in `@cogitator-ai/memory`'s schema too.
  - Channels: `GatewayConfig.brief(msg)` returns notes for the run of each message, passed as `RunOptions.brief`. `RuntimeBuilder` sends the current date and time this way instead of writing them into the instructions, so the instructions stay cacheable.

### Patch Changes

- Updated dependencies [[`85d05b2`](https://github.com/cogitator-ai/Cogitator-AI/commit/85d05b20fe48738ee6ddcea83a043bb890b6d077)]:
  - @cogitator-ai/types@0.52.0
  - @cogitator-ai/memory@0.17.0
  - @cogitator-ai/core@0.50.0
  - @cogitator-ai/browser@0.4.27
  - @cogitator-ai/mcp@19.5.9
  - @cogitator-ai/rag@0.8.2

## 0.12.7

### Patch Changes

- Updated dependencies [[`c46adb9`](https://github.com/cogitator-ai/Cogitator-AI/commit/c46adb9429ef9686697a020d4d97634c907117d0)]:
  - @cogitator-ai/types@0.51.0
  - @cogitator-ai/memory@0.16.0
  - @cogitator-ai/core@0.49.0
  - @cogitator-ai/browser@0.4.26
  - @cogitator-ai/mcp@19.5.8
  - @cogitator-ai/rag@0.8.1

## 0.12.6

### Patch Changes

- Updated dependencies [[`92bcc11`](https://github.com/cogitator-ai/Cogitator-AI/commit/92bcc119e71742eaf2a4a3bffdeceaa18b153e5d)]:
  - @cogitator-ai/types@0.50.0
  - @cogitator-ai/memory@0.15.0
  - @cogitator-ai/core@0.48.0
  - @cogitator-ai/rag@0.8.0
  - @cogitator-ai/browser@0.4.25
  - @cogitator-ai/mcp@19.5.7

## 0.12.5

### Patch Changes

- Updated dependencies [[`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913), [`db16bbc`](https://github.com/cogitator-ai/Cogitator-AI/commit/db16bbc5f7c49b052382ea8dd4c0ba597216d913)]:
  - @cogitator-ai/types@0.49.0
  - @cogitator-ai/memory@0.14.0
  - @cogitator-ai/core@0.47.0
  - @cogitator-ai/browser@0.4.24
  - @cogitator-ai/mcp@19.5.6
  - @cogitator-ai/rag@0.7.9

## 0.12.4

### Patch Changes

- Updated dependencies [[`b42f62e`](https://github.com/cogitator-ai/Cogitator-AI/commit/b42f62ecd300cd945c42a91014b1297bc4e10c43)]:
  - @cogitator-ai/core@0.46.0
  - @cogitator-ai/types@0.48.0
  - @cogitator-ai/browser@0.4.23
  - @cogitator-ai/mcp@19.5.5
  - @cogitator-ai/memory@0.13.3
  - @cogitator-ai/rag@0.7.8

## 0.12.3

### Patch Changes

- Updated dependencies [[`ed48837`](https://github.com/cogitator-ai/Cogitator-AI/commit/ed4883796a82b5f2b832a5bb45ba861fb0b17f45)]:
  - @cogitator-ai/core@0.45.0
  - @cogitator-ai/types@0.47.0
  - @cogitator-ai/browser@0.4.22
  - @cogitator-ai/mcp@19.5.4
  - @cogitator-ai/memory@0.13.2
  - @cogitator-ai/rag@0.7.7

## 0.12.2

### Patch Changes

- Updated dependencies [[`f68ebd8`](https://github.com/cogitator-ai/Cogitator-AI/commit/f68ebd892ee493279058212105381e8acb73b70e)]:
  - @cogitator-ai/core@0.44.0
  - @cogitator-ai/types@0.46.0
  - @cogitator-ai/browser@0.4.21
  - @cogitator-ai/mcp@19.5.3
  - @cogitator-ai/memory@0.13.1
  - @cogitator-ai/rag@0.7.6

## 0.12.1

### Patch Changes

- Updated dependencies [[`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b), [`c899f39`](https://github.com/cogitator-ai/Cogitator-AI/commit/c899f39352baa90d8b047bb5dea95d9c0279389b)]:
  - @cogitator-ai/memory@0.13.0
  - @cogitator-ai/core@0.43.0
  - @cogitator-ai/types@0.45.0
  - @cogitator-ai/rag@0.7.5
  - @cogitator-ai/browser@0.4.20
  - @cogitator-ai/mcp@19.5.1

## 0.12.0

### Minor Changes

- [#207](https://github.com/cogitator-ai/Cogitator-AI/pull/207) [`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22) - `mcpServers.<name>.requiresApproval` in the assistant config decides which tools of an MCP server ask approval in chat before they run: `true` for every call, `false` for none. Without it the tools the server marks destructive ask, as `getTools()` of `@cogitator-ai/mcp` now does by default.

### Patch Changes

- Updated dependencies [[`b5c11eb`](https://github.com/cogitator-ai/Cogitator-AI/commit/b5c11eb5368f52169273527c2ea6f16e83ab8b22)]:
  - @cogitator-ai/types@0.44.0
  - @cogitator-ai/core@0.42.0
  - @cogitator-ai/mcp@19.5.0
  - @cogitator-ai/browser@0.4.19
  - @cogitator-ai/memory@0.12.9
  - @cogitator-ai/rag@0.7.4

## 0.11.4

### Patch Changes

- Updated dependencies [[`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765), [`8524d15`](https://github.com/cogitator-ai/Cogitator-AI/commit/8524d1557e03b856de9dd2ec9bccfce91ab74765)]:
  - @cogitator-ai/core@0.41.0
  - @cogitator-ai/mcp@19.4.0
  - @cogitator-ai/types@0.43.0
  - @cogitator-ai/browser@0.4.18
  - @cogitator-ai/memory@0.12.8
  - @cogitator-ai/rag@0.7.3

## 0.11.3

### Patch Changes

- Updated dependencies [[`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd), [`06ea6ec`](https://github.com/cogitator-ai/Cogitator-AI/commit/06ea6ec3eb96b4530d5f90f255c2e3abe630dfbd)]:
  - @cogitator-ai/types@0.42.0
  - @cogitator-ai/models@18.5.0
  - @cogitator-ai/core@0.40.0
  - @cogitator-ai/browser@0.4.17
  - @cogitator-ai/mcp@19.3.7
  - @cogitator-ai/memory@0.12.7
  - @cogitator-ai/rag@0.7.2

## 0.11.2

### Patch Changes

- [#199](https://github.com/cogitator-ai/Cogitator-AI/pull/199) [`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a) - Packages declare `"sideEffects": false`, so bundlers can leave out the modules an app does not use. None of them runs code at import time that depends on being kept. The repository URL in each package.json uses the `git+https` form npm expects.
- Updated dependencies [[`fd99224`](https://github.com/cogitator-ai/Cogitator-AI/commit/fd992243b89f3941f76c2acb607b59468a35480a)]:
  - @cogitator-ai/browser@0.4.16
  - @cogitator-ai/core@0.39.1
  - @cogitator-ai/mcp@19.3.6
  - @cogitator-ai/memory@0.12.6
  - @cogitator-ai/models@18.4.1
  - @cogitator-ai/rag@0.7.1
  - @cogitator-ai/types@0.41.1

## 0.11.1

### Patch Changes

- [#188](https://github.com/cogitator-ai/Cogitator-AI/pull/188) [`6481bdf`](https://github.com/cogitator-ai/Cogitator-AI/commit/6481bdfc871d20fe3633392ce0ea2f0fd0e17052) - `ThreadsFeed` no longer loses a post when Threads answers that a container it just reported ready cannot be found (Graph API code 24). That answer passes within seconds, so the feed publishes again after short waits (`publishRetryDelays`, 2, 5 and 10 seconds by default), and reads the container's status before each try: a container that did go out is looked up among the account's posts instead of being published twice. A post with neither text nor alt text cannot be told apart there, so it fails as `unknown` rather than taking another post's id, and a lookup without an idempotency key never takes a post the feed published before. A container still not found fails as `unavailable`, so `FeedPublisher` tries the post again later. `FeedError` carries the platform's own error code in `platformCode`, and Graph API code 24 maps to `not_found`.

## 0.11.0

### Minor Changes

- [#183](https://github.com/cogitator-ai/Cogitator-AI/pull/183) [`9a31e38`](https://github.com/cogitator-ai/Cogitator-AI/commit/9a31e3897e0992061744bbcc5cf4075db2848b77) - Posts can quote other posts: `FeedPost.quote` is the id of a post of the same feed to show inside the new one.

  - Bluesky embeds the quoted post as `app.bsky.embed.record`, or together with the post's images or link card as `app.bsky.embed.recordWithMedia`. The feed finds the quoted post's `cid` itself, from the posts it published, the account's own PDS or the AppView, and a quote can be a reply too.
  - Threads passes it as `quote_post_id` in text, image and carousel posts and in replies. Threads accepts a link card in a quote post but does not show it, so the feed leaves `link` out of a post that quotes, and a retry by idempotency key matches a quote post by the post it quotes.
  - An id that is not a post of the feed (an `at://` post URI on Bluesky, a media id on Threads) fails with `invalid_post` before anything is sent.

### Patch Changes

- Updated dependencies [[`9a31e38`](https://github.com/cogitator-ai/Cogitator-AI/commit/9a31e3897e0992061744bbcc5cf4075db2848b77), [`fba532a`](https://github.com/cogitator-ai/Cogitator-AI/commit/fba532a5fadc4d193f855c8aee0b44f48f9e0619), [`9ea52d8`](https://github.com/cogitator-ai/Cogitator-AI/commit/9ea52d872777486b674d627b0ceae2d3e749f416)]:
  - @cogitator-ai/types@0.41.0
  - @cogitator-ai/core@0.39.0
  - @cogitator-ai/rag@0.7.0
  - @cogitator-ai/browser@0.4.15
  - @cogitator-ai/mcp@19.3.5
  - @cogitator-ai/memory@0.12.5

## 0.10.1

### Patch Changes

- [#180](https://github.com/cogitator-ai/Cogitator-AI/pull/180) [`d7f5fcf`](https://github.com/cogitator-ai/Cogitator-AI/commit/d7f5fcf044784ac278a12772ae1cd0acea708cea) - `ThreadsFeed` publishes a post without its topic tag when Threads blocks tagging for the account (Graph API error subcode 2207051), instead of failing the post for good. The same post without the tag goes out, a warning says the tag was dropped, and a retry with the same idempotency key takes the untagged post for its own. `FeedError` carries the platform's `subcode` where it gives one.

## 0.10.0

### Minor Changes

- [#155](https://github.com/cogitator-ai/Cogitator-AI/pull/155) [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292) - Bluesky and Threads, for publishing posts and for talking with people.

  - `BlueskyFeed` and `ThreadsFeed` publish posts with a link card, images with alt text, tags, languages and replies, and check each post against the feed's limits before sending it: 300 graphemes and 3000 bytes on Bluesky, 500 characters with emoji counted by their UTF-8 bytes on Threads. Links, mentions and hashtags become clickable facets on Bluesky, and Threads posts go through a media container that is published once Threads reports it ready.
  - `FeedPublisher` sends one post to several feeds, now or at `publishAt`. Each feed is tracked on its own, so one failing feed does not stop the others. A delivery keeps the feed's idempotency key from before its first attempt, so an attempt after a crash or a lost answer finds the post instead of publishing it twice. Rate limits and a feed that is down are retried with backoff, a full Threads quota is waited out without spending attempts, the same `key` publishes once, text longer than a feed takes is cut at a word for that feed, and `dryRun` goes through every step but publishing.
  - A publisher takes one due job at a time, extends its claim while it works and saves only while the claim is its own, so a worker that lost its claim never overwrites the one that took over.
  - Jobs live in `MemoryPublishStore`, `FilePublishStore` or `PostgresPublishStore`, which lets several workers share them with `FOR UPDATE SKIP LOCKED` claims. Sessions and tokens live in `MemoryTokenStore`, `FileTokenStore` (an owner-only file, shared safely by the stores of one process) or `PostgresTokenStore`.
  - The Threads long-lived token renews itself a week before it expires, once for calls made at the same time and once for processes sharing a store. A failed renewal keeps the current token and tries again an hour later.
  - `BlueskyChannel` answers mentions, replies, quotes and direct messages through the Gateway, conversation requests included. `ThreadsChannel` answers replies and mentions, from signed webhooks or by polling. Long answers go out as threads of posts, and Markdown becomes plain text.
  - Channels with `editable: false` get finished answers from the Gateway instead of streamed edits, since Bluesky and Threads cannot edit posts. `markdownToPlainText` is exported.
  - `cogitator.yml` takes `channels.bluesky` and `channels.threads`, read from `BLUESKY_HANDLE`, `BLUESKY_APP_PASSWORD` and `THREADS_ACCESS_TOKEN`.
  - `@cogitator-ai/types` adds `FeedChannel` (with `idempotencyKey()` and `FeedPublishOptions`), `FeedPost`, `PublishedPost`, `FeedLimits`, `TokenStore` and `StoredToken`, the `bluesky` and `threads` channel types and `Channel.editable`.

  `@atproto/api` 0.24 or newer is an optional peer dependency, needed only for Bluesky.

### Patch Changes

- Updated dependencies [[`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292), [`6f09cc8`](https://github.com/cogitator-ai/Cogitator-AI/commit/6f09cc8b941ea02fd8dff1cc2f28c16b22783292)]:
  - @cogitator-ai/core@0.38.0
  - @cogitator-ai/types@0.40.0
  - @cogitator-ai/models@18.4.0
  - @cogitator-ai/browser@0.4.14
  - @cogitator-ai/mcp@19.3.4
  - @cogitator-ai/memory@0.12.4
  - @cogitator-ai/rag@0.6.4

## 0.9.3

### Patch Changes

- Updated dependencies [[`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e), [`82aeef6`](https://github.com/cogitator-ai/Cogitator-AI/commit/82aeef692bf1d08a6b9c21adc3fdcd5437f8285e)]:
  - @cogitator-ai/core@0.37.0
  - @cogitator-ai/types@0.39.0
  - @cogitator-ai/browser@0.4.13
  - @cogitator-ai/mcp@19.3.3
  - @cogitator-ai/memory@0.12.3
  - @cogitator-ai/rag@0.6.3

## 0.9.2

### Patch Changes

- Updated dependencies [[`d1a874c`](https://github.com/cogitator-ai/Cogitator-AI/commit/d1a874ce75b702eea77ca2a24945f383e8b63198)]:
  - @cogitator-ai/core@0.36.0
  - @cogitator-ai/types@0.38.0
  - @cogitator-ai/browser@0.4.12
  - @cogitator-ai/mcp@19.3.2
  - @cogitator-ai/memory@0.12.2
  - @cogitator-ai/rag@0.6.2

## 0.9.1

### Patch Changes

- [#139](https://github.com/cogitator-ai/Cogitator-AI/pull/139) [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa) - - memory: the SQLite adapter and the core facts store create the directory of their database file.
  - channels: the file-tool path guard now comes from `@cogitator-ai/core`.
  - workflows: `functionNode` takes the output type of its function, so `stateMapper` is typed by it.
  - workflows: the file run, approval, checkpoint and dead-letter stores write atomically, so a process killed mid-write leaves the previous state, which `recoverRuns()` picks up, instead of an empty file that lost the run.
  - next: `setThreadId(undefined)` starts a new thread.
- Updated dependencies [[`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa), [`95d5866`](https://github.com/cogitator-ai/Cogitator-AI/commit/95d58666629772419cf200daf120542cbe9289fa)]:
  - @cogitator-ai/core@0.35.0
  - @cogitator-ai/memory@0.12.1
  - @cogitator-ai/types@0.37.0
  - @cogitator-ai/browser@0.4.11
  - @cogitator-ai/mcp@19.3.1
  - @cogitator-ai/rag@0.6.1

## 0.9.0

### Minor Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - `CompactionConfig.threshold` means tokens everywhere. The Gateway compared it with the number of messages while `CompactionService` compared it with tokens, so `threshold: 8000` from the memory docs waited for 8000 messages in a channel. The new `messageThreshold` counts messages, and a thread is compacted once either limit is reached (`threshold` is now optional, at least one is required). Gateway configs that meant messages should switch to `messageThreshold`. The `memory.compaction.threshold` of an assistant YAML config still counts messages, and `cogitator init` generates `messageThreshold`.

### Patch Changes

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - MCP tools of the assistant runtime are named `mcp_<server>_<tool>`, so two servers with a `search` tool both stay usable, and the instructions list the tools each server actually added instead of promising an `mcp_` prefix that did not exist. A tool whose name is taken is left out with a warning. Debounced and collected messages merge only per chat and topic and keep `topicId` and `replyTo`, so answers in a Telegram forum go to the topic they were asked in, and a single message passes on unchanged.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - CommonJS consumers can load the packages again. The exports maps only had an `import` condition, so `require('@cogitator-ai/core')` from NestJS, Jest in CommonJS mode or a script outside `"type": "module"` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, although Node 22.12+ can `require()` these ES modules. Every entry now ends with a `default` condition pointing at the same file.

- [#136](https://github.com/cogitator-ai/Cogitator-AI/pull/136) [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281) - Installing `@cogitator-ai/core` or `@cogitator-ai/memory` no longer installs every database driver. They were optional dependencies, so each install pulled `mongodb`, `pg`, `ioredis`, `@qdrant/js-client-rest` and a native build of `better-sqlite3` (about 141 MB in a basic project) and bundlers warned about them. They are now optional peer dependencies: install the driver of the store you use. A missing driver fails `connect()` with the command to install it (`PostgresAdapter`, `SQLiteGraphAdapter` and `PostgresTraceStore` now say so too). The CLI, whose assistant always keeps memory in SQLite, depends on `better-sqlite3` itself, `@cogitator-ai/channels` lists it as an optional peer, and the memory template of `create-cogitator-app` adds `ioredis`.
- Updated dependencies [[`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281), [`9593a4a`](https://github.com/cogitator-ai/Cogitator-AI/commit/9593a4a09422e082c619d991cafdfaf42bf20281)]:
  - @cogitator-ai/core@0.34.0
  - @cogitator-ai/types@0.36.0
  - @cogitator-ai/models@18.3.0
  - @cogitator-ai/memory@0.12.0
  - @cogitator-ai/browser@0.4.10
  - @cogitator-ai/mcp@19.3.0
  - @cogitator-ai/rag@0.6.0

## 0.8.6

### Patch Changes

- Updated dependencies [[`151d675`](https://github.com/cogitator-ai/Cogitator-AI/commit/151d6758803e4f01f79bb1546784010aa702493e)]:
  - @cogitator-ai/core@0.33.0
  - @cogitator-ai/types@0.35.0
  - @cogitator-ai/browser@0.4.9
  - @cogitator-ai/mcp@19.2.10
  - @cogitator-ai/memory@0.11.8
  - @cogitator-ai/rag@0.5.6

## 0.8.5

### Patch Changes

- Updated dependencies [[`3750d25`](https://github.com/cogitator-ai/Cogitator-AI/commit/3750d2597c58c2aa7654a1d842f28489d29dc774)]:
  - @cogitator-ai/types@0.34.0
  - @cogitator-ai/core@0.32.0
  - @cogitator-ai/browser@0.4.8
  - @cogitator-ai/mcp@19.2.9
  - @cogitator-ai/memory@0.11.7
  - @cogitator-ai/rag@0.5.5

## 0.8.4

### Patch Changes

- Updated dependencies [[`561f0be`](https://github.com/cogitator-ai/Cogitator-AI/commit/561f0beb7c33c9f1fb214c2bc205a5f2f9347af2), [`51338f4`](https://github.com/cogitator-ai/Cogitator-AI/commit/51338f448b0a6310ecf47b1e0ba63e7d9fffd006)]:
  - @cogitator-ai/core@0.31.0
  - @cogitator-ai/types@0.33.2
  - @cogitator-ai/browser@0.4.7
  - @cogitator-ai/mcp@19.2.8
  - @cogitator-ai/memory@0.11.6
  - @cogitator-ai/rag@0.5.4

## 0.8.3

### Patch Changes

- Updated dependencies [[`f52311d`](https://github.com/cogitator-ai/Cogitator-AI/commit/f52311d225c550419398e4978cb480231f9a4e1b)]:
  - @cogitator-ai/core@0.30.4
  - @cogitator-ai/browser@0.4.6

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
