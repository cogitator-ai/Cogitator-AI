import { resolve } from 'node:path';
import type { ToolCallUpdate, ToolKind } from '@agentclientprotocol/sdk';
import {
  PermissionRuleSet,
  addPermissionRule,
  loadPermissionSettings,
  rememberFile,
  rememberableRules,
  resolvePermission,
  settingsChanged,
  tool,
  type LoadedPermissionSettings,
} from '@cogitator-ai/core';
import type {
  PermissionDecision,
  PermissionLayerSettings,
  PermissionMode,
  PermissionRememberLayer,
  PermissionRules,
  PermissionSettingsOptions,
  Tool,
  Workspace,
} from '@cogitator-ai/types';
import { z } from 'zod';

/** How the permission engine decides what an external ACP agent asks to do */
export interface AcpPermissionOptions {
  /** Rules in code for the agent, in the grammar of Claude Code's settings (`Bash(npm test *)`) */
  rules?: PermissionRules;
  /**
   * Read the rules of the settings files too: `true` for the default places at the workspace
   * root, or where to read. Default false, as the runtime
   */
  settings?: boolean | PermissionSettingsOptions;
  /**
   * Where an "always" answer saves its rule (default `session`: for the thread, in this process).
   * A file layer needs `settings`
   */
  rememberIn?: PermissionRememberLayer;
}

/** A call of an external agent as the permission engine reads it: a tool of its own and arguments */
export interface AcpCallSubject {
  tool: Tool;
  args: Record<string, unknown>;
  /** Whether the call asks without a rule allowing it, whatever the mode says */
  needsApproval: boolean;
  /**
   * Whether an "always" answer may save a rule for it: not for a call the engine knows only by
   * its kind (no tool name, no command, no paths), whose rule would name every such call
   */
  rememberable: boolean;
  /** Whether the call leaves plan mode (`switch_mode`): it asks even in plan mode */
  switchesMode?: boolean;
}

