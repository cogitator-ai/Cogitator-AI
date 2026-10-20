---
'@cogitator-ai/core': minor
'@cogitator-ai/types': minor
---

Tools can get typed per-run dependencies. `RunOptions.deps` reaches every tool of the run as `context.deps`, including tools of agents it hands over to, agents run with `agentAsTool` and `cogitator.invokeTool(tool, args, { deps })`. Unlike `context`, which is added to the system prompt, deps never reach the model, the memory, spans, the run result or a paused run's checkpoint, so `resume()` takes them again.

`ToolContext<Deps>` types `context.deps` for a tool, and `new Agent<Deps>(...)` only accepts tools whose deps it provides and makes `deps` required in `run()` and `resume()`. `Tool`, `ToolConfig`, `AgentConfig`, `Agent` and `RunOptions` take the deps type as a new last type parameter that defaults to `unknown`, so existing code compiles as it is. The context a runtime hands a tool is now `BaseToolContext`, which `ToolContext` without a type argument still is.
