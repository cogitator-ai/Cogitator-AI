import type {
  AgentConfig,
  AgentSkillSource,
  CogitatorConfig,
  CommandsConfig,
  ContextManagerConfig,
  HooksConfig,
  MemoryConfig,
  PermissionOptions,
  PermissionsConfig,
  ProjectInstructionsOptions,
  RunMiddleware,
  RunOptions,
  RunTimeouts,
  SessionBudgetConfig,
  SkillRegistryConfig,
  SubagentDefinitionInput,
  SubagentsConfig,
  Tool,
  Workspace,
} from '@cogitator-ai/types';
import { Agent } from '../agent';
import { isRecallToolOutput } from '../tools/recall-tool-output';
import {
  readFileBinding,
  WORKSPACE_TOOL_NAMES,
  workspaceTools as createWorkspaceTools,
  type WorkspaceToolName,
  type WorkspaceToolsOptions,
} from '../tools/workspace-tools';
import { LocalWorkspace, type LocalWorkspaceOptions } from '../workspace/index';
import { harnessPrompt } from './prompt';

/**
 * What a harness agent is for:
 * - `coding`: a coding agent in a project, with every workspace tool (`run_command` included),
 *   the project's `AGENTS.md`, subagents and commands from Markdown files, skills and todos
 * - `assistant`: a personal assistant with a folder of files it reads and writes, no shell,
 *   skills, todos and memory files when the runtime has memory
 */
export type HarnessPreset = 'coding' | 'assistant';

/** Every {@link HarnessPreset} */
export const HARNESS_PRESETS: readonly HarnessPreset[] = ['coding', 'assistant'];

/** A workspace for a harness agent: one you made, or a directory (or the options) of a `LocalWorkspace` */
export type HarnessWorkspace = Workspace | string | LocalWorkspaceOptions;

/** When the tools you add are deferred until `tool_search` finds them, see `HarnessAgentOptions.toolSearch` */
export interface HarnessToolSearchOptions {
  /**
   * Most tools the model gets up front (default 20): once the harness tools and yours are more,
   * yours are deferred
   */
  threshold?: number;
  /** Names of your tools that are never deferred */
  keep?: readonly string[];
}

/** Where long tool results end, see `HarnessAgentOptions.toolResults` */
export interface HarnessToolResultOptions {
  /**
   * Most characters of a tool result the model reads (default 30 000, about 7 500 tokens): a
   * longer one is saved whole to the workspace and the model gets its start and the file's path
   * (`limits.maxToolResultLength`)
   */
  maxLength?: number;
  /** Milliseconds saved results are kept (`limits.toolResultRetention`, default 7 days) */
  retention?: number;
}

