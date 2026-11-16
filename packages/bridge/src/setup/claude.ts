import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CLAUDE_TOOLS_PERMISSION,
  DEFAULT_HOOK_TIMEOUT_S,
  claudeToolsHook,
  claudeWaitHook,
} from '../adapters/claude.js';
import { failureOf, outsideSessionEnv, runCommand, shellQuote } from '../adapters/exec.js';
import { BRIDGE_TOOLS_SERVER, type ToolsServerCommand } from '../adapters/tools-server.js';
import { canonicalPath } from '../paths.js';
import { bridgeNotes } from '../tools/guidance.js';
import { notesStep, readSettings, readText, removeNotesStep, writeSettings } from './files.js';
import type { AdapterSetup, InstallContext, SetupContext, SetupStep } from './setup.js';

export interface ClaudeSetupOptions {
  /** How a session starts the bridge's server of tools */
  toolsServer: ToolsServerCommand;
  /** The Claude Code executable, `claude` on `PATH` by default */
  command?: string;
  /** The environment of the commands, `process.env` by default */
  env?: NodeJS.ProcessEnv;
  /** How a hook of a session runs the bridge's command line, `cogitator bridge` by default */
  bridgeCommand?: string;
  /** The folder of the bridge's files the hooks are told, when it is not the default one */
  bridgeHome?: string;
  /** Seconds a waiter may wait before Claude Code ends it, 12 hours by default */
  hookTimeoutS?: number;
  /** Where Claude Code keeps what a person configured, `.claude.json` */
  configPath?: string;
  /** Where Claude Code keeps a person's settings, `settings.json` */
  userSettingsPath?: string;
  /** Where Claude Code reads a person's instructions for every project, `CLAUDE.md` */
  userNotesPath?: string;
}

type Json = Record<string, unknown>;

const WAITS = /\bbridge\s+wait\b/;
const NAMES_CALLER = /\bbridge\s+caller\b/;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function commandsOf(groups: unknown, pattern: RegExp): string[] {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group: unknown) => {
    const hooks = isObject(group) && Array.isArray(group.hooks) ? group.hooks : [];
    return hooks.flatMap((hook: unknown) =>
      isObject(hook) && typeof hook.command === 'string' && pattern.test(hook.command)
        ? [hook.command]
        : []
    );
  });
}

/** The groups of an event without the hooks of the bridge, and without a group they emptied. */
function withoutHooks(groups: unknown, pattern: RegExp): unknown[] {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group: unknown) => {
    if (!isObject(group) || !Array.isArray(group.hooks)) return [group];
    const kept = group.hooks.filter(
      (hook: unknown) =>
        !(isObject(hook) && typeof hook.command === 'string' && pattern.test(hook.command))
    );
    if (kept.length === group.hooks.length) return [group];
    return kept.length === 0 ? [] : [{ ...group, hooks: kept }];
  });
}

/** `settings` with `key` set, or without it when the value holds nothing. */
function setOrDrop(settings: Json, key: string, value: unknown): Json {
  const empty =
    value === undefined ||
    (Array.isArray(value) && value.length === 0) ||
    (isObject(value) && Object.keys(value).length === 0);
  if (!empty) return { ...settings, [key]: value };
  const { [key]: _dropped, ...rest } = settings;
  return rest;
}

/**
 * Settings of Claude Code without anything of the bridge: its two hooks and the rule that lets
 * its tools run. What else the settings hold stays as it is.
 */
export function withoutBridgeSettings(settings: Json): Json {
  let next = settings;
  if (isObject(settings.hooks)) {
    let hooks = settings.hooks;
    hooks = setOrDrop(hooks, 'Stop', withoutHooks(hooks.Stop, WAITS));
    hooks = setOrDrop(hooks, 'PreToolUse', withoutHooks(hooks.PreToolUse, NAMES_CALLER));
    next = setOrDrop(next, 'hooks', hooks);
  }
  if (isObject(settings.permissions) && Array.isArray(settings.permissions.allow)) {
    const allow = settings.permissions.allow.filter((rule) => rule !== CLAUDE_TOOLS_PERMISSION);
    next = setOrDrop(next, 'permissions', setOrDrop(settings.permissions, 'allow', allow));
  }
  return next;
}

