---
'@cogitator-ai/mcp': minor
---

`MCPServer` tells clients how to use it and tells tools who is calling.

- `instructions` in the server's config reaches every client when it connects (`initialize` and `server/discover`), and clients hand it to their model next to the tools.
- A tool's context has `request`: `request.meta` is the `_meta` the client sent with the call, without the protocol's own keys, and `request.client` is the client's name and version. Codex names its thread and turn in `_meta`, Claude Code the id of the tool use, so a tool can tell its callers apart without a session of its own.
