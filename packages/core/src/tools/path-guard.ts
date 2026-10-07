import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { Tool, ToolContext } from '@cogitator-ai/types';
import { tool } from '../tool';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether `path` lies inside one of `roots` once symlinks are followed, so a
 * link inside a root that points outside of it does not count as inside.
 */
export async function isPathAllowed(path: string, roots: readonly string[]): Promise<boolean> {
  const target = await resolveReal(resolve(path));
  for (const root of roots) {
    if (isWithin(await resolveReal(resolve(root)), target)) return true;
  }
  return false;
}

/** The approval of a wrapped tool: required when asked for, else whatever the original asks. */
function approvalOf(
  original: Tool,
  required: boolean
): boolean | ((params: unknown) => boolean) | undefined {
  if (required) return true;
  const own = original.requiresApproval;
  if (typeof own === 'function') return (params) => isRecord(params) && own(params);
  return own;
}

export interface RestrictFileToolsOptions {
  /**
   * The directory relative paths are resolved against, and the path the
   * wrapped tool receives is made absolute. Without it, relative paths are
   * resolved against the working directory of the process.
   */
  base?: string;
  /**
   * Which tools must be approved before they run, on top of the tools that
   * require approval themselves, for example the ones that write.
   */
  requireApproval?: (tool: Tool) => boolean;
}

/**
 * File tools that only reach paths inside `roots`: each wrapped tool checks the
 * `path` argument and answers with an error instead of running when it points
 * elsewhere. The wrapper keeps the original's side effects, approval and
 * timeout.
 */
export function restrictFileTools(
  tools: readonly Tool[],
  roots: readonly string[],
  options: RestrictFileToolsOptions = {}
): Tool[] {
  const allowedList = roots.join(', ');
  const base = options.base ? resolve(options.base) : undefined;

  return tools.map((original) => {
    const approval = approvalOf(original, options.requireApproval?.(original) ?? false);
    return tool({
      name: original.name,
      description: `${original.description} Only paths inside: ${allowedList}${base ? `, relative to ${base}` : ''}.`,
      parameters: original.parameters,
      ...(original.category && { category: original.category }),
      ...(original.tags && { tags: original.tags }),
      ...(original.sideEffects && { sideEffects: original.sideEffects }),
      ...(approval !== undefined && { requiresApproval: approval }),
      ...(original.timeout !== undefined && { timeout: original.timeout }),
      execute: async (params: unknown, context: ToolContext) => {
        const given = isRecord(params) && typeof params.path === 'string' ? params.path : null;
        if (given === null) {
          return { error: 'Access denied: the call has no path' };
        }
        const path = base && !isAbsolute(given) ? resolve(base, given) : given;
        if (!(await isPathAllowed(path, roots))) {
          return {
            error: `Access denied: ${given} is outside the allowed paths (${allowedList})`,
          };
        }
        return original.execute(isRecord(params) ? { ...params, path } : params, context);
      },
    });
  });
}