const COMMAND_TOOL = tool({
  name: 'run_command',
  description: 'A command an external agent runs',
  parameters: z.object({
    command: z.string(),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
  access: {
    kind: 'command',
    command: ({ command }) => command,
    cwd: ({ cwd }) => cwd,
    env: ({ env }) => env,
  },
  execute: async () => null,
});

/** The step that leaves plan mode, which the engine runs in plan mode only once a person agrees */
const SWITCH_MODE_TOOL = tool({
  name: 'exit_plan_mode',
  description: 'An external agent leaving plan mode',
  parameters: z.object({}).passthrough(),
  requiresApproval: true,
  execute: async () => null,
});

const PLAN_TOOLS: ReadonlySet<Tool> = new Set([SWITCH_MODE_TOOL]);

const READ_TOOL = tool({
  name: 'read_file',
  description: 'Files an external agent reads',
  parameters: z.object({ paths: z.array(z.string()) }),
  annotations: { readOnlyHint: true },
  access: { kind: 'read', paths: ({ paths }) => paths },
  execute: async () => null,
});

const EDIT_TOOL = tool({
  name: 'edit_file',
  description: 'Files an external agent changes',
  parameters: z.object({ paths: z.array(z.string()) }),
  access: { kind: 'edit', paths: ({ paths }) => paths },
  execute: async () => null,
});

const FETCH_TOOL = tool({
  name: 'web_fetch',
  description: 'A URL an external agent fetches',
  parameters: z.object({ url: z.string() }),
  annotations: { readOnlyHint: true },
  access: { kind: 'fetch', url: ({ url }) => url },
  execute: async () => null,
});

const READ_ONLY_TOOLS = new Map<string, Tool>();

function readOnlyTool(name: string): Tool {
  let found = READ_ONLY_TOOLS.get(name);
  if (!found) {
    found = tool({
      name,
      description: 'A step of an external agent that changes nothing',
      parameters: z.object({}).passthrough(),
      annotations: { readOnlyHint: true },
      execute: async () => null,
    });
    READ_ONLY_TOOLS.set(name, found);
  }
  return found;
}

const OTHER_TOOLS = new Map<string, Tool>();

function otherTool(name: string): Tool {
  let found = OTHER_TOOLS.get(name);
  if (!found) {
    found = tool({
      name,
      description: 'A tool of an external agent',
      parameters: z.object({}).passthrough(),
      requiresApproval: true,
      execute: async () => null,
    });
    OTHER_TOOLS.set(name, found);
  }
  return found;
}

/** A name a permission rule can hold, from what an agent calls its tool */
function ruleName(name: string): string {
  return trimChar(name.replace(/[^A-Za-z0-9_-]/g, '_'), '_') || 'tool';
}

/** `text` without `char` at its start and its end, in one pass */
export function trimChar(text: string, char: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === char) start++;
  while (end > start && text[end - 1] === char) end--;
  return text.slice(start, end);
}

/** Quotes `word` for a POSIX shell when it needs it */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish']);

/**
 * The command line a program with its arguments runs: the script of a shell started with `-c`
 * (`sh -c 'npm test'` runs `npm test`), else the words quoted for a shell
 */
export function commandLine(command: string, args: readonly string[] = []): string {
  const program = command.split('/').at(-1) ?? command;
  if (SHELLS.has(program) && args.length === 2 && /^-l?c$/.test(args[0] ?? '')) return args[1]!;
  return args.length === 0 ? command : [command, ...args].map(shellQuote).join(' ');
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The command line an execute call of an agent runs, from its raw input or its title */
export function commandOf(call: Pick<ToolCallUpdate, 'rawInput' | 'title'>): string | undefined {
  const input = call.rawInput;
  if (input && typeof input === 'object') {
    const raw = input as Record<string, unknown>;
    const command = raw.command ?? raw.cmd;
    if (Array.isArray(command) && command.every((part) => typeof part === 'string')) {
      return commandLine(command[0] ?? '', command.slice(1));
    }
    const text = stringOf(command);
    if (text) {
      const args = Array.isArray(raw.args)
        ? raw.args.filter((a): a is string => typeof a === 'string')
        : [];
      return args.length > 0 ? commandLine(text, args) : text;
    }
  }
  const title = stringOf(call.title);
  return title === undefined ? undefined : trimChar(title, '`');
}

/** The paths a call of an agent touches: its locations, else the paths of its raw input */
export function pathsOf(
  call: Pick<ToolCallUpdate, 'rawInput' | 'locations'>,
  root: string
): string[] {
  const located = (call.locations ?? []).map((location) => location.path);
  if (located.length > 0) return located.map((path) => resolve(root, path));
  const input = call.rawInput;
  if (!input || typeof input !== 'object') return [];
  const raw = input as Record<string, unknown>;
  const found = [raw.file_path, raw.path, raw.filePath, raw.notebook_path]
    .map(stringOf)
    .filter((path): path is string => path !== undefined);
  if (Array.isArray(raw.paths)) {
    found.push(...raw.paths.filter((path): path is string => typeof path === 'string'));
  }
  return found.map((path) => resolve(root, path));
}

/**
 * A call an ACP agent asks permission for, as a call of one of the runtime's tools the rules
 * name: `execute` as `run_command` (`Bash(...)` rules), `read` and `search` with paths as
 * `read_file` (`Read(...)`), `edit`, `delete` and `move` as `edit_file` (`Edit(...)`), `fetch` as
 * `web_fetch` (`WebFetch(domain:...)`), `think` as a step that changes nothing, and any other as
 * `acp__<agent>__<tool>`, which always asks unless a rule allows it
 */
export function subjectOf(
  call: Pick<ToolCallUpdate, 'kind' | 'title' | 'name' | 'rawInput' | 'locations'>,
  agent: string,
  root: string
): AcpCallSubject {
  const kind: ToolKind = call.kind ?? 'other';
  const paths = pathsOf(call, root);
  const input =
    call.rawInput !== null && typeof call.rawInput === 'object' && !Array.isArray(call.rawInput)
      ? (call.rawInput as Record<string, unknown>)
      : undefined;
  switch (kind) {
    case 'execute': {
      const command = commandOf(call);
      if (!command) break;
      const cwd = stringOf(input?.cwd);
      const env = envOf(input?.env);
      return {
        tool: COMMAND_TOOL,
        args: {
          command,
          ...(cwd !== undefined && { cwd: resolve(root, cwd) }),
          ...(env && { env }),
        },
        needsApproval: true,
        rememberable: true,
      };
    }
    case 'read':
    case 'search':
      if (paths.length > 0) {
        return { tool: READ_TOOL, args: { paths }, needsApproval: false, rememberable: true };
      }
      if (kind === 'search') {
        return {
          tool: readOnlyTool(`acp__${ruleName(agent)}__search`),
          args: {},
          needsApproval: false,
          rememberable: false,
        };
      }
      break;
    case 'edit':
    case 'delete':
    case 'move':
      if (paths.length > 0) {
        return { tool: EDIT_TOOL, args: { paths }, needsApproval: false, rememberable: true };
      }
      break;
    case 'fetch': {
      const url = stringOf(input?.url);
      if (url) return { tool: FETCH_TOOL, args: { url }, needsApproval: false, rememberable: true };
      break;
    }
    case 'think':
      return {
        tool: readOnlyTool(`acp__${ruleName(agent)}__think`),
        args: {},
        needsApproval: false,
        rememberable: false,
      };
    case 'switch_mode':
      return {
        tool: SWITCH_MODE_TOOL,
        args: {},
        needsApproval: true,
        rememberable: false,
        switchesMode: true,
      };
    default:
      break;
  }
  const named = stringOf(call.name);
  const name = `acp__${ruleName(agent)}__${ruleName(named ?? kind)}`;
  return {
    tool: otherTool(name),
    args: {},
    needsApproval: true,
    rememberable: named !== undefined,
  };
}

/** The environment a call names, as `{ NAME: value }` or ACP's `[{ name, value }]` */
export function envOf(value: unknown): Record<string, string> | undefined {
  if (Array.isArray(value)) {
    const entries = value.flatMap((entry): Array<[string, string]> => {
      if (entry === null || typeof entry !== 'object') return [];
      const { name, value: inner } = entry as { name?: unknown; value?: unknown };
      return typeof name === 'string' && typeof inner === 'string' ? [[name, inner]] : [];
    });
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * The permission engine of the runtime, deciding what external ACP agents ask to do: the rules
 * in code, the settings files when asked to read them, and the rules people saved with an
 * "always" answer, decided by `resolvePermission` in the turn's mode
 */
export class AcpPermissions {
  private loaded: Promise<LoadedPermissionSettings> | undefined;
  private readonly sessionRules = new Map<string, { allow: string[]; deny: string[] }>();
  private readonly savedFiles: PermissionLayerSettings[] = [];

  constructor(
    private readonly workspace: Workspace,
    private readonly options: AcpPermissionOptions = {}
  ) {}

  private get root(): string {
    return this.workspace.root;
  }

  private get settings(): PermissionSettingsOptions | undefined {
    const settings = this.options.settings;
    if (settings === undefined || settings === false) return undefined;
    return settings === true ? {} : settings;
  }

  private async fileLayers(): Promise<PermissionLayerSettings[]> {
    const settings = this.settings;
    if (!settings) return [];
    if (this.loaded) {
      const loaded = await this.loaded.catch(() => undefined);
      if (!loaded || (await settingsChanged(loaded.files, loaded.dirs))) this.loaded = undefined;
    }
    this.loaded ??= loadPermissionSettings(settings.root ?? this.root, settings);
    return (await this.loaded).layers;
  }

  /** The rules of every layer for the thread `threadId` */
  async rules(threadId: string): Promise<PermissionRuleSet> {
    const saved = this.sessionRules.get(threadId);
    const own = this.options.rules;
    return new PermissionRuleSet([
      ...(await this.fileLayers()),
      ...this.savedFiles,
      ...(own ? [{ layer: 'session' as const, origin: 'acp', ...own }] : []),
      ...(saved ? [{ layer: 'session' as const, origin: 'remembered', ...saved }] : []),
    ]);
  }

  /** Decides a call in `mode` */
  async decide(
    subject: AcpCallSubject,
    mode: PermissionMode,
    threadId: string
  ): Promise<PermissionDecision> {
    return resolvePermission(subject.tool, subject.args, {
      mode: mode === 'auto' ? 'default' : mode,
      rules: await this.rules(threadId),
      needsApproval: subject.needsApproval,
      workspace: this.workspace,
      cwd: resolve(this.root, this.workspace.cwd),
      projectRoot: this.root,
      planTools: PLAN_TOOLS,
    });
  }

  /** The rule an "always" answer to a call saves, when one covers it */
  suggest(subject: AcpCallSubject): string | undefined {
    if (!subject.rememberable) return undefined;
    return rememberableRules(subject.tool, subject.args, {
      workspace: this.workspace,
      cwd: resolve(this.root, this.workspace.cwd),
      projectRoot: this.root,
    })[0];
  }

  /**
   * Saves the rule of an "always allow" or "always reject" answer: for the thread, or to the
   * settings file of `rememberIn`. Resolves with what it saved, undefined when no rule covers the
   * call
   */
  async remember(
    subject: AcpCallSubject,
    behavior: 'allow' | 'deny',
    threadId: string
  ): Promise<{ rule: string; layer: PermissionRememberLayer } | undefined> {
    const rule = this.suggest(subject);
    if (!rule) return undefined;
    const settings = this.settings;
    const layer = settings ? (this.options.rememberIn ?? 'session') : 'session';
    if (layer === 'session') {
      const saved = this.sessionRules.get(threadId) ?? { allow: [], deny: [] };
      if (!saved[behavior].includes(rule)) saved[behavior].push(rule);
      this.sessionRules.set(threadId, saved);
      return { rule, layer };
    }
    const file = rememberFile(layer, settings?.root ?? this.root, settings);
    await addPermissionRule(file, behavior, rule);
    this.loaded = undefined;
    this.savedFiles.push({
      layer,
      origin: file,
      anchor: layer === 'user' ? resolve(file, '..') : this.root,
      ...(behavior === 'allow' ? { allow: [rule] } : { deny: [rule] }),
    });
    return { rule, layer };
  }
}
