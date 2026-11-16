import {
  PermissionRuleSet,
  loadPermissionSettings,
  resolvePermission,
  tool,
} from '@cogitator-ai/core';
import {
  PERMISSION_MODES,
  type PermissionMode,
  type PermissionSettingsOptions,
  type Tool,
} from '@cogitator-ai/types';
import { z } from 'zod';
import { canonicalPath } from '../paths.js';
import type { RightsJudge } from '../person.js';
import type { PermissionAsk } from '../types.js';

export interface SettingsRightsOptions {
  /**
   * Which settings files are read, as `loadPermissionSettings` takes them. The project root is
   * always the project of the job
   */
  settings?: Omit<PermissionSettingsOptions, 'root'>;
  /**
   * The mode of an agent that told the bridge none. Default: `defaultMode` of the settings, else
   * `default`
   */
  mode?: PermissionMode;
}

const COMMAND = tool({
  name: 'run_command',
  description: 'A command an agent asks leave to run',
  parameters: z.object({ command: z.string(), cwd: z.string().optional() }),
  requiresApproval: true,
  access: { kind: 'command', command: ({ command }) => command, cwd: ({ cwd }) => cwd },
  execute: async () => null,
});

const READ = tool({
  name: 'read_file',
  description: 'Files an agent asks leave to read',
  parameters: z.object({ paths: z.array(z.string()) }),
  annotations: { readOnlyHint: true },
  access: { kind: 'read', paths: ({ paths }) => paths },
  execute: async () => null,
});

const EDIT = tool({
  name: 'edit_file',
  description: 'Files an agent asks leave to change',
  parameters: z.object({ paths: z.array(z.string()) }),
  access: { kind: 'edit', paths: ({ paths }) => paths },
  execute: async () => null,
});

const FETCH = tool({
  name: 'web_fetch',
  description: 'An address an agent asks leave to fetch',
  parameters: z.object({ url: z.string() }),
  annotations: { readOnlyHint: true },
  access: { kind: 'fetch', url: ({ url }) => url },
  execute: async () => null,
});

const NAMED = new Map<string, Tool>();

/** A tool known only by its name: nothing but a rule that names it allows its call. */
function named(name: string): Tool {
  const ruleName = name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'tool';
  let found = NAMED.get(ruleName);
  if (!found) {
    const mcp = /^mcp__([^_](?:.*?[^_])?)__(.+)$/.exec(ruleName);
    found = tool({
      name: ruleName,
      description: 'A call an agent asks leave to make',
      parameters: z.looseObject({}),
      requiresApproval: true,
      ...(mcp && { mcp: { server: mcp[1], tool: mcp[2] } }),
      execute: async () => null,
    });
    NAMED.set(ruleName, found);
  }
  return found;
}

interface Subject {
  tool: Tool;
  args: Record<string, unknown>;
  needsApproval: boolean;
}

/**
 * The call as a call of a tool the permission rules know: a command for `Bash(...)` rules, files
 * for `Read(...)` and `Edit(...)`, an address for `WebFetch(...)`. A call that does not say
 * what it touches is judged by the name of its tool alone, and so asks unless a rule names it.
 * Files are named by their real paths, so a rule holds for a file however the call reached it.
 */
function subjectOf(ask: PermissionAsk): Subject {
  const paths = (ask.paths ?? []).map(canonicalPath);
  if (ask.access === 'command' && ask.command) {
    return {
      tool: COMMAND,
      args: { command: ask.command, ...(ask.cwd && { cwd: canonicalPath(ask.cwd) }) },
      needsApproval: true,
    };
  }
  if (ask.access === 'read' && paths.length > 0) {
    return { tool: READ, args: { paths }, needsApproval: false };
  }
  if (ask.access === 'edit' && paths.length > 0) {
    return { tool: EDIT, args: { paths }, needsApproval: false };
  }
  if (ask.access === 'fetch' && ask.url) {
    return { tool: FETCH, args: { url: ask.url }, needsApproval: false };
  }
  return { tool: named(ask.tool), args: {}, needsApproval: true };
}

/**
 * A judge of permission requests that reads the rights of the agent that handed a job over from
 * the permission settings of the job's project: the `.claude/` and `.cogitator/` files of the
 * project, of the person and of the machine, the ones Claude Code and Cogitator's own agents
 * obey there. The mode is the one the agent told the bridge it runs in.
 *
 * A call those rules allow is the agent's own to allow, one they forbid is forbidden to the
 * agent it handed the job to as well, and anything they would ask a person about is the
 * person's.
 *
 * @example
 * ```ts
 * import { hostBridge } from '@cogitator-ai/bridge';
 * import { settingsRights } from '@cogitator-ai/bridge/rights';
 *
 * const host = await hostBridge({ rights: settingsRights() });
 * ```
 */
export function settingsRights(options: SettingsRightsOptions = {}): RightsJudge {
  return async ({ job, delegator, ask }) => {
    const loaded = await loadPermissionSettings(job.project, options.settings);
    const rules = new PermissionRuleSet(loaded.layers);
    const told = PERMISSION_MODES.find((mode) => mode === delegator?.permissionMode);
    const wanted = told ?? options.mode ?? rules.defaultMode() ?? 'default';
    const subject = subjectOf(ask);
    const decision = await resolvePermission(subject.tool, subject.args, {
      mode: wanted === 'auto' || rules.disables(wanted) ? 'default' : wanted,
      rules,
      needsApproval: subject.needsApproval,
      cwd: canonicalPath(delegator?.cwd ?? job.cwd),
      projectRoot: canonicalPath(job.project),
    });
    return decision.decision;
  };
}
