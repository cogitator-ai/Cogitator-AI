---
'@cogitator-ai/types': minor
'@cogitator-ai/core': minor
'@cogitator-ai/mcp': minor
'@cogitator-ai/evals': minor
'@cogitator-ai/cli': minor
'@cogitator-ai/studio': minor
'@cogitator-ai/config': minor
---

Plugins, experimental: a plugin written for Claude Code loads unchanged, a Cogitator manifest adds code that runs in a process of its own under a permissions manifest, plugins reload by generation and install from marketplaces, npm and git, pinned.

Every new entry point carries the `experimental_` prefix and is listed in `docs/EXPERIMENTAL_API.md`. Without `experimental_plugins` a runtime behaves as before: only the core's own plugin loads, which registers the built-in LLM providers.

Plugins (types, core, config):

- `CogitatorConfig.experimental_plugins` (`PluginsConfig`): plugins in code (`plugins`, made with `experimental_definePlugin`), plugin folders loaded in place (`dirs`, ids `name@inline`), the installed plugins (`installed`, default `~/.cogitator/plugins` or `COGITATOR_PLUGINS_DIR`), where settings are read (`settings`), `enabled` and `options` in code, the MCP connector (`mcp`), a secret store (`secrets`), host `permissions.deny`, `isolation` limits and `watch`. The config package reads the parts a file can hold.
- Claude Code's format: `.claude-plugin/plugin.json` (or none), `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json`, the manifest's component keys with their replace, add and merge rules, path checks (`./`, existence, containment), strict `userConfig` options, marketplace entries with `strict` mode, `dependencies`, `defaultEnabled`. Components are named as there: skills `plugin:skill`, subagents `plugin:folder:name`, commands `/plugin:name`, MCP servers `plugin:<plugin>:<server>` with tools `mcp__plugin_<plugin>_<server>__<tool>`. `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` (with `COGITATOR_` names), `${CLAUDE_PROJECT_DIR}` and `${user_config.KEY}` are put into hooks, MCP configs and text, a secret only where a process needs it, and hooks get `CLAUDE_PLUGIN_OPTION_<KEY>`. `.cogitator-plugin/plugin.json` adds `main`, `permissions`, `ui.panels` and `engines.cogitator`. `experimental_validatePlugin` checks a folder as `claude plugin validate` does.
- What plugins add reaches every run: tools after the runtime's own, skills (every agent gets them), subagents and commands (the subagent and command services are on once plugins are configured), hooks in a layer per plugin under the managed hook policies, MCP servers, LLM backends, middleware and Studio panels. A run takes them when it starts.
- `PluginContext`: one API for the core's plugin, the host's plugins and third-party ones. `registerTool` (a `tool()` or a JSON Schema spec), `registerSkill`, `registerAgent`, `registerCommand`, `registerHooks`, `registerMcpServer`, `registerLLMBackend`, `registerMiddleware`, `registerPanel`, `onDispose`, each returning its disposer, plus `options`, `secret()`, `files`, `fetch`, `exec`, `logger` and `signal`.
- Options and secrets: `userConfig` values from `pluginConfigs` of the settings, `sensitive` ones from the operating system's credential store (`experimental_keychainSecretStore`: `security` on macOS, `secret-tool` on Linux, PowerShell with the Credential Manager on Windows, the secret on standard input). Without one a secret fails with `SECRET_STORE_UNAVAILABLE`, never a plain file. `experimental_memorySecretStore` for servers that bring their own vault.
- Enabling: `enabledPlugins` of the settings layers (managed over code over local, project and user, a project's files once trusted), else `defaultEnabled`, dependencies enabled with what needs them.
- Lifecycle: `cog.experimental_plugins` (`experimental_PluginHost`) loads plugins in the order of their dependencies, with `list()`, `get()`, `reload()`, `setEnabled()`, `snapshot()`, `onChange()` and `dispose()`. Registrations unload in reverse order, a reload builds a new generation and swaps it in only once it loaded in full, a failed one keeps the old (`code: 'PLUGIN_RELOAD_FAILED'`), `watch` reloads a changed folder. Missing, disabled or out-of-range dependencies block with `PLUGIN_DEPENDENCY_UNMET`, cycles with `PLUGIN_DEPENDENCY_CYCLE`.
- Isolation: plugin code from a folder runs in a child process under Node's permission model, reading its folder and writing its data folder only, without processes, workers, addons or network. What it asks of the host goes through the permission engine against its `permissions` (`Read`, `Edit`, `Bash`, `WebFetch` rules), refused with `PLUGIN_PERMISSION_DENIED`, and the hooks and MCP servers of a plugin with `permissions` are checked against them too. Plugins in the host's code get the same checks.
- Installing: `experimental_PluginInstaller` adds marketplaces (Claude Code's `marketplace.json` from GitHub, git, an https URL, a folder or a file, `extraKnownMarketplaces` of the settings) and installs from them or straight from npm and git, with every plugin source type of Claude Code (relative path, `github`, `url`, `git-subdir`, `npm`, `archive`, `command`). Installs are pinned to the commit, the npm version and integrity or the archive digest, a plugin's permissions are agreed to at install, dependencies resolve against `<name>--v<version>` tags, and updates follow Claude Code's version rule. Downloads go over https only and never to loopback, link-local or metadata hosts.
- New error codes: `PLUGIN_NOT_FOUND`, `PLUGIN_INVALID`, `PLUGIN_ACTIVATION_FAILED`, `PLUGIN_DEPENDENCY_CYCLE`, `PLUGIN_DEPENDENCY_UNMET`, `PLUGIN_PERMISSION_DENIED`, `PLUGIN_RELOAD_FAILED`, `PLUGIN_INSTALL_FAILED`, `SECRET_STORE_UNAVAILABLE`.

MCP: `experimental_mcpConnector()` connects `.mcp.json` servers (stdio, HTTP, SSE) for `experimental_plugins.mcp` and `subagents.mcp`, tools named `mcp__<server>__<tool>`.

Evals: `experimental_runPluginEvals()` runs a plugin's eval suite in the format of `claude plugin eval` (`evals/<case>/prompt.md`, `case.yaml`, the `regex`, `tool_used`, `tool_order`, `file_exists`, `llm` and `baseline` graders, fixed MCP mocks), with and without the plugin, and writes `aggregate-result.json` (`schemaVersion: 1`) and a self-contained `report.html`.

CLI: `cogitator plugin install | uninstall | enable | disable | update | list | configure | validate | eval` and `cogitator plugin marketplace add | list | remove | update`, with `--json` results and Claude Code's exit codes. `cogitator run` connects the MCP servers of plugins of its config.

Studio: a Plugins page with each plugin's status, generation, contributions, permissions and diagnostics, Reload and Enable or Disable, and plugin panels in a sandboxed frame without network, which talk to their plugin through `postMessage`.

Breaking changes and migration:

- `ToolRegistry.register()`, `ToolRegistry.registerMany()` and `registerLLMBackend()` return a disposer instead of `void`. Code that calls them is unaffected, a class that overrides `register` returns the disposer too.
- `LLMPlugin`, `LLMPluginMetadata` and `LLMBackendFactory` moved to `@cogitator-ai/types`. `@cogitator-ai/core` still exports them.
- The built-in providers are created through the core's plugin. `llm.backends` still wins over them, and a provider registered globally with `registerLLMBackend` under a built-in name is still not used for that name.
- `DefinitionSource` has a new value `plugin`, and `SubagentDefinition`, `CommandDefinition` and `ExpandedCommand` a `plugin` field: a `switch` over the source that must be exhaustive needs the case.
- `ErrorCode` has the new members above: a `Record<ErrorCode, ...>` of your own needs entries for them.
- A command file's `argument-hint` written as a YAML list (`argument-hint: [env]`) is read as `[env]` instead of being dropped with a warning.
- `agentMemoryDir` accepts names with `:` parts, kept in the folder `part.part`.
