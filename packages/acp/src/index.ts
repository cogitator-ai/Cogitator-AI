/**
 * The Agent Client Protocol for Cogitator, both ways: `AcpAgent` serves the agents of an
 * app-server `SessionHost` to editors (Zed, JetBrains, Neovim, VS Code), and `AcpAgentProvider`
 * runs external ACP agents (Claude Code, Codex, Gemini CLI) as session providers of a host, their
 * permission requests decided by the runtime's permission engine.
 *
 * @packageDocumentation
 */

export {
  ACP_THREAD_KEYS,
  AcpAgent,
  COGITATOR_AUTH_METHOD,
  createAcpAgent,
  sessionNotFound,
  type AcpAgentOptions,
} from './agent/acp-agent.js';
export {
  AcpClientWorkspace,
  DEFAULT_TERMINAL_OUTPUT_BYTES,
  DEFAULT_TERMINAL_TIMEOUT,
  type AcpClientWorkspaceOptions,
} from './agent/client-workspace.js';
export { expandSkill, sessionCommands, skillsOf, type SessionCommands } from './agent/commands.js';
export {
  ACP_CONFIG_IDS,
  DEFAULT_ACP_EFFORTS,
  DEFAULT_ACP_MODES,
  applyConfigOption,
  configOptions,
  modeState,
  type SessionEffort,
  type SessionSettings,
  type SettingChoices,
} from './agent/config.js';
export { connectMcpServers, mcpServerConfigs } from './agent/mcp-servers.js';
export { inputText, titleOf, toUserInput, uriPath } from './agent/prompt.js';
export { nodeNdJsonStream, serveAcpStdio, type ServeAcpStdioOptions } from './agent/stdio.js';
export {
  MAX_RESULT_TEXT,
  diffOfToolCall,
  kindOf,
  resultContent,
  viewOfToolCall,
  type ToolCallView,
} from './agent/tool-calls.js';
export {
  TurnUpdates,
  planOf,
  type PendingUpdate,
  type TurnFinish,
  type TurnUpdatesOptions,
} from './agent/updates.js';
export {
  ACP_AGENT_SESSION_KEY,
  AcpAgentProvider,
  sliceLines,
  type AcpAgentProviderOptions,
  type AcpAgentTarget,
} from './client/provider.js';
export {
  AcpPermissions,
  commandLine,
  envOf,
  commandOf,
  pathsOf,
  shellQuote,
  subjectOf,
  type AcpCallSubject,
  type AcpPermissionOptions,
} from './client/permissions.js';
export {
  ACP_AGENT_PRESETS,
  ACP_REGISTRY_URL,
  AcpRegistryAgentSchema,
  fetchAcpRegistry,
  launchOfRegistryAgent,
  resolveAcpAgent,
  splitCommand,
  type AcpLaunch,
  type AcpRegistryAgent,
} from './client/registry.js';
export {
  AcpTerminals,
  DEFAULT_AGENT_TERMINAL_OUTPUT_BYTES,
  DEFAULT_AGENT_TERMINAL_TIMEOUT,
  keepLast,
} from './client/terminals.js';
export { AcpStreamMapper, contentText } from './client/updates.js';