export interface HarnessAgentOptions<TDeps = unknown> {
  /** What the agent is for, which sets the defaults of everything below (default `coding`) */
  preset?: HarnessPreset;
  /** Name of the agent (default `coder` for `coding`, `assistant` for `assistant`) */
  name?: string;
  description?: string;
  /** `provider/model`, default the runtime's `llm.defaultModel` */
  model?: string;
  /**
   * The base of the system prompt: who the agent is and how it answers. Default: the preset's.
   * The harness adds how to use its tools after it (`harnessPrompt`), the runtime then adds the
   * project's instructions and the skills
   */
  instructions?: string;
  /** Add the section that tells the model how to use the workspace, todos and subagents (default true) */
  harnessPrompt?: boolean;
  /**
   * The workspace the agent's tools work in: a `Workspace` (local, Docker, E2B, Daytona, Vercel
   * Sandbox), a directory for a `LocalWorkspace`, or its options. Default: the working directory
   * of the process for `coding`, `./workspace` for `assistant`. `false`: none, the tools use
   * the run's (`RunOptions.workspace`). A workspace you pass is yours to start and dispose
   */
  workspace?: HarnessWorkspace | false;
  /** Give the agent `run_command`, which runs shell commands in the workspace (default: `coding` only) */
  shell?: boolean;
  /**
   * Options of the workspace tools, or `false` for none. `tools` names exactly which ones, over
   * `shell`
   */
  workspaceTools?: false | WorkspaceToolsOptions;
  /** Tools of your own, next to the harness's. One named like a harness tool replaces it */
  tools?: readonly Tool<unknown, unknown, TDeps>[];
  /**
   * Defer your tools until the model finds them with `tool_search`, so their schemas cost no
   * context until used: `true` always, `false` never, default once the agent would have more
   * than 20 tools. Tools you marked `deferred` stay deferred either way
   */
  toolSearch?: boolean | HarnessToolSearchOptions;
  /**
   * `SKILL.md` skills the agent activates on demand. Default: a `SkillRegistry` over the
   * workspace's `.agents/skills`, `.cogitator/skills` and `.claude/skills`. A registry
   * configuration (its `dirs` searched first), a list of skill sources, or `false` for none
   */
  skills?: false | SkillRegistryConfig | readonly AgentSkillSource[];
  /** Give the agent `write_todos` to plan long tasks (default true) */
  todos?: boolean;
  /**
   * Subagents the agent hands tasks to with the `agent` tool. `coding` default: the Markdown
   * subagents of `agents/` folders (the project's only with `trusted`) and a built-in
   * `general-purpose` one, whose approvals reach the user as the agent's own do
   * (`approvalMode: 'bubble'`). `true` for the same with `assistant`, `false` for none, or a
   * configuration merged over the default
   */
  subagents?: boolean | SubagentsConfig;
  /**
   * Commands a run's input names (`/review src/app.ts`): `coding` default, Markdown commands of
   * `commands/` folders (the project's only with `trusted`). `true`, `false`, or a configuration
   * merged over the default
   */
  commands?: boolean | CommandsConfig;
  /**
   * Read the workspace's `AGENTS.md` and `CLAUDE.md` into the system prompt (default: `coding`
   * only), or which files to read
   */
  projectInstructions?: boolean | ProjectInstructionsOptions;
  /**
   * The permission mode and rules (`allow`, `ask`, `deny`) of the agent's runs, and the runtime's
   * `classifier`, `settings` and "always allow" layers. Default `{}`: the permission engine is on
   * in `default` mode, reads run freely, edits and commands ask. `false`: off, only tools that
   * need approval ask (`run_command`)
   */
  permissions?: false | PermissionsConfig;
  /**
   * Trust the project in the workspace (default false): its own subagents, commands, hooks and the
   * `allow` rules and mode of its settings files apply. Trust only repositories you know
   */
  trusted?: boolean;
  /**
   * Read the permission rules and hooks of Claude Code compatible settings files (`.claude/` and
   * `.cogitator/` of the workspace, the user's and the managed ones). Default false, as the Claude
   * Agent SDK. A local workspace's root is the project root
   */
  settings?: boolean;
  /** Hooks of the runtime, in the format of Claude Code's `settings.json` */
  hooks?: HooksConfig;
  /** What a session and each agent in it may spend in money, tokens and tool calls */
  budget?: SessionBudgetConfig;
  /**
   * The runtime's memory. With `assistant` the agent also keeps notes in memory files
   * (`files: { scope: 'user' }`) unless `files` says otherwise
   */
  memory?: MemoryConfig;
  /**
   * Keeping long sessions within the model's window (the runtime's `context`). Default: clear the
   * outputs of old tool calls past 100 000 tokens and compress the conversation near the window.
   * Merged over the default, `false` for neither
   */
  compaction?: false | ContextManagerConfig;
  /** Where long tool results end */
  toolResults?: HarnessToolResultOptions;
  /**
   * Run the calls of a turn that are safe to run together at the same time, the ones that only
   * read (default true). A number also caps how many run at once
   */
  parallelToolCalls?: boolean | number;
  /** Deadlines of a run's stages, see `RunTimeouts` */
  timeouts?: RunTimeouts;
  /** Most model turns of a run (default 100 for `coding`, 30 for `assistant`) */
  maxIterations?: number;
  /** Middleware of the agent */
  middleware?: RunMiddleware<TDeps>[];
  /** Any other field of the agent, applied last over what the harness built */
  agent?: Partial<AgentConfig<TDeps>>;
}

