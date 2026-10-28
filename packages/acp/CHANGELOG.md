# @cogitator-ai/acp

## 0.2.0

### Minor Changes

- [#317](https://github.com/cogitator-ai/Cogitator-AI/pull/317) [`ac89cec`](https://github.com/cogitator-ai/Cogitator-AI/commit/ac89cec9ea8d288afd58f7dbbe1531f8425d757a) - The Agent Client Protocol, both ways: Cogitator agents now work inside Zed, JetBrains, Neovim, VS Code and every other ACP editor, and Claude Code, Codex, Gemini CLI or any agent of the ACP registry can run as an agent of your own app-server.

  New package `@cogitator-ai/acp`, built on the official SDK `@agentclientprotocol/sdk` (ACP v1):

  - `createAcpAgent({ host, cogitator })` serves the agent of an app-server `SessionHost` to an editor, `serveAcpStdio()` over stdio. A thread is an ACP session: `session/new`, `load` (replaying the conversation), `resume`, `list`, `close`, `delete`, `set_mode`, `set_config_option` and `prompt` and `cancel` all map onto the host. `initialize` offers an auth method, which the ACP registry asks of its agents.
  - The turn streams as `session/update`: message and thought chunks, tool calls with a title from the tool's presentation, their kind, the files they touch, the diff of an edit and the terminal a command ran in, the plan from `write_todos`, the session's title, and compaction notices (`compaction_update`, a notice or a thought, as the editor takes them).
  - Tool approvals ask with `session/request_permission`, with the diff of an edit in the question. `allow_always` and `reject_always` save the rule the request suggests as an allow or a deny rule. A plan of `plan` mode is approved in the editor ("Ready to code?"), a budget raised, and the questions of tools are asked as forms (`elicitation/create`) or answered by the next prompt.
  - Configuration options for the permission mode, the model and the reasoning effort, next to the session modes. The `/` menu lists the runtime's commands and the agent's `SKILL.md` skills.
  - `AcpClientWorkspace` is a `Workspace` over the editor: files read and written through `fs/*`, so the agent sees unsaved changes and the editor follows its edits, commands run in the editor's `terminal/*`, each as the editor advertised it, everything else and every path check on the session's directory. The MCP servers the editor gives a session connect through `MCPClient`.
  - `AcpAgentProvider` runs an external ACP agent as a session provider: a command it launches (`resolveAcpAgent()` knows `claude`, `codex`, `gemini`, `registry:<id>` and command lines) or an `AgentApp` in the process. Each thread is a session of the agent, kept across launches. Its `session/update` stream becomes stream events, so app-server clients see its turns as any other. Every `session/request_permission` is decided by `resolvePermission` in the thread's mode, a command as `run_command`, an edit as `edit_file`, its own tools as `acp__<agent>__<tool>`, and what would ask goes to the client of the turn. Its file and terminal requests are served from the provider's workspace with the same checks.
  - `registry/cogitator/` holds the card of `cogitator acp` for the ACP registry, ready to submit.

  App-server:

  - `SessionHost` takes `providers`, agents that run outside the runtime (`SessionProvider`), next to `agents`. `initialize` lists them with `external: true`. The host keeps their threads, messages and turns, their threads cannot be forked, rewound or reviewed and their turns take no steering.
  - `startTurn()` takes `run`: the workspace, reasoning and middleware of the turn, an agent made from the thread's, and listeners of the todo list and the tool results. `runOptions` passes options to every run, `updateThread()`, `getThread()` and `deleteThread()` are new.
  - `approval/request` offers `reject_always`, and a decision of a paused turn takes `remember` on a rejection too.

  CLI:

  - `cogitator acp` serves the `coding` harness agent to the editor that launches it, on the model of `-m`, the config or a local Ollama, the sessions in the session store. `--models` adds models a session may pick, `--trust` trusts the project, so its own definitions and allow rules apply and "always" answers are saved to `.cogitator/settings.local.json`. It starts without a model too, and `authenticate` then says how to set one up.
  - `cogitator app-server --acp-agent <spec...>` serves external ACP agents next to the agent.

  Runtime:

  - An approval that rejects with `remember` ("always reject") saves the suggested rule as a deny rule, for the session or to a settings file as "always allow" does, and the decision event says so with `remembered.behavior`. `addPermissionRule()` writes allow and deny rules, `skillLoadersOf()` is exported.

### Patch Changes

- Updated dependencies [[`ac89cec`](https://github.com/cogitator-ai/Cogitator-AI/commit/ac89cec9ea8d288afd58f7dbbe1531f8425d757a)]:
  - @cogitator-ai/app-server@0.3.0
  - @cogitator-ai/core@0.77.0
  - @cogitator-ai/types@0.88.0
  - @cogitator-ai/mcp@19.9.1
  - @cogitator-ai/server-shared@0.16.2
