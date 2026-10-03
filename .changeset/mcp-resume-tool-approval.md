---
'@cogitator-ai/mcp': patch
---

`serveAgents` / `agentTools` added the `<agent>_resume` tool for any agent that had a tool with `requiresApproval` set, even `requiresApproval: false`. The resume tool is now added only when a tool can actually ask for approval (`requiresApproval: true` or a check function).