/** The runtime pieces of a harness agent, see {@link HarnessAgent.config} */
export type HarnessRuntimeConfig = Pick<
  CogitatorConfig,
  | 'instructions'
  | 'permissions'
  | 'hooks'
  | 'subagents'
  | 'commands'
  | 'budget'
  | 'memory'
  | 'context'
  | 'limits'
>;

/** What each run of a harness agent passes, see {@link HarnessAgent.runOptions} */
export type HarnessRunOptions = Pick<RunOptions, 'parallelToolCalls' | 'maxParallelToolCalls'>;

/**
 * An agent the harness assembled, with what the runtime that runs it needs. The pieces live where
 * the runtime reads them: an agent carries its tools, prompt, workspace, permissions and limits,
 * the runtime its subagents, commands, hooks, project instructions, memory, compaction and
 * where long results go (`config`), and a run how it schedules tool calls (`runOptions`)
 */
export interface HarnessAgent<TDeps = unknown> {
  readonly preset: HarnessPreset;
  readonly agent: Agent<TDeps>;
  /** Fields for the `Cogitator` that runs the agent, only the ones the harness sets */
  readonly config: HarnessRuntimeConfig;
  /** Options for each `cogitator.run()` of the agent */
  readonly runOptions: HarnessRunOptions;
  /** The agent's workspace, undefined with `workspace: false` */
  readonly workspace: Workspace | undefined;
  /**
   * `base` with {@link config} merged in: each field the harness sets merged one level deep over
   * the same field of `base` (the harness's values win), every other field of `base` kept
   */
  mergeConfig(base?: CogitatorConfig): CogitatorConfig;
  /** Disposes the workspace when the harness made it (from a directory), else does nothing */
  dispose(): Promise<void>;
}

interface PresetDefaults {
  name: string;
  instructions: string;
  workspace: () => string;
  shell: boolean;
  subagents: boolean;
  commands: boolean;
  projectInstructions: boolean;
  memoryFiles: boolean;
  maxIterations: number;
}

const PRESETS: Record<HarnessPreset, PresetDefaults> = {
  coding: {
    name: 'coder',
    instructions: [
      'You are a coding agent working in a software project with the user.',
      'Fix bugs, add features, refactor and explain code. Follow the conventions of the code around you, keep changes focused on the task, and say what you changed and what you could not check.',
      'Keep answers short and direct.',
    ].join('\n'),
    workspace: () => process.cwd(),
    shell: true,
    subagents: true,
    commands: true,
    projectInstructions: true,
    memoryFiles: false,
    maxIterations: 100,
  },
  assistant: {
    name: 'assistant',
    instructions: [
      'You are a capable, honest personal assistant.',
      'Keep files the user gives you or asks for in your workspace, and plan longer tasks before you start them.',
      'When you are unsure, say so instead of guessing.',
    ].join('\n'),
    workspace: () => 'workspace',
    shell: false,
    subagents: false,
    commands: false,
    projectInstructions: false,
    memoryFiles: true,
    maxIterations: 30,
  },
};

/** The subagent the `coding` preset gives, as Claude Code's `general-purpose` */
const GENERAL_PURPOSE: SubagentDefinitionInput = {
  description:
    'General-purpose agent for researching questions, searching code and doing multi-step tasks. Use it when a task would take many steps and you only need its result.',
  prompt:
    'You do a task another agent handed you, with the tools you have. Work until it is done, then answer with a concise report of what you found or changed: the other agent reads only your final answer.',
};

const DEFAULT_TOOL_SEARCH_THRESHOLD = 20;
const DEFAULT_MAX_TOOL_RESULT_LENGTH = 30_000;

