import { AGENT_NAME_ENV, HARNESS_ENV, SESSION_NAME_ENV } from '../registry.js';

/**
 * The name the bridge's server of tools goes by in the harnesses. It is part of how a session
 * names the tools (`mcp__bridge__delegate` in Claude Code), and what hooks and permission rules
 * match them by.
 */
export const BRIDGE_TOOLS_SERVER = 'bridge';

/** How a harness starts the bridge's server of tools: a command and its arguments, no shell. */
export interface ToolsServerCommand {
  command: string;
  args: readonly string[];
}

/**
 * What the server of tools of a session the bridge started finds in its environment: the
 * harness and the name the bridge gave the session, so its first call is recognized.
 */
export function toolsServerEnv(session: {
  harness: string;
  agentName: string;
  sessionName?: string;
}): Record<string, string> {
  return {
    [HARNESS_ENV]: session.harness,
    [AGENT_NAME_ENV]: session.agentName,
    ...(session.sessionName && { [SESSION_NAME_ENV]: session.sessionName }),
  };
}
