import { mkdirSync, writeFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { tool } from '../tool';
import type { Tool } from '@cogitator-ai/types';

async function importFresh(filePath: string): Promise<unknown> {
  const url = pathToFileURL(filePath).href + `?t=${Date.now()}`;
  return import(/* webpackIgnore: true */ url);
}

function validateToolShape(mod: unknown): { valid: boolean; error?: string } {
  const m = mod as Record<string, unknown>;
  const t = m?.default as Record<string, unknown> | undefined;
  if (!t) return { valid: false, error: 'File must have a default export' };
  if (typeof t.name !== 'string') return { valid: false, error: 'Tool must have a string "name"' };
  if (typeof t.description !== 'string')
    return { valid: false, error: 'Tool must have a string "description"' };
  if (typeof t.execute !== 'function')
    return { valid: false, error: 'Tool must have an "execute" function' };
  return { valid: true };
}

export async function loadCustomTools(toolsDir: string): Promise<Tool[]> {
  if (!existsSync(toolsDir)) return [];

  const files = readdirSync(toolsDir).filter((f) => f.endsWith('.mjs'));
  const tools: Tool[] = [];

  for (const file of files) {
    try {
      const mod = await importFresh(join(toolsDir, file));
      const check = validateToolShape(mod);
      if (check.valid) {
        const t = (mod as { default: Tool }).default;
        tools.push(t);
      } else {
        console.warn(`[SelfTools] Skipping ${file}: ${check.error}`);
      }
    } catch (err) {
      console.warn(
        `[SelfTools] Failed to load ${file}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  return tools;
}

export function createSelfTools(opts: { toolsDir: string; onToolsChanged?: () => void }): Tool[] {
  const { toolsDir, onToolsChanged } = opts;

  const createToolTool = tool({
    name: 'create_tool',
    description: `Create a custom tool by writing JavaScript code. The code must be an ES module (.mjs) with a default export containing: name (string), description (string), parameters (JSON Schema object), and execute (async function). Tools have full Node.js access including fetch, fs, child_process, etc. Example:

export default {
  name: 'my_tool',
  description: 'Does something useful',
  parameters: {
    type: 'object',
    properties: { input: { type: 'string' } },
    required: ['input']
  },
  execute: async ({ input }) => {
    return { result: input.toUpperCase() };
  }
};`,
    parameters: z.object({
      name: z.string().describe('Tool name (used as filename)'),
      code: z.string().describe('JavaScript ESM code for the tool'),
    }),
    execute: async ({ name, code }) => {
      mkdirSync(toolsDir, { recursive: true });
      const filePath = join(toolsDir, `${name}.mjs`);
      writeFileSync(filePath, code);

      try {
        const mod = await importFresh(filePath);
        const check = validateToolShape(mod);
        if (!check.valid) {
          unlinkSync(filePath);
          return { success: false, error: check.error };
        }
        onToolsChanged?.();
        return { success: true, path: filePath, message: `Tool "${name}" created and validated` };
      } catch (err) {
        const errorMsg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        unlinkSync(filePath);
        return { success: false, error: errorMsg };
      }
    },
  });

  const testToolTool = tool({
    name: 'test_tool',
    description:
      'Test a custom tool by calling its execute function with the provided parameters. Returns the result or error with stack trace for debugging.',
    parameters: z.object({
      name: z.string().describe('Tool name to test'),
      params: z.record(z.string(), z.unknown()).describe('Parameters to pass to execute()'),
    }),
    execute: async ({ name: toolName, params }) => {
      const filePath = join(toolsDir, `${toolName}.mjs`);
      if (!existsSync(filePath)) {
        return { success: false, error: `Tool "${toolName}" not found at ${filePath}` };
      }

      try {
        const mod = await importFresh(filePath);
        const t = (mod as { default: { execute: (p: unknown) => Promise<unknown> } }).default;

        const startTime = Date.now();
        const result = await t.execute(params);
        const duration = Date.now() - startTime;

        return { success: true, result, durationMs: duration };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        };
      }
    },
  });

  const listCustomToolsTool = tool({
    name: 'list_custom_tools',
    description: 'List all custom tools saved to disk',
    parameters: z.object({}),
    execute: async () => {
      if (!existsSync(toolsDir)) return { tools: [] };

      const files = readdirSync(toolsDir).filter((f) => f.endsWith('.mjs'));
      const tools: Array<{ name: string; description: string; file: string }> = [];

      for (const file of files) {
        try {
          const mod = await importFresh(join(toolsDir, file));
          const t = (mod as { default: { name: string; description: string } }).default;
          tools.push({
            name: t.name ?? basename(file, '.mjs'),
            description: t.description ?? 'No description',
            file,
          });
        } catch {
          tools.push({ name: basename(file, '.mjs'), description: '(failed to load)', file });
        }
      }

      return { tools, directory: toolsDir };
    },
  });

  const deleteToolTool = tool({
    name: 'delete_tool',
    description: 'Delete a custom tool from disk',
    parameters: z.object({
      name: z.string().describe('Tool name to delete'),
    }),
    execute: async ({ name: toolName }) => {
      const filePath = join(toolsDir, `${toolName}.mjs`);
      if (!existsSync(filePath)) {
        return { success: false, error: `Tool "${toolName}" not found` };
      }
      unlinkSync(filePath);
      onToolsChanged?.();
      return { success: true, message: `Tool "${toolName}" deleted` };
    },
  });

  return [createToolTool, testToolTool, listCustomToolsTool, deleteToolTool];
}
