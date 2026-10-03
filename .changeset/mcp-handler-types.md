---
'@cogitator-ai/mcp': patch
---

Server handler types match what the server accepts: a resource's `read` may leave out `uri` (it defaults to the URI that was read) through `MCPResourceReadContent`, and a prompt's `get` may return plain string content through `MCPPromptReplyMessage`. The client's `MCPResourceContent` and `MCPPromptMessage` keep their complete shapes.