/**
 * Assembles a production agent from the pieces the runtime has: a workspace with file tools
 * (and a shell for `coding`), a todo list, `SKILL.md` skills, subagents and commands from
 * Markdown files, project instructions, the permission engine, compaction, long tool results
 * saved to the workspace, `tool_search` for many tools and parallel read-only calls. Each piece
 * has a default of its preset and an option to change or drop it.
 *
 * Nothing is hidden: the result holds the `Agent`, the `Cogitator` fields it needs and the run
 * options, all plain values.
 *
 * @example
 * ```ts
 * const harness = createHarnessAgent({ preset: 'coding', workspace: './my-app' });
 * const cogitator = new Cogitator(harness.mergeConfig({ llm: { defaultModel: 'anthropic/claude-sonnet-5-5' } }));
 * const result = await cogitator.run(harness.agent, {
 *   input: 'Fix the failing test',
 *   ...harness.runOptions,
 *   onApproval: (request) => askTheUser(request),
 * });
 * ```
 */
export function createHarnessAgent<TDeps = unknown>(
  options: HarnessAgentOptions<TDeps> = {}
): HarnessAgent<TDeps> {
  const preset = options.preset ?? 'coding';
  const defaults = PRESETS[preset];
  if (!defaults) {
    throw new TypeError(
      `Unknown harness preset "${String(preset)}": use one of ${HARNESS_PRESETS.join(', ')}`
    );
  }

  const { workspace, owned } = workspaceOf(options.workspace, defaults);
  const localRoot = workspace instanceof LocalWorkspace ? workspace.root : undefined;
  const trusted = options.trusted ?? false;

  const own = options.tools ?? [];
  const ownNames = new Set(own.map((candidate) => candidate.name));
  const harnessTools = workspaceToolsOf(options, defaults, workspace).filter(
    (candidate) => !ownNames.has(candidate.name)
  );
  const { tools: extraTools, deferred } = deferTools(own, harnessTools.length, options.toolSearch);
  const tools: Tool<unknown, unknown, TDeps>[] = [...harnessTools, ...extraTools];

  const permissions = options.permissions === false ? undefined : (options.permissions ?? {});
  const agentPermissions = permissions ? permissionOptionsOf(permissions) : undefined;
  const todos = options.todos ?? true;
  const subagents = subagentsOf(options.subagents, defaults, trusted);
  const parallel = options.parallelToolCalls ?? true;
  if (typeof parallel === 'number' && !(Number.isInteger(parallel) && parallel >= 1)) {
    throw new RangeError(
      'parallelToolCalls must be a boolean or a whole number of calls, 1 or more'
    );
  }

  const prompt =
    options.harnessPrompt === false
      ? ''
      : harnessPrompt({
          workspaceTools: harnessTools
            .map((candidate) => candidate.name)
            .filter(isWorkspaceToolName),
          offload: workspace !== undefined || options.workspace === false,
          parallelToolCalls: parallel !== false,
          todos,
          subagents: subagents !== undefined && options.agent?.subagents !== false,
          toolSearch: deferred || tools.some((candidate) => candidate.deferred),
          permissions: permissions !== undefined || tools.some(needsApproval),
        });
  const instructions = [options.instructions ?? defaults.instructions, prompt]
    .filter((part) => part !== '')
    .join('\n\n');

  const skills = skillsOf(options.skills);
  const agentConfig: AgentConfig<TDeps> = {
    name: options.name ?? defaults.name,
    ...(options.description !== undefined && { description: options.description }),
    ...(options.model !== undefined && { model: options.model }),
    instructions,
    tools,
    ...(skills.length > 0 && { skills }),
    ...(todos && { todos: true }),
    ...(workspace && { workspace }),
    ...(agentPermissions && { permissions: agentPermissions }),
    maxIterations: options.maxIterations ?? defaults.maxIterations,
    ...(options.timeouts && { timeouts: options.timeouts }),
    ...(options.middleware && { middleware: options.middleware }),
    ...options.agent,
  };
  const agent = new Agent<TDeps>(agentConfig);

  const config = runtimeConfigOf(options, defaults, {
    permissions,
    subagents,
    trusted,
    ...(localRoot !== undefined && { localRoot }),
  });
  const runOptions: HarnessRunOptions =
    parallel === false
      ? {}
      : {
          parallelToolCalls: true,
          ...(typeof parallel === 'number' && { maxParallelToolCalls: parallel }),
        };

  return {
    preset,
    agent,
    config,
    runOptions,
    workspace,
    mergeConfig: (base = {}) => mergeRuntimeConfig(base, config),
    dispose: async () => {
      if (owned) await workspace?.dispose();
    },
  };
}

