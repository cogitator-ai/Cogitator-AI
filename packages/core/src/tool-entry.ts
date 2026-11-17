/**
 * Defining tools, without the runtime: `tool()` and the helpers for tool names, schemas and
 * results, the same ones the package root exports. A process that only declares tools, such as
 * an MCP server, imports this entry and does not load the agents, the LLM backends or their
 * SDKs.
 *
 * @example
 * ```ts
 * import { tool } from '@cogitator-ai/core/tool';
 * import { z } from 'zod';
 *
 * export const add = tool({
 *   name: 'add',
 *   description: 'Add two numbers',
 *   parameters: z.object({ a: z.number(), b: z.number() }),
 *   execute: async ({ a, b }) => a + b,
 * });
 * ```
 */
export { tool, toolset, toolToSchema, withParsedArguments } from './tool';
export { toToolParameters } from './tool-schema';
export {
  TOOL_NAME_MAX_LENGTH,
  assertToolName,
  isProviderSafeToolName,
  normalizeToolName,
  normalizeToolNames,
} from './tool-name';
export {
  toolContent,
  toolOutput,
  isToolContentResult,
  isToolOutputResult,
  toolOutputContent,
  toolResultParts,
  toolPartsToMessageContent,
  toolPartsToText,
  truncateToolResultText,
  DEFAULT_TOOL_RESULT_MAX_LENGTH,
} from './tool-content';
