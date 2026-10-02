import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tool } from '@cogitator-ai/core';
import type { Tool, ToolContext } from '@cogitator-ai/types';

async function resolveReal(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    return join(await resolveReal(parent), basename(path));
  }
}

function isWithin(root: string, target: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix);
}

function extractPath(params: unknown): string | null {
  if (typeof params !== 'object' || params === null || !('path' in params)) return null;
  const value = params.path;
  return typeof value === 'string' ? value : null;
}

export async function isPathAllowed(path: string, roots: readonly string[]): Promise<boolean> {
  const target = await resolveReal(resolve(path));
  for (const root of roots) {
    if (isWithin(await resolveReal(resolve(root)), target)) return true;
  }
  return false;
}

export function restrictFileTools(tools: readonly Tool[], roots: readonly string[]): Tool[] {
  const allowedList = roots.join(', ');
  return tools.map((original) =>
    tool({
      name: original.name,
      description: `${original.description} Only paths inside: ${allowedList}.`,
      parameters: original.parameters,
      ...(original.sideEffects ? { sideEffects: original.sideEffects } : {}),
      execute: async (params: unknown, context: ToolContext) => {
        const path = extractPath(params);
        if (path === null || !(await isPathAllowed(path, roots))) {
          return {
            error: `Access denied: ${path ?? '(missing path)'} is outside the allowed paths (${allowedList})`,
          };
        }
        return original.execute(params, context);
      },
    })
  );
}
