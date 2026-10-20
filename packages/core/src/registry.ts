import type { Tool, ToolSchema } from '@cogitator-ai/types';
import { toolToSchema } from './tool';
import { toToolParameters } from './tool-schema';
import { getLogger } from './logger';
import { toolResultLengthError } from './tool-content';

export interface ToolRegisterOptions {
  /** Replace a tool registered under the same name without a warning */
  replace?: boolean;
}

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
   * Register a single tool in the registry. A tool with the same name is replaced, with a
   * warning when it is a different tool: the model can only ever call one of them, so a clash
   * is usually a mistake. Pass `{ replace: true }` when replacing it is the intent. A tool built
   * without `tool()` whose `maxResultLength` is not a positive integer throws.
   *
   * @param tool - Tool to register
   * @param options - `replace: true` replaces a tool of the same name without a warning
   */
  register(tool: Tool, options?: ToolRegisterOptions): void {
    const lengthError = toolResultLengthError(
      tool.maxResultLength,
      `maxResultLength of tool "${tool.name}"`
    );
    if (lengthError) throw new TypeError(lengthError);
    const existing = this.tools.get(tool.name);
    if (existing && existing !== tool && !options?.replace) {
      getLogger().warn(
        `Tool "${tool.name}" replaces another tool registered under the same name, so the model can only call the later one. Give them distinct names (for MCP tools, a namePrefix per server), or register with { replace: true } to replace it on purpose.`,
        { tool: tool.name }
      );
    }
    this.tools.set(tool.name, tool);
  }

  /**
   * Register multiple tools at once, each as `register` does: a different tool of the same name,
   * earlier in the list or already registered, is replaced with a warning.
   *
   * @param tools - Array of tools to register
   * @param options - `replace: true` replaces tools of the same name without a warning
   */
  registerMany(tools: Tool[], options?: ToolRegisterOptions): void {
    for (const tool of tools) this.register(tool, options);
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
