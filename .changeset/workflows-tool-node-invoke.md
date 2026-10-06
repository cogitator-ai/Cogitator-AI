---
'@cogitator-ai/workflows': minor
---

`toolNode` runs its tool through `cogitator.invokeTool`, the way an agent run calls it. The mapped arguments are validated against the tool's schema, the guardrails apply, a sandboxed tool runs in the runtime's sandbox and `tool.timeout` is kept. A tool with `requiresApproval` asks the workflow's approval store, like an `agentNode`, and runs only once the call is approved. Before, `toolNode` called `tool.execute` directly, so a tool that needs approval ran unasked. The node now needs the `Cogitator` the executor puts in its context, and the new `approvals` option and `NodeApprovalOptions` type shape the requests.
