---
'@cogitator-ai/channels': patch
---

MCP tools of the assistant runtime are named `mcp_<server>_<tool>`, so two servers with a `search` tool both stay usable, and the instructions list the tools each server actually added instead of promising an `mcp_` prefix that did not exist. A tool whose name is taken is left out with a warning. Debounced and collected messages merge only per chat and topic and keep `topicId` and `replyTo`, so answers in a Telegram forum go to the topic they were asked in, and a single message passes on unchanged.
