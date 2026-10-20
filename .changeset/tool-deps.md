---
'@cogitator-ai/core': minor
'@cogitator-ai/types': minor
---

Tools can get typed per-run dependencies. `RunOptions.deps` reaches every tool of the run as `context.deps`, including tools of agents it hands over to, agents run with `agentAsTool` and `cogitator.invokeTool(tool, args, { deps })`. Unlike `context`, which is added to the system prompt, deps never reach the model, the memory, spans, the run result or a paused run's checkpoint, so `resume()` takes them again. Server adapters, channels, swarms, workflows and the worker start runs without deps for now.

`ToolContext<Deps>` types `context.deps` for a tool. `new Agent<Deps>(...)` makes `deps` required in `run()` and `resume()` and refuses tools whose deps type is unrelated to `Deps`. Tool methods are compared loosely, so declare every field the agent's tools read in `Deps`.

- `Tool`, `ToolConfig`, `tool()`, `AgentConfig`, `Agent`, `RunOptions` and `ResumeOptions` take the deps type as a new last type parameter that defaults to `unknown`, and `cogitator.run()`, `resume()`, `invokeTool()` and `agentAsTool()` are generic over it, so existing code compiles as it is.
- New types: `BaseToolContext<Deps>` (the context a runtime hands a tool, with `deps?`), `RunDeps<Deps>` and `ToolInvocationOptions.deps`.
- `ToolContext` is now a type alias over `BaseToolContext` instead of an interface. `interface X extends ToolContext` still works, but declaration merging into `ToolContext` (`declare module '@cogitator-ai/types' { interface ToolContext { ... } }`) no longer does: merge into `BaseToolContext` instead.
