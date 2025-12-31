/**
 * Tool Registry for managing tools
 */

import type { Tool, ToolSchema } from '@cogitator-ai/types';
import { toolToSchema } from './tool';

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  registerMany(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  getSchemas(): ToolSchema[] {
    return this.getAll().map(toolToSchema);
  }

  clear(): void {
    this.tools.clear();
  }
}