function workspaceOf(
  given: HarnessWorkspace | false | undefined,
  defaults: PresetDefaults
): { workspace: Workspace | undefined; owned: boolean } {
  if (given === false) return { workspace: undefined, owned: false };
  const source = given ?? defaults.workspace();
  if (typeof source === 'string') {
    return { workspace: new LocalWorkspace({ root: source }), owned: true };
  }
  if (isWorkspace(source)) return { workspace: source, owned: false };
  return { workspace: new LocalWorkspace(source), owned: true };
}

function isWorkspace(candidate: Workspace | LocalWorkspaceOptions): candidate is Workspace {
  return typeof (candidate as Partial<Workspace>).exec === 'function';
}

function isWorkspaceToolName(name: string): name is WorkspaceToolName {
  return (WORKSPACE_TOOL_NAMES as readonly string[]).includes(name);
}

function needsApproval(candidate: Tool<unknown, unknown, unknown>): boolean {
  return candidate.requiresApproval !== undefined && candidate.requiresApproval !== false;
}

function workspaceToolsOf(
  options: Pick<HarnessAgentOptions, 'workspaceTools' | 'shell'>,
  defaults: PresetDefaults,
  workspace: Workspace | undefined
): Tool[] {
  if (options.workspaceTools === false) return [];
  const shell = options.shell ?? defaults.shell;
  const names = WORKSPACE_TOOL_NAMES.filter((name) => shell || name !== 'run_command');
  return createWorkspaceTools(workspace, { tools: names, ...options.workspaceTools });
}

/**
 * Your tools, deferred when the agent would have more than the threshold. A tool the runtime
 * knows by identity (the `read_file` of `workspaceTools()`, `recall_tool_output`) is kept as it
 * is: a copy would lose what the runtime knows of it
 */
function deferTools<T extends Tool<unknown, unknown, never>>(
  tools: readonly T[],
  harnessCount: number,
  setting: boolean | HarnessToolSearchOptions | undefined
): { tools: T[]; deferred: boolean } {
  if (setting === false || tools.length === 0) return { tools: [...tools], deferred: false };
  const threshold = setting === true ? 0 : (setting?.threshold ?? DEFAULT_TOOL_SEARCH_THRESHOLD);
  if (!(threshold >= 0)) throw new RangeError('toolSearch.threshold must be 0 or more');
  if (harnessCount + tools.length <= threshold) return { tools: [...tools], deferred: false };
  const keep = new Set(typeof setting === 'object' ? (setting.keep ?? []) : []);
  let deferred = false;
  const result = tools.map((candidate) => {
    if (
      candidate.deferred ||
      keep.has(candidate.name) ||
      isWorkspaceToolName(candidate.name) ||
      readFileBinding(candidate) !== undefined ||
      isRecallToolOutput(candidate)
    ) {
      return candidate;
    }
    deferred = true;
    return deferredCopy(candidate);
  });
  return { tools: result, deferred };
}

function deferredCopy<T extends object>(source: T): T {
  const copy: T = Object.create(Object.getPrototypeOf(source) as object | null) as T;
  return Object.assign(copy, source, { deferred: true });
}

function skillsOf(skills: HarnessAgentOptions['skills']): AgentSkillSource[] {
  if (skills === false) return [];
  if (skills === undefined) return [{}];
  if (isSkillList(skills)) return [...skills];
  return [skills];
}

function isSkillList(
  skills: SkillRegistryConfig | readonly AgentSkillSource[]
): skills is readonly AgentSkillSource[] {
  return Array.isArray(skills);
}

/** The mode and rules of `permissions`, which the agent carries: the rest is the runtime's */
function permissionOptionsOf(permissions: PermissionsConfig): PermissionOptions {
  const {
    settings: _settings,
    classifier: _classifier,
    rememberIn: _rememberIn,
    rememberLayers: _rememberLayers,
    ...own
  } = permissions;
  return own;
}

