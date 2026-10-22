---
'@cogitator-ai/channels': minor
'@cogitator-ai/types': minor
'@cogitator-ai/core': minor
'@cogitator-ai/cli': patch
---

Channels: the gateway answers the messages of a thread one at a time and keys threads by conversation.

This changes behavior for existing gateways:

- `queueMode` defaults to `'sequential'`: a thread answers its messages in the order they came, one at a time, while different threads run side by side. A channel's message handler returns once the message is queued, so Telegram long polling and the Bluesky and Threads polls go on to other chats, button presses and stop buttons while a thread is busy. `injectMessage` resolves once the message is answered, and the new `gateway.idle()` waits until every queued message is.
- Channels now confirm a message to their platform once it is queued, before it is answered: Telegram long polling moves its offset, Bluesky marks its notifications seen, Threads moves past the post. So `gateway.stop()` drains first: it flushes the debouncer and waits up to the new `drainTimeout` (default 30000 ms) for the queued messages and the runs in progress, then aborts the runs still going, drops what still waits, waits up to `drainTimeout` again for the aborted runs to settle and only then stops the channels. `RuntimeBuilder`'s `cleanup()` closes memory after it, and `cogitator assistant` and `cogitator up` wait for it, quitting at once on a second Ctrl-C.
- The default thread key is `channelType:conversation:userId` instead of `channelType:userId`. The conversation is the new `ChannelMessage.conversationId` when a channel sets it, else `channelId` plus `:topicId`. A user's private chat, each group, each Telegram forum topic, each Slack thread and each GitHub issue, pull request and review thread is a thread of its own.
- Slack sets `topicId` to the `ts` of the Slack thread of a channel message. A top-level channel message is answered in a new Slack thread, a conversation of its own without the history of earlier ones, and `sendText` posts into the `topicId` thread when a reply names no message. A DM stays one conversation.
- Bluesky and Threads set `conversationId` to `thread:<root>`, so the replies of one post thread stay in one thread while each answer still goes to its post. A WhatsApp direct chat addressed by LID sets `conversationId` to the person's phone-number jid when WhatsApp shares it, so it is one thread with the chat addressed by phone number. `ChannelAction` and `ChannelStop` carry `conversationId` too, and the approval buttons check it.
- Telegram gives a button press a `topicId` only in a forum topic or a private chat topic, as it does for messages, so Approve and Deny work in the reply threads of plain groups.
- Runs get the `topicId` and `conversationId` of their message (`RunOptions`, `ToolContext`, the run middleware context and `invokeTool` options have both), `schedule_task` stores them with the task and `HeartbeatScheduler` puts them on the message it fires, so a reminder set in a topic or a post thread fires there, even after the user moved on. A task without them is answered in the topic of the user's most recent conversation in its chat, taken from the conversations the gateway keeps in each user's session metadata (`conversations`, up to 50). `compactAll()` finds the threads of stored sessions there after a restart.
- `stats.totalSessions` and `getSessions()` count conversations, not users, and the gateway keeps its bookkeeping of the 10000 most recent threads (`MAX_TRACKED_THREADS`).
- New exports: `defaultThreadKey`, `legacyThreadKey`, `conversationOf`, `readConversations`, `CONVERSATIONS_KEY`, `MAX_TRACKED_THREADS` and the types `ConversationRef` and `StoredConversation`. `MessageQueue.push` returns a promise that settles once the message is done with.

Migration: to keep the old behavior, pass `queueMode: 'parallel'`, and pass `session: { threadKey: legacyThreadKey }` to keep the threads stored under the old key (their history is not found by the new one). With `legacyThreadKey`, `compactAll()` still finds the thread of every stored session, while any other custom `threadKey` leaves stored sessions to it and the gateway keeps no conversations. With `cogitator up`, set `session.queueMode: parallel` and `session.threadKey: legacy` in `cogitator.yml`.