export interface BridgeSettings {
  /** The command of the hook that waits for a session's mail */
  wait: ReturnType<typeof claudeWaitHook>;
  /** The command of the hook that names the session of a tool call */
  tools: ReturnType<typeof claudeToolsHook>;
  /** Whether the tools run without a permission prompt */
  allow: boolean;
}

/**
 * Settings of Claude Code with the bridge in them: the hooks it had of the bridge are replaced,
 * its other hooks and rules stay. A rule that lets the tools run is added when asked for, and
 * one that is there is never taken away.
 */
export function withBridgeSettings(settings: Json, bridge: BridgeSettings): Json {
  const had =
    isObject(settings.permissions) &&
    Array.isArray(settings.permissions.allow) &&
    settings.permissions.allow.includes(CLAUDE_TOOLS_PERMISSION);
  const base = withoutBridgeSettings(settings);
  const hooks = isObject(base.hooks) ? base.hooks : {};
  const stop = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  const before = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const next: Json = {
    ...base,
    hooks: {
      ...hooks,
      Stop: [...stop, ...bridge.wait.hooks.Stop],
      PreToolUse: [...before, ...bridge.tools.hooks.PreToolUse],
    },
  };
  if (!bridge.allow && !had) return next;
  const permissions = isObject(base.permissions) ? base.permissions : {};
  const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
  return { ...next, permissions: { ...permissions, allow: [...allow, CLAUDE_TOOLS_PERMISSION] } };
}