function subagentsOf(
  given: boolean | SubagentsConfig | undefined,
  defaults: PresetDefaults,
  trusted: boolean
): SubagentsConfig | undefined {
  const on = given === undefined ? defaults.subagents : given !== false;
  if (!on) return undefined;
  const custom = typeof given === 'object' ? given : {};
  return {
    files: trusted ? { trusted: true } : true,
    approvalMode: 'bubble',
    ...custom,
    agents: { 'general-purpose': GENERAL_PURPOSE, ...custom.agents },
  };
}

function commandsOf(
  given: boolean | CommandsConfig | undefined,
  defaults: PresetDefaults,
  trusted: boolean
): CommandsConfig | undefined {
  const on = given === undefined ? defaults.commands : given !== false;
  if (!on) return undefined;
  return { files: trusted ? { trusted: true } : true, ...(typeof given === 'object' && given) };
}

function runtimeConfigOf(
  options: Omit<HarnessAgentOptions, 'tools' | 'middleware' | 'agent'>,
  defaults: PresetDefaults,
  pieces: {
    permissions: PermissionsConfig | undefined;
    subagents: SubagentsConfig | undefined;
    trusted: boolean;
    localRoot?: string;
  }
): HarnessRuntimeConfig {
  const { trusted, localRoot } = pieces;
  const settingsAt = { ...(localRoot !== undefined && { root: localRoot }), trusted };

  const projectFiles = options.projectInstructions ?? defaults.projectInstructions;

  const runtimePermissions: PermissionsConfig = {};
  const given = pieces.permissions;
  if (given?.settings !== undefined) runtimePermissions.settings = given.settings;
  else if (options.settings) runtimePermissions.settings = settingsAt;
  if (given?.classifier) runtimePermissions.classifier = given.classifier;
  if (given?.rememberIn) runtimePermissions.rememberIn = given.rememberIn;
  if (given?.rememberLayers) runtimePermissions.rememberLayers = given.rememberLayers;

  const hooks: HooksConfig = {
    ...(options.settings && { settings: settingsAt }),
    ...options.hooks,
  };

  const commands = commandsOf(options.commands, defaults, trusted);

  const memory: MemoryConfig | undefined = options.memory && {
    ...options.memory,
    ...(defaults.memoryFiles && options.memory.files === undefined && { files: { scope: 'user' } }),
  };

  const compaction =
    options.compaction === false ? undefined : { clearToolOutputs: true, ...options.compaction };

  const limits = {
    maxToolResultLength: options.toolResults?.maxLength ?? DEFAULT_MAX_TOOL_RESULT_LENGTH,
    ...(options.toolResults?.retention !== undefined && {
      toolResultRetention: options.toolResults.retention,
    }),
  };

  return {
    ...(projectFiles !== false && { instructions: { projectFiles } }),
    ...(Object.keys(runtimePermissions).length > 0 && { permissions: runtimePermissions }),
    ...(Object.keys(hooks).length > 0 && { hooks }),
    ...(pieces.subagents && { subagents: pieces.subagents }),
    ...(commands && { commands }),
    ...(options.budget && { budget: options.budget }),
    ...(memory && { memory }),
    ...(compaction && { context: compaction }),
    limits,
  };
}

const MERGED_KEYS = [
  'instructions',
  'permissions',
  'hooks',
  'subagents',
  'commands',
  'budget',
  'memory',
  'context',
  'limits',
] as const satisfies readonly (keyof HarnessRuntimeConfig)[];

function mergeRuntimeConfig(base: CogitatorConfig, harness: HarnessRuntimeConfig): CogitatorConfig {
  const merged: CogitatorConfig = { ...base };
  for (const key of MERGED_KEYS) {
    const value = harness[key];
    if (value === undefined) continue;
    mergeKey(merged, base, key, value);
  }
  return merged;
}

function mergeKey<K extends (typeof MERGED_KEYS)[number]>(
  target: CogitatorConfig,
  base: CogitatorConfig,
  key: K,
  value: NonNullable<CogitatorConfig[K]>
): void {
  const existing = base[key];
  target[key] = (existing ? { ...existing, ...value } : value) as CogitatorConfig[K];
}
