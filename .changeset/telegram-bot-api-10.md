---
'@cogitator-ai/channels': minor
'@cogitator-ai/types': minor
---

Telegram on the current Bot API, and buttons, stops and topics for every channel.

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
