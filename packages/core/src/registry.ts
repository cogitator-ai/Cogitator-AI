import type { Tool, ToolSchema } from '@cogitator-ai/types';
import { toolToSchema } from './tool';
import { toToolParameters } from './tool-schema';
import { getLogger } from './logger';

/**
 * Registry for managing and organizing tools available to agents.
 *
 * ToolRegistry provides a centralized store for tools with
 * lookup, registration, and schema generation capabilities.
 *
 * @example
 * ```ts
 * import { ToolRegistry, tool } from '@cogitator-ai/core';
 * import { z } from 'zod';
 *
 * const registry = new ToolRegistry();
 *
 * registry.register(tool({
 *   name: 'calculator',
 *   description: 'Perform math operations',
 *   parameters: z.object({ expression: z.string() }),
 *   execute: async ({ expression }) => eval(expression),
 * }));
 *
 * const schemas = registry.getSchemas(); // For LLM function calling
 * const calc = registry.get('calculator'); // Get tool by name
 * ```
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  /**
   * Register a single tool in the registry.
   * If a tool with the same name exists, it will be replaced.
   *
   * @param tool - Tool to register
   */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Register multiple tools at once. When two different tools in the list share a name, the
   * later one wins, as with `register`, and a warning names the clash: the model could only
   * ever call one of them.
   *
   * @param tools - Array of tools to register
   */
  registerMany(tools: Tool[]): void {
    const seen = new Map<string, Tool>();
    for (const tool of tools) {
      const earlier = seen.get(tool.name);
      if (earlier && earlier !== tool) {
        getLogger().warn(
          `Two tools are named "${tool.name}"; only the later one is available to the model. Give them distinct names (for MCP tools, a namePrefix per server).`,
          { tool: tool.name }
        );
      }
      seen.set(tool.name, tool);
      this.register(tool);
    }
  }

  /**
   * Get a tool by its name.
   *
   * @param name - Name of the tool to retrieve
   * @returns The tool if found, undefined otherwise
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Check if a tool with the given name exists in the registry.
   *
   * @param name - Name of the tool to check
   * @returns true if the tool exists
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get all registered tools.
   *
   * @returns Array of all tools in the registry
   */
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get JSON schemas for all tools (for LLM function calling): each tool's own `toJSON()`, so
   * tools that carry a JSON Schema of their own (MCP, AI SDK) keep it, made self-contained by
   * `toToolParameters`.
   *
   * @returns Array of tool schemas in OpenAPI format
   */
  getSchemas(): ToolSchema[] {
    return this.getAll().map((tool) => {
      if (typeof tool.toJSON !== 'function') return toolToSchema(tool);
      const schema = tool.toJSON();
      return { ...schema, parameters: toToolParameters(schema.parameters) };
    });
  }

  /**
   * Get names of all registered tools.
   *
   * @returns Array of tool names
   */
  getNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Remove all tools from the registry.
   */
  clear(): void {
    this.tools.clear();
  }
}