/** What settings hold of the bridge, a line each, for a person to read. */
function bridgeLines(settings: Json, sign: '+' | '-'): string[] {
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  const allowed =
    isObject(settings.permissions) &&
    Array.isArray(settings.permissions.allow) &&
    settings.permissions.allow.includes(CLAUDE_TOOLS_PERMISSION);
  return [
    ...commandsOf(hooks.Stop, WAITS).map((command) => `${sign} hooks.Stop: ${command}`),
    ...commandsOf(hooks.PreToolUse, NAMES_CALLER).map(
      (command) => `${sign} hooks.PreToolUse: ${command}`
    ),
    ...(allowed ? [`${sign} permissions.allow: ${CLAUDE_TOOLS_PERMISSION}`] : []),
  ];
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * How Claude Code is given the bridge for the sessions a person opens: the server of tools
 * (`claude mcp add`), a hook that wakes a session for its mail and one that tells the tools
 * which session calls, the rule that lets the tools run, and the notes in `CLAUDE.md`. For one
 * project it all goes where only this person has it: the local scope of Claude Code and the
 * project's `.claude/settings.local.json`. Only the notes go into a file the project may share.
 */
export function claudeSetup(options: ClaudeSetupOptions): AdapterSetup {
  const command = options.command ?? 'claude';
  const base = options.env ?? process.env;
  const env = outsideSessionEnv(base);
  const configDir = base.CLAUDE_CONFIG_DIR?.trim();
  const configPath = options.configPath ?? join(configDir || homedir(), '.claude.json');
  const userDir = configDir || join(homedir(), '.claude');
  const userSettingsPath = options.userSettingsPath ?? join(userDir, 'settings.json');
  const userNotesPath = options.userNotesPath ?? join(userDir, 'CLAUDE.md');
  const server = options.toolsServer;
  const hook = {
    ...(options.bridgeCommand !== undefined && { bridgeCommand: options.bridgeCommand }),
    ...(options.bridgeHome !== undefined && { bridgeHome: options.bridgeHome }),
  };

  const places = (context: SetupContext) => {
    const project = resolve(context.project);
    return context.scope === 'user'
      ? { scope: 'user' as const, settings: userSettingsPath, notes: userNotesPath, project }
      : {
          scope: 'local' as const,
          settings: join(project, '.claude', 'settings.local.json'),
          notes: join(project, 'CLAUDE.md'),
          project,
        };
  };

  /** The server of tools as Claude Code has it in a scope, when it has one there. */
  function registered(scope: 'local' | 'user', project: string): unknown {
    const text = readText(configPath);
    let config: unknown;
    try {
      config = text === undefined ? {} : JSON.parse(text);
    } catch {
      throw new Error(`${configPath} is not valid JSON: cannot tell what Claude Code has set up`);
    }
    if (!isObject(config)) return undefined;
    if (scope === 'user') {
      return isObject(config.mcpServers) ? config.mcpServers[BRIDGE_TOOLS_SERVER] : undefined;
    }
    const projects = isObject(config.projects) ? config.projects : {};
    for (const folder of new Set([canonicalPath(project), project])) {
      const entry = projects[folder];
      const servers = isObject(entry) && isObject(entry.mcpServers) ? entry.mcpServers : {};
      if (servers[BRIDGE_TOOLS_SERVER] !== undefined) return servers[BRIDGE_TOOLS_SERVER];
    }
    return undefined;
  }

  async function run(args: string[], cwd: string): Promise<void> {
    const result = await runCommand(command, args, { cwd, env });
    if (result.code !== 0) {
      throw new Error(`${command} ${args.slice(0, 2).join(' ')} failed: ${failureOf(result)}`);
    }
  }

  const removal = (scope: 'local' | 'user'): string[] => [
    'mcp',
    'remove',
    BRIDGE_TOOLS_SERVER,
    '--scope',
    scope,
  ];

  const shown = (args: readonly string[]): string =>
    [command, ...args].map((word) => shellQuote(word)).join(' ');

  async function install(context: InstallContext): Promise<SetupStep[]> {
    const version = await runCommand(command, ['--version'], { env });
    if (version.code !== 0) throw new Error(`${command} --version failed: ${failureOf(version)}`);
    const place = places(context);
    const steps: SetupStep[] = [];

    const has = registered(place.scope, place.project);
    const wanted = { command: server.command, args: [...server.args] };
    const current = isObject(has) ? { command: has.command, args: has.args ?? [] } : undefined;
    if (!same(current, wanted)) {
      const addition = [
        'mcp',
        'add',
        '--scope',
        place.scope,
        BRIDGE_TOOLS_SERVER,
        '--',
        server.command,
        ...server.args,
      ];
      const replaces = has !== undefined;
      steps.push({
        title:
          place.scope === 'user'
            ? `${replaces ? 'Replace' : 'Register'} the bridge's server of tools with Claude Code, for every project of yours`
            : `${replaces ? 'Replace' : 'Register'} the bridge's server of tools with Claude Code, for you in this project`,
        lines: [...(replaces ? [shown(removal(place.scope))] : []), shown(addition)],
        apply: async () => {
          if (replaces) await run(removal(place.scope), place.project);
          await run(addition, place.project);
        },
      });
    }

    const before = readSettings(place.settings);
    const after = withBridgeSettings(before, {
      wait: claudeWaitHook({
        ...hook,
        tools: true,
        timeoutS: options.hookTimeoutS ?? DEFAULT_HOOK_TIMEOUT_S,
      }),
      tools: claudeToolsHook(hook),
      allow: context.allowTools,
    });
    if (!same(before, after)) {
      const kept = new Set(bridgeLines(before, '+'));
      steps.push({
        title: `Edit ${place.settings}: the hooks that wake a session for its mail and name it to the tools`,
        lines: bridgeLines(after, '+').filter((line) => !kept.has(line)),
        apply: async () => writeSettings(place.settings, after),
      });
    }

    if (context.notes) {
      const notes = notesStep(place.notes, bridgeNotes({ takeJobs: context.takeJobs }));
      if (notes) steps.push(notes);
    }
    return steps;
  }

  async function uninstall(context: SetupContext): Promise<SetupStep[]> {
    const place = places(context);
    const steps: SetupStep[] = [];

    if (registered(place.scope, place.project) !== undefined) {
      steps.push({
        title: "Remove the bridge's server of tools from Claude Code",
        lines: [shown(removal(place.scope))],
        apply: () => run(removal(place.scope), place.project),
      });
    }

    const before = readSettings(place.settings);
    const after = withoutBridgeSettings(before);
    if (!same(before, after)) {
      steps.push({
        title:
          Object.keys(after).length === 0
            ? `Remove ${place.settings}, which holds only the hooks of the bridge`
            : `Edit ${place.settings}: take the hooks of the bridge out`,
        lines: bridgeLines(before, '-'),
        apply: async () => writeSettings(place.settings, after),
      });
    }

    const notes = removeNotesStep(place.notes);
    if (notes) steps.push(notes);
    return steps;
  }

  return { install, uninstall };
}
