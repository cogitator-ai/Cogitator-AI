# @cogitator-ai/acp

The [Agent Client Protocol](https://agentclientprotocol.com) for Cogitator, both ways:

- **Agent side** - serve Cogitator agents to editors that speak ACP (Zed, JetBrains, Neovim, VS Code and others). A Cogitator thread is an ACP session, a prompt is a turn of the app-server's `SessionHost`.
- **Client side** - run external ACP agents (Claude Code, Codex, Gemini CLI and any agent of the ACP registry) as session providers of a `SessionHost`, next to your own agents. Their permission requests go through Cogitator's permission engine.

Built on the official TypeScript SDK `@agentclientprotocol/sdk` (ACP v1).

```bash
pnpm add @cogitator-ai/acp @cogitator-ai/app-server @cogitator-ai/core
```

Or with no code at all: `cogitator acp` serves a Cogitator coding agent to the editor that launches it.

## Use Cogitator in your editor

Point the editor's custom agent at the CLI. In Zed's `settings.json`:

```json
{
  "agent_servers": {
    "Cogitator": {
      "command": "npx",
      "args": ["-y", "@cogitator-ai/cli", "acp", "-m", "ollama/qwen3:8b"]
    }
  }
}
```

`cogitator acp` runs the `coding` harness agent (workspace tools, a shell, todos, skills, subagents, commands, project instructions, compaction) on the model of `-m`, the config file or a local Ollama. It works in the project it is launched in: its settings, commands, subagents and hooks are read there, and a session in a directory outside it is refused, so launch it in the project you open. Sessions are kept in `~/.cogitator/sessions.db`, so `session/load` brings them back. `--trust` trusts the project: its subagents, commands, hooks and the allow rules of its settings files apply, and "always" answers are saved to `.cogitator/settings.local.json` (without it they last for the session).

## Serve your own agent

```typescript
import { Agent, Cogitator, workspaceTools } from '@cogitator-ai/core';
import { SessionHost } from '@cogitator-ai/app-server';
import { createAcpAgent, serveAcpStdio } from '@cogitator-ai/acp';

const cogitator = new Cogitator({
  memory: { adapter: 'sqlite', sqlite: { path: './sessions.db' } },
  permissions: {},
});
const coder = new Agent({
  name: 'coder',
  model: 'ollama/qwen3:8b',
  instructions: 'You are a careful coding agent.',
  tools: workspaceTools(),
  todos: true,
});

const host = new SessionHost({ cogitator, agents: { coder } });
const acp = createAcpAgent({
  host,
  cogitator,
  agentInfo: { name: 'my-agent', version: '1.0.0' },
  models: ['ollama/qwen3:8b', 'anthropic/claude-sonnet-5-5'],
});
await serveAcpStdio(acp);
await host.close();
```

Nothing but the protocol may write to stdout: send logs to stderr.

### What the editor gets

| ACP                                     | Cogitator                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `initialize`                            | capabilities, `agentInfo` and an auth method, which the ACP registry asks for                  |
| `authenticate`                          | `options.authenticate` checks the method (the CLI checks that a model is configured)           |
| `session/new`                           | a new thread, its directory kept as `acp.cwd`                                                  |
| `session/load`, `session/resume`        | the thread again, `load` replaying its messages                                                |
| `session/list`, `session/delete`        | the threads of the agent, by directory, and `deleteThread`                                     |
| `session/close`                         | the turn interrupted, the workspace and MCP servers of the session released                    |
| `session/prompt`                        | a turn, its stop reason from how the run ended (`end_turn`, `max_tokens`, `refusal`...)        |
| `session/cancel`                        | `turn/interrupt`, the prompt ends `cancelled`                                                  |
| `session/set_mode`, `set_config_option` | the permission mode of the thread, the model and the reasoning effort of its turns             |
| `session/update`                        | message and thought chunks, tool calls, the plan, commands, mode and title, compaction notices |
| `session/request_permission`            | tool approvals, a plan to approve, a budget to raise                                           |
| `fs/*`, `terminal/*`                    | the workspace of the session, when the editor offers them                                      |
| `elicitation/create`                    | the questions tools ask, when the editor takes forms                                           |

- **Tool calls** show the tool's presentation as the title, a kind from what the tool touches (`read`, `edit`, `delete`, `search`, `execute`, `fetch`), the paths it reads or edits as locations, the diff of a `write_file` or `edit_file` (in the permission question too), and the terminal a command ran in.
- **Plan**: the agent's `write_todos` list goes out as the session's plan, the tool call itself stays hidden.
- **Commands**: `available_commands_update` lists the runtime's commands (Markdown commands of `commands/` folders and those in code) and the agent's `SKILL.md` skills. `/review src` is expanded by the runtime, `/<skill> what` asks the agent to use the skill.
- **Permissions**: the options are `allow_once`, `allow_always`, `reject_once` and `reject_always`. An "always" answer saves the rule the request suggests (such as `run_command(npm test *)`) as an allow or a deny rule, for the session or to the settings file of `permissions.rememberIn`.
- **Cancelling**: `session/cancel` and `session/close` stop the prompt wherever it is, also between turns and while a question waits: the prompt ends `cancelled` and no turn starts after it.
- **Directories**: `roots` limits the directories sessions may work in, for an agent whose project files come from one place.
- **Plan mode**: when the agent presents its plan with `exit_plan_mode`, the editor is asked "Ready to code?" and the turn goes on in the mode picked (`acceptEdits` or `default`), or keeps planning.
- **Questions**: a tool's `context.interrupt()` is asked as a form when the editor takes forms and the answer is an object, else the agent says the question and the next prompt answers it.
- **Files and terminals**: `AcpClientWorkspace` reads and writes files through the editor (so the agent sees unsaved changes and the editor follows its edits) and runs commands in the editor's terminals, as the editor advertised. Everything else, and every path check, goes to the `LocalWorkspace` at the session's directory.
- **MCP servers** the editor names in `session/new` connect through `MCPClient` (stdio, HTTP and SSE), their tools named `mcp__<server>__<tool>`.
- **Compaction** shows as `compaction_update` when the editor takes it, else as a notice or a thought.

## Run external ACP agents

```typescript
import { Agent, Cogitator, LocalWorkspace } from '@cogitator-ai/core';
import { SessionHost, createAppServer, serveStdio } from '@cogitator-ai/app-server';
import { AcpAgentProvider, resolveAcpAgent } from '@cogitator-ai/acp';

const workspace = new LocalWorkspace({ root: process.cwd() });
const launch = await resolveAcpAgent('claude');
const claude = new AcpAgentProvider({
  agent: { command: launch.command, args: launch.args },
  workspace,
  name: 'claude',
  permissions: { rules: { allow: ['Bash(npm test *)'], deny: ['Bash(rm *)'] } },
});

const host = new SessionHost({
  cogitator: new Cogitator({ memory: { adapter: 'sqlite', sqlite: { path: './sessions.db' } } }),
  agents: {
    assistant: new Agent({ name: 'assistant', model: 'ollama/qwen3:8b', instructions: 'Help.' }),
  },
  providers: { claude },
});
await serveStdio(createAppServer(host));
await host.close();
await claude.close();
```

From the CLI: `cogitator app-server -m ollama/qwen3:8b --acp-agent claude --acp-agent mine=./my-agent`.

- **Agents**: `resolveAcpAgent()` takes a preset (`claude`, `codex`, `gemini`, launched with `npx`), `registry:<id>` for an agent of the [ACP registry](https://agentclientprotocol.com/registry) (`npx` and `uvx` distributions), or a command line. `{ app }` runs an `AgentApp` in this process instead.
- **Sessions**: each thread of the provider is a session of the agent, its id kept in the thread's metadata (`acp.agentSessionId`), resumed or loaded when the agent was launched again. The host keeps the user and assistant messages, so `thread/resume` shows them.
- **Stream**: message and thought chunks become text and reasoning, tool calls become tool events with their arguments, progress and results, the plan a `write_todos` call. App-server clients see them as the events of any turn.
- **Permissions**: every `session/request_permission` is decided by `resolvePermission` in the thread's mode: `execute` calls as `run_command` (`Bash(...)` rules, the command's directory and environment checked with it), reads as `read_file`, edits as `edit_file`, fetches as `web_fetch`, any other tool as `acp__<agent>__<tool>`. What would ask goes to the client of the turn (`onApproval`), and an "always" answer saves a rule, but not for a call known only by its kind (no tool name, command or paths), whose rule would cover every such call. Without a client to ask, it is refused.
- **Plan mode**: leaving it (`switch_mode`, such as Claude Code's ExitPlanMode) always asks, and once approved the thread goes on in the mode the agent's option names (`default` or `acceptEdits`).
- **Files and terminals** the agent asks for are served from the provider's workspace, inside its root, checked by the same engine. Each one is decided again with the mode and the rules of the moment, and only the question is spared for a call the agent got permission for in the turn (not when a terminal adds environment variables or runs in another directory). A terminal runs the program the agent names with its exact arguments, `bash -lc` staying bash, while the rules match the script it runs. A terminal keeps the newest `outputByteLimit` bytes of its output, 1 MiB when the agent names none.
- **Interrupts** reach the agent also while it starts (an `npx` download, `session/new`): the turn ends at once and no prompt is sent.
- **Modes and models**: the agent's session follows the thread's permission mode when it has a mode of that name (Claude Code does), and the turn's model when it offers it.
- An agent's threads cannot be forked, rewound or reviewed, and a turn of one takes no steering. Close the provider when done: it stops the agent and its commands.

## API

| Export                                                 | What                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| `createAcpAgent(options)`, `AcpAgent`                  | The agent side over a `SessionHost`, its `app` an SDK `AgentApp` |
| `serveAcpStdio(agent, { input, output })`              | Serves it on stdio until the editor closes its end               |
| `AcpClientWorkspace`                                   | A `Workspace` over the editor's files and terminals              |
| `AcpAgentProvider`                                     | An external ACP agent as a `SessionProvider` of a host           |
| `AcpPermissions`, `subjectOf()`                        | The permission engine for the calls of external agents           |
| `resolveAcpAgent()`, `fetchAcpRegistry()`              | Presets, the registry and command lines                          |
| `TurnUpdates`, `AcpStreamMapper`                       | The stream mapping each way, `StreamEvent` and `session/update`  |
| `toUserInput()`, `viewOfToolCall()`, `configOptions()` | The pieces of the mapping, for agents of your own                |

## Registry

`registry/cogitator/` holds the card of `cogitator acp` for the [ACP registry](https://github.com/agentclientprotocol/registry): `agent.json` (the `npx` distribution of `@cogitator-ai/cli` with `acp`) and a 16x16 `icon.svg`. Its `version` follows the CLI's release.

## License

MIT
