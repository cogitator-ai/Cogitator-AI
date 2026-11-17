/**
 * The agent bridge as tools of an agent: what `cogitator bridge mcp` serves to Claude Code and
 * Codex, and what an agent of your own gets to take part.
 *
 * @example
 * ```ts
 * import { MCPServer } from '@cogitator-ai/mcp/server';
 * import { bridgePaths } from '@cogitator-ai/bridge';
 * import { BRIDGE_INSTRUCTIONS, bridgeTools } from '@cogitator-ai/bridge/tools';
 *
 * const server = new MCPServer({
 *   name: 'cogitator-bridge',
 *   version: '1.0.0',
 *   transport: 'stdio',
 *   instructions: BRIDGE_INSTRUCTIONS,
 * });
 * server.registerTools(bridgeTools({ socketPath: bridgePaths().socket }));
 * await server.start();
 * ```
 */
export { bridgeTools } from './tools.js';
export type { BridgeToolsOptions } from './tools.js';
export { TOOL_CALL_HINT_KEY, callerOfToolCall, withoutToolCallHint } from './caller.js';
export type { ToolCallHint, ToolCallOrigin } from './caller.js';
export {
  BRIDGE_INSTRUCTIONS,
  BRIDGE_NOTES_END,
  BRIDGE_NOTES_START,
  bridgeNotes,
  hasBridgeNotes,
  withBridgeNotes,
  withoutBridgeNotes,
} from './guidance.js';
export type { BridgeNotesOptions } from './guidance.js';
