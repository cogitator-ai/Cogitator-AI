---
'@cogitator-ai/core': minor
'@cogitator-ai/mcp': minor
'@cogitator-ai/channels': minor
'@cogitator-ai/bridge': patch
'@cogitator-ai/cli': patch
---

The `cogitator` binary and the server of the bridge tools start several times faster. A command loads what it uses, not what every command uses.

- **`cogitator <command>` loads that command alone.** Before, every command line loaded all 26 commands with the runtime, the LLM SDKs and the channels, about 1500 modules. Now `cogitator --version` loads 14 modules, `cogitator models` about 210, and the commands that run no agent (`init`, `doctor`, `status`, `build`, `daemon`, `wizard`, `eval`, `mcp`, `bridge`) no longer load `@cogitator-ai/core`. The help of the program and a mistyped command still load every command, to list and to suggest them.
- **`cogitator bridge mcp` answers `initialize` without the runtime.** It loaded about 1500 modules before its first answer, now about 400. The runtime is loaded with the first tool call.
- `@cogitator-ai/core/tool`: a new entry with `tool()`, `toolset()` and the helpers for tool names, schemas and results, the same functions the package root exports. It does not load the agents, the LLM backends or their SDKs, for a process that only defines tools.
- `@cogitator-ai/mcp/server`: a new entry with `MCPServer`, `serveMCPTools` and `InMemoryMCPTaskStore`, without the MCP client. `MCPServer` loads `@cogitator-ai/core` with the first tool call that runs through a Cogitator of its own, and never when `toolInvoker` is set, so a server answers `initialize` and lists its tools without it.
- `@cogitator-ai/channels/assistant-config`: a new entry with `AssistantConfigSchema` and its types alone, for a tool that reads or checks `cogitator.yml` without the channels.
- `@cogitator-ai/bridge/tools` takes `tool()` from `@cogitator-ai/core/tool`, so it needs a `@cogitator-ai/core` that has this entry.
