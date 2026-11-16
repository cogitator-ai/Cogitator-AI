import { dirname, resolve } from 'node:path';
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
import { canonicalPath, isInside } from '../paths.js';
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

/**
 * What the runtime calls a tool a harness names its own way. A rule that names the tool itself,
 * such as a `Write` or a `Grep` that is denied, holds for a call that names it so
 */
const RUNTIME_NAMES: Readonly<Record<string, string>> = {
  Bash: 'run_command',
  Read: 'read_file',
  Edit: 'edit_file',
  MultiEdit: 'edit_file',
  NotebookEdit: 'edit_file',
  Write: 'write_file',
  Glob: 'glob',
  Grep: 'grep',
  LS: 'list_files',
  WebFetch: 'web_fetch',
};

const TOOLS = new Map<string, Tool>();

/** A name a permission rule can hold, from what a harness calls its tool. */
function ruleName(name: string): string {
  const known = RUNTIME_NAMES[name];
  if (known) return known;
  return name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'tool';
}

/**
 * The tool of a call as the permission engine knows tools: by its name, and by what it touches.
 * One that says nothing of what it touches is known by its name alone, and needs approval.
 */
function toolOf(name: string, access: PermissionAsk['access'] | 'named'): Tool {
  const key = `${access}:${name}`;
  const known = TOOLS.get(key);
  if (known) return known;
  const base = { name, description: 'A call an agent asks leave for', execute: async () => null };
  const mcp = /^mcp__([^_](?:.*?[^_])?)__(.+)$/.exec(name);
  const made =
    access === 'command'
      ? tool({
          ...base,
          parameters: z.object({ command: z.string(), cwd: z.string().optional() }),
          requiresApproval: true,
          access: { kind: 'command', command: ({ command }) => command, cwd: ({ cwd }) => cwd },
        })
      : access === 'read'
        ? tool({
            ...base,
            parameters: z.object({ paths: z.array(z.string()) }),
            annotations: { readOnlyHint: true },
            access: { kind: 'read', paths: ({ paths }) => paths },
          })
        : access === 'edit'
          ? tool({
              ...base,
              parameters: z.object({ paths: z.array(z.string()) }),
              access: { kind: 'edit', paths: ({ paths }) => paths },
            })
          : access === 'fetch'
            ? tool({
                ...base,
                parameters: z.object({ url: z.string() }),
                annotations: { readOnlyHint: true },
                access: { kind: 'fetch', url: ({ url }) => url },
              })
            : tool({
                ...base,
                parameters: z.looseObject({}),
                requiresApproval: true,
                ...(mcp && { mcp: { server: mcp[1], tool: mcp[2] } }),
              });
  TOOLS.set(key, made);
  return made;
}

interface Subject {
  tool: Tool;
  args: Record<string, unknown>;
  needsApproval: boolean;
}

interface Place {
  /** The project of the job, by its real path */
  project: string;
  /** The folder of the job, where a command runs that names none */
  cwd: string;
  /** Folders outside the project the rules open to the agent */
  open: readonly string[];
}

/**
 * The call as a call of a tool the permission rules know: a command for `Bash(...)` rules, files
 * for `Read(...)` and `Edit(...)`, an address for `WebFetch(...)`, under the name the rules know
 * its tool by. Files keep the paths the call named: the engine looks at each as named and as
 * it really lies, so a rule holds whichever way the call reached the file. What needs a
 * person's word without any rule is what a person at a session would be asked: a command, an
 * address, a file outside the project. A call that does not say what it touches is judged by
 * the name of its tool alone.
 */
function subjectOf(ask: PermissionAsk, place: Place): Subject {
  const name = ruleName(ask.tool);
  const paths = (ask.paths ?? []).map((path) => resolve(path));
  if (ask.access === 'command' && ask.command) {
    return {
      tool: toolOf(name, 'command'),
      args: { command: ask.command, cwd: canonicalPath(ask.cwd ?? place.cwd) },
      needsApproval: true,
    };
  }
  if (ask.access === 'read' && paths.length > 0) {
    const within = [place.project, ...place.open];
    const outside = paths.some((path) => !within.some((dir) => isInside(dir, canonicalPath(path))));
    return { tool: toolOf(name, 'read'), args: { paths }, needsApproval: outside };
  }
  if (ask.access === 'edit' && paths.length > 0) {
    return { tool: toolOf(name, 'edit'), args: { paths }, needsApproval: false };
  }
  if (ask.access === 'fetch' && ask.url) {
    return { tool: toolOf(name, 'fetch'), args: { url: ask.url }, needsApproval: true };
  }
  return { tool: toolOf(name, 'named'), args: {}, needsApproval: true };
}

/**
 * A judge of permission requests that reads the rights of the agent that handed a job over from
 * the permission settings of the job's project: the `.claude/` and `.cogitator/` files of the
 * project, of the person and of the machine, the ones Claude Code and Cogitator's own agents
 * obey there. The mode is the one the agent told the bridge it runs in.
 *
 * A call those rules allow is the agent's own to allow, one they forbid is forbidden to the
 * agent it handed the job to as well, and anything they would ask a person about is the
 * person's. A change to one of the settings files themselves is never the agent's to allow,
 * whatever the rules and the mode say: an agent must not write the rules it is judged by.
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
    const project = canonicalPath(job.project);
    const subject = subjectOf(ask, {
      project,
      cwd: job.cwd,
      open: rules.additionalDirectories.map(canonicalPath),
    });
    const { decision } = await resolvePermission(subject.tool, subject.args, {
      mode: wanted === 'auto' || rules.disables(wanted) ? 'default' : wanted,
      rules,
      needsApproval: subject.needsApproval,
      cwd: canonicalPath(delegator?.cwd ?? job.cwd),
      projectRoot: project,
    });
    if (decision !== 'allow' || ask.access !== 'edit') return decision;
    const settings = [...loaded.files.keys()].map((file) => canonicalPath(dirname(file)));
    const rewritesRules = (ask.paths ?? []).some((path) =>
      settings.some((dir) => isInside(dir, canonicalPath(path)))
    );
    return rewritesRules ? 'ask' : decision;
  };
}
