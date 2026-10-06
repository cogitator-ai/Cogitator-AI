---
'@cogitator-ai/mcp': minor
'@cogitator-ai/self-modifying': minor
---

`MCPServer` and `SelfModifyingAgent` run tool calls through `cogitator.invokeTool()` instead of calling `execute` directly, so approval, the guardrails, the sandbox and `tool.timeout` apply as in an agent run.

- `MCPServer` asks for a tool that needs approval through MCP elicitation, and refuses it with a clear `isError` result when the client cannot be asked. Before, `serveMCPTools([...builtinTools])` over HTTP ran `exec` on the host without anyone approving it. The new `toolInvoker` option takes your Cogitator so its sandbox manager and guardrails are used, and `serveAgents` uses its host for that. Arguments are still parsed exactly once.
- `SelfModifyingAgent` takes `toolInvoker` and `onApproval`. A call nobody approves is refused and the model is told why, a sandboxed tool runs in the sandbox, and a tool whose parameters are a JSON schema (for example from `fromAISDKTool`) runs instead of failing the whole run with `safeParse is not a function`. `close()` releases the Cogitator the agent creates when no `toolInvoker` is given.
