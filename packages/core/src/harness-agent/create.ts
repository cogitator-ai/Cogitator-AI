import { resolve } from 'node:path';
import type {
  AgentConfig,
  AgentSkillSource,
  CogitatorConfig,
  CommandsConfig,
  ContextManagerConfig,
  DefinitionFileOptions,
  HookSettingsOptions,
  HooksConfig,
  MemoryConfig,
  PermissionOptions,
  PermissionSettingsOptions,
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
   * context until used: `true` always, `false` never, default once the model would see more than
   * 20 tools (the harness's built-in ones counted, the skill tools as if the agent had skills).
   * The tools are not changed: the agent names them in `deferredTools`. Tools you marked
   * `deferred` stay deferred either way
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
   * configuration merged over the default, `agents` by name (a `general-purpose` of yours is
   * merged over the built-in one)
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
   * Trust the project at `projectRoot` (default false): its own subagents, commands, hooks and the
   * `allow` rules and mode of its settings files apply. Trust only repositories you know
   */
  trusted?: boolean;
  /**
   * The directory on this machine whose `.agents/`, `.cogitator/` and `.claude/` folders hold the
   * project's subagents, commands and settings files. Default: the root of a `LocalWorkspace`.
   * Give the host directory of a `DockerWorkspace` here. A remote workspace (E2B, Daytona, Vercel
   * Sandbox) has none on this machine: without `projectRoot` only the user's and the managed
   * files are read for it (its `AGENTS.md` and skills are read through the workspace either way).
   * `false`: no project files, even for a local workspace
   */
  projectRoot?: string | false;
  /**
   * Read the permission rules and hooks of Claude Code compatible settings files (the project's at
   * `projectRoot`, the user's and the managed ones). Default false, as the Claude Agent SDK. With
   * `permissions: false` only the hooks are read. `false` also drops the `settings` of the
   * configuration `mergeConfig()` merges into
   */
  settings?: boolean;
  /**
   * Hooks of the runtime, in the format of Claude Code's `settings.json`. `false`: none, also not
   * the ones of the configuration `mergeConfig()` merges into or of settings files
   */
  hooks?: false | HooksConfig;
  /** What a session and each agent in it may spend in money, tokens and tool calls */
  budget?: SessionBudgetConfig;
  /**
   * The runtime's memory. With `assistant` the agent also keeps notes in memory files
   * (`files: { scope: 'user' }`) whenever the runtime has a memory adapter, here or in the
   * configuration `mergeConfig()` merges into, unless `files` says otherwise
   */
  memory?: MemoryConfig;
  /**
   * Keep notes in memory files (`memory.files`) once the runtime has a memory adapter (default:
   * `assistant` only). `false` also drops the `files` of the configuration `mergeConfig()` merges
   * into
   */
  memoryFiles?: boolean;
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
   * `base` with {@link config} merged in, field by field and deep into nested objects (maps such as
   * `subagents.agents` by key): the preset's defaults give way to `base`, and what you passed to
   * `createHarnessAgent()` wins over `base`. Arrays and class instances are replaced, not merged.
   * Every other field of `base` is kept
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
/** `agent`, `send_message`, `task_output` and `task_stop` */
const SUBAGENT_TOOL_COUNT = 4;
/** `use_skill` and `read_skill_file` */
const SKILL_TOOL_COUNT = 2;

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
  const projectRoot = projectRootOf(options.projectRoot, workspace);
  const trusted = options.trusted ?? false;

  const own = options.tools ?? [];
  const ownNames = new Set(own.map((candidate) => candidate.name));
  const harnessTools = workspaceToolsOf(options, defaults, workspace).filter(
    (candidate) => !ownNames.has(candidate.name)
  );
  const tools: Tool<unknown, unknown, TDeps>[] = [...harnessTools, ...own];

  const permissions = options.permissions === false ? undefined : (options.permissions ?? {});
  const agentPermissions = permissions ? permissionOptionsOf(permissions) : undefined;
  const todos = options.todos ?? true;
  const subagentsOn =
    options.subagents === undefined ? defaults.subagents : options.subagents !== false;
  const delegates = subagentsOn && options.agent?.subagents !== false;
  const skills = skillsOf(options.skills);
  const clearsToolOutputs =
    options.compaction !== false && options.compaction?.clearToolOutputs !== false;
  const parallel = options.parallelToolCalls ?? true;
  if (typeof parallel === 'number' && !(Number.isInteger(parallel) && parallel >= 1)) {
    throw new RangeError(
      'parallelToolCalls must be a boolean or a whole number of calls, 1 or more'
    );
  }

  const builtIn =
    (todos ? 1 : 0) +
    (delegates ? SUBAGENT_TOOL_COUNT : 0) +
    (clearsToolOutputs ? 1 : 0) +
    (skills.length > 0 ? SKILL_TOOL_COUNT : 0);
  const deferredTools = deferredNamesOf(own, harnessTools.length + builtIn, options.toolSearch);

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
          subagents: delegates,
          toolSearch: deferredTools.length > 0 || tools.some((candidate) => candidate.deferred),
          permissions: permissions !== undefined || tools.some(needsApproval),
        });
  const instructions = [options.instructions ?? defaults.instructions, prompt]
    .filter((part) => part !== '')
    .join('\n\n');

  const agentConfig: AgentConfig<TDeps> = {
    name: options.name ?? defaults.name,
    ...(options.description !== undefined && { description: options.description }),
    ...(options.model !== undefined && { model: options.model }),
    instructions,
    tools,
    ...(deferredTools.length > 0 && { deferredTools }),
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

  const layers = configLayersOf(options, defaults, {
    subagents: subagentsOn,
    trusted,
    ...(projectRoot !== undefined && { projectRoot }),
  });
  const config: HarnessRuntimeConfig = composeConfig(layers, {});
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
    mergeConfig: (base = {}) => composeConfig(layers, base),
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

/** The project directory on this machine, see `HarnessAgentOptions.projectRoot` */
function projectRootOf(
  given: string | false | undefined,
  workspace: Workspace | undefined
): string | undefined {
  if (given === false) return undefined;
  if (given !== undefined) return resolve(given);
  return workspace instanceof LocalWorkspace ? workspace.root : undefined;
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
 * Names of your tools to defer once the model would see more than the threshold. Tools the
 * harness or the runtime relies on being seen (a workspace tool of yours, `recall_tool_output`)
 * and the ones already `deferred` are left out
 */
function deferredNamesOf(
  tools: readonly Tool<unknown, unknown, never>[],
  builtInCount: number,
  setting: boolean | HarnessToolSearchOptions | undefined
): string[] {
  if (setting === false || tools.length === 0) return [];
  const threshold = setting === true ? 0 : (setting?.threshold ?? DEFAULT_TOOL_SEARCH_THRESHOLD);
  if (!(threshold >= 0)) throw new RangeError('toolSearch.threshold must be 0 or more');
  if (builtInCount + tools.length <= threshold) return [];
  const keep = new Set(typeof setting === 'object' ? (setting.keep ?? []) : []);
  return tools
    .filter(
      (candidate) =>
        !candidate.deferred &&
        !keep.has(candidate.name) &&
        !isWorkspaceToolName(candidate.name) &&
        readFileBinding(candidate) === undefined &&
        !isRecallToolOutput(candidate)
    )
    .map((candidate) => candidate.name);
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

/**
 * The places of definition files: the project root on this machine and whether it is trusted,
 * or only the user's and the managed folders when there is none
 */
function definitionFilesOf(
  projectRoot: string | undefined,
  trusted: boolean
): DefinitionFileOptions | true {
  if (projectRoot === undefined) return true;
  return { root: projectRoot, ...(trusted && { trusted: true }) };
}

/** Where settings files are read: the project's at its root, else only the user's and managed ones */
function settingsAt(
  projectRoot: string | undefined,
  trusted: boolean
): PermissionSettingsOptions & HookSettingsOptions {
  if (projectRoot === undefined) return { layers: ['managed', 'user'] };
  return { root: projectRoot, trusted };
}

/** What the preset sets (under the base configuration) and what you passed (over it) */
interface ConfigLayers {
  defaults: HarnessRuntimeConfig;
  explicit: HarnessRuntimeConfig;
  /**
   * Sections you turned off with `false`: the base's are dropped too, so a piece you turned off
   * stays off whatever configuration the harness is merged into
   */
  off: ReadonlySet<(typeof MERGED_KEYS)[number]>;
  /** Drop the `settings` of the base's `permissions` and `hooks` (`settings: false`) */
  settingsOff: boolean;
  /** Keep memory files when the merged configuration has a memory adapter, drop them when false */
  memoryFiles: boolean;
  memoryFilesOff: boolean;
}

function configLayersOf(
  options: Omit<HarnessAgentOptions, 'tools' | 'middleware' | 'agent'>,
  defaults: PresetDefaults,
  pieces: { subagents: boolean; trusted: boolean; projectRoot?: string }
): ConfigLayers {
  const { trusted, projectRoot } = pieces;
  const files = definitionFilesOf(projectRoot, trusted);
  const at = settingsAt(projectRoot, trusted);

  const preset: HarnessRuntimeConfig = {
    ...(options.projectInstructions === undefined &&
      defaults.projectInstructions && { instructions: { projectFiles: true } }),
    ...(pieces.subagents && {
      subagents: {
        files,
        approvalMode: 'bubble',
        agents: { 'general-purpose': GENERAL_PURPOSE },
      },
    }),
    ...((options.commands === undefined ? defaults.commands : options.commands !== false) && {
      commands: { files },
    }),
    ...(options.compaction !== false && { context: { clearToolOutputs: true } }),
    limits: { maxToolResultLength: DEFAULT_MAX_TOOL_RESULT_LENGTH },
  };

  const given = options.permissions;
  const permissions: PermissionsConfig = {};
  if (given !== false) {
    if (given?.settings !== undefined) permissions.settings = given.settings;
    else if (options.settings) permissions.settings = at;
    if (given?.classifier) permissions.classifier = given.classifier;
    if (given?.rememberIn) permissions.rememberIn = given.rememberIn;
    if (given?.rememberLayers) permissions.rememberLayers = given.rememberLayers;
  }
  const hooks: HooksConfig =
    options.hooks === false ? {} : { ...(options.settings && { settings: at }), ...options.hooks };
  const toolResults = options.toolResults;
  const limits = {
    ...(toolResults?.maxLength !== undefined && { maxToolResultLength: toolResults.maxLength }),
    ...(toolResults?.retention !== undefined && { toolResultRetention: toolResults.retention }),
  };

  const explicit: HarnessRuntimeConfig = {
    ...(options.projectInstructions !== undefined && {
      instructions: { projectFiles: options.projectInstructions },
    }),
    ...(Object.keys(permissions).length > 0 && { permissions }),
    ...(Object.keys(hooks).length > 0 && { hooks }),
    ...(pieces.subagents &&
      typeof options.subagents === 'object' && { subagents: options.subagents }),
    ...(typeof options.commands === 'object' && { commands: options.commands }),
    ...(options.budget && { budget: options.budget }),
    ...(options.memory && { memory: options.memory }),
    ...(typeof options.compaction === 'object' && { context: options.compaction }),
    ...(Object.keys(limits).length > 0 && { limits }),
  };

  const off = new Set<(typeof MERGED_KEYS)[number]>([
    ...(options.subagents === false ? (['subagents'] as const) : []),
    ...(options.commands === false ? (['commands'] as const) : []),
    ...(options.permissions === false ? (['permissions'] as const) : []),
    ...(options.hooks === false ? (['hooks'] as const) : []),
    ...(options.compaction === false ? (['context'] as const) : []),
  ]);
  return {
    defaults: preset,
    explicit,
    off,
    settingsOff: options.settings === false,
    memoryFiles: options.memoryFiles ?? defaults.memoryFiles,
    memoryFilesOff: options.memoryFiles === false,
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

/** `base` between the preset's defaults and what you passed, see `HarnessAgent.mergeConfig` */
function composeConfig(layers: ConfigLayers, given: CogitatorConfig): CogitatorConfig {
  const base = baseWithout(layers, given);
  const merged: CogitatorConfig = { ...base };
  for (const key of MERGED_KEYS) mergeSection(merged, key, layers, base);
  const memory = merged.memory;
  if (memory?.files !== undefined && layers.memoryFilesOff) {
    const { files: _files, ...rest } = memory;
    merged.memory = rest;
  } else if (layers.memoryFiles && memory?.adapter !== undefined && memory.files === undefined) {
    merged.memory = { ...memory, files: { scope: 'user' } };
  }
  return merged;
}

/** `base` without the sections and settings you turned off with `false` */
function baseWithout(layers: ConfigLayers, base: CogitatorConfig): CogitatorConfig {
  const kept: CogitatorConfig = { ...base };
  for (const key of layers.off) delete kept[key];
  if (layers.settingsOff) {
    if (kept.permissions?.settings !== undefined) {
      const { settings: _settings, ...rest } = kept.permissions;
      kept.permissions = rest;
    }
    if (kept.hooks?.settings !== undefined) {
      const { settings: _settings, ...rest } = kept.hooks;
      kept.hooks = rest;
    }
  }
  return kept;
}

function mergeSection<K extends (typeof MERGED_KEYS)[number]>(
  target: CogitatorConfig,
  key: K,
  layers: ConfigLayers,
  base: CogitatorConfig
): void {
  const value = deepMerge(deepMerge(layers.defaults[key], base[key]), layers.explicit[key]);
  if (value !== undefined) target[key] = value as CogitatorConfig[K];
}

/** `higher` over `lower`: plain objects merged key by key, anything else replaced when set */
function deepMerge(lower: unknown, higher: unknown): unknown {
  if (higher === undefined) return lower;
  if (!isPlainObject(lower) || !isPlainObject(higher)) return higher;
  const merged: Record<string, unknown> = { ...lower };
  for (const [key, value] of Object.entries(higher)) merged[key] = deepMerge(lower[key], value);
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
