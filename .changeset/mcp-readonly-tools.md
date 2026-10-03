---
'@cogitator-ai/mcp': patch
---

`MCPServer.registerTools` and `serveMCPTools` accept a `readonly Tool[]`, so frozen arrays, `as const` lists and toolsets typed as readonly can be served without copying.
