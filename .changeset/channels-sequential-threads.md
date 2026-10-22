---
'@cogitator-ai/channels': minor
'@cogitator-ai/types': minor
---

Channels: the gateway answers the messages of a thread one at a time and keys threads by conversation.

This changes behavior for existing gateways:

- `queueMode` defaults to `'sequential'`: a thread answers its messages in the order they came, one at a time, while different threads run side by side. A channel's message handler returns once the message is queued, so Telegram long polling and the Bluesky and Threads polls go on to other chats, button presses and stop buttons while a thread is busy. `injectMessage` resolves once the message is answered, and the new `gateway.idle()` waits until every queued message is.
- The default thread key is `channelType:conversation:userId` instead of `channelType:userId`. The conversation is the new `ChannelMessage.conversationId` when a channel sets it, else `channelId` plus `:topicId`. A user's private chat, each group, each Telegram forum topic and each Slack thread is a thread of its own. Slack sets `topicId` to the Slack thread of channel messages (a top-level message opens its own) and posts into it when a reply names no message. Bluesky and Threads set `conversationId` to the root of the post thread, so the replies of one post thread stay in one thread while each answer still goes to its post.
- The gateway keeps each user's conversations in their session's metadata (`conversations`). `compactAll()` finds their threads after a restart, and a scheduled task is answered in the topic of the user's most recent conversation in its chat. `HeartbeatScheduler` passes `topicId` and `conversationId` from a task's metadata.
- `defaultThreadKey`, `legacyThreadKey` and `conversationOf` are exported. `MessageQueue.push` returns a promise that settles once the message is done with.

Migration: to keep the old behavior, pass `queueMode: 'parallel'`, and pass `session: { threadKey: legacyThreadKey }` to keep the threads stored under the old key (their history is not found by the new one). With `cogitator up`, set `session.queueMode: parallel` and `session.threadKey: legacy` in `cogitator.yml`.
