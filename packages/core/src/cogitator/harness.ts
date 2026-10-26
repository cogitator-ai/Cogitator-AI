import {
  CogitatorError,
  ErrorCode,
  type LoadedInstructionFile,
  type Message,
  type ProjectInstructionsOptions,
  type SkillCatalog,
  type TodoItem,
  type Tool,
  type ToolCall,
  type ToolSchema,
  type Workspace,
} from '@cogitator-ai/types';
import type { Agent } from '../agent';
import type { ToolRegistry } from '../registry';
import { getLogger } from '../logger';
import { mergeSkillCatalogs, skillLoadersOf } from '../skills/skill-registry';
import {
  activeSkillsIn,
  availableSkillsSection,
  MAX_PINNED_SKILL_CHARS,
  mayHoldSkill,
  skillContentOf,
  skillKey,
  skillTools,
  USE_SKILL,
} from '../skills/skill-tools';
import {
  isLoadedToolsNote,
  loadedToolsNote,
  toolSearchTool,
  toolsFoundIn,
} from '../tools/tool-search';
import { renderTodos, todosIn, WRITE_TODOS, writeTodosTool } from '../tools/write-todos';
import { nanoid } from 'nanoid';
import { readFileBinding } from '../tools/workspace-tools';
import { getTextContent } from './span-factory';
import { accessKindOf } from '../permissions/rules';
import {
  ProjectInstructionsLoader,
  type InstructionsChunk,
} from '../instructions/project-instructions';

/** How the note about skill instructions compaction left out starts. */
const DROPPED_SKILLS_HEADER =
  'Skills activated earlier whose instructions were left out to save context';

/** How the ids of the `write_todos` calls the run makes up to show a kept todo list start. */
const RECALLED_TODOS_ID = 'cogitator_todos_';

/**
 * A `write_todos` call with its result, made up to show the model a todo list it wrote before
 * (kept in the thread metadata, or dropped by a compaction): the model reads it as its own call,
 * and `todosIn()` reads the list back from it, also from a checkpoint or a `history` that goes on
 * from these messages. It goes after the newest message, where a call and its result fit for
 * every provider.
 */
export function todosRecall(todos: readonly TodoItem[]): Message[] {
  const id = `${RECALLED_TODOS_ID}${nanoid(10)}`;
  const call: Message & { toolCalls: ToolCall[] } = {
    role: 'assistant',
    content: '',
    toolCalls: [
      { id, name: WRITE_TODOS, arguments: { todos: todos.map((todo) => ({ ...todo })) } },
    ],
  };
  return [call, { role: 'tool', content: renderTodos(todos), toolCallId: id, name: WRITE_TODOS }];
}

/**
 * The paths a call of a tool that reads or edits files touches: its `access.paths`, else its
 * `path` or `file_path` argument. None for other tools
 */
export function touchedPaths(tool: Tool, args: Record<string, unknown>): string[] {
  const kind = accessKindOf(tool);
  if (kind !== 'read' && kind !== 'edit') return [];
  if (tool.access?.paths) {
    try {
      return [...tool.access.paths(args)];
    } catch {
      return [];
    }
  }
  const value = args.path ?? args.file_path ?? args.filePath;
  return typeof value === 'string' ? [value] : [];
}

/** Whether `message` is part of a {@link todosRecall}. */
function isTodosRecall(message: Message): boolean {
  if (message.role === 'tool') return message.toolCallId?.startsWith(RECALLED_TODOS_ID) === true;
  if (message.role !== 'assistant' || !('toolCalls' in message)) return false;
  const calls: unknown = message.toolCalls;
  return (
    Array.isArray(calls) &&
    calls.length === 1 &&
    (calls as ToolCall[])[0]?.id.startsWith(RECALLED_TODOS_ID) === true
  );
}

export interface RunHarnessOptions {
  /** The run's conversation, as it is when a tool asks */
  conversation: () => readonly Message[];
  /** The tools of the agent the run is in, as they are when a tool asks */
  registry: () => ToolRegistry;
  /** The workspace the run gives `owner`'s tools */
  workspaceOf: (owner: Agent) => Workspace | undefined;
  /** Called with the todo list each time `write_todos` changes it */
  onTodos: (todos: TodoItem[]) => Promise<void>;
  /** Aborts when the run is cancelled or times out */
  signal: AbortSignal;
  /** Which project instruction files of the agents' workspaces to read, unset for none */
  instructions?: ProjectInstructionsOptions;
}

/**
 * What a run gives its agents on top of their own tools: the `SKILL.md` skills of their `skills`
 * (`<available_skills>` in the system prompt, `use_skill` and `read_skill_file`), `tool_search`
 * for their deferred tools, and `write_todos` with `todos: true`. The tools a search loaded and
 * the todo list are read back from the conversation each turn, so a run that goes on from saved
 * messages (resumed, forked, a later run of the thread) has them too.
 */
export class RunHarness {
  /**
   * The harness tools registered for the run, by name, with the most characters of their newest
   * outputs clearing leaves alone (`PINNED_TOOL_OUTPUTS` of the run's middleware state)
   */
  readonly pinnedOutputs = new Map<string, number>();
  private readonly catalogs = new Map<Agent, SkillCatalog | undefined>();
  /** The project instructions of each workspace an agent of the run works in */
  private readonly projects = new Map<
    Workspace,
    { loader: ProjectInstructionsLoader; loaded: InstructionsChunk; warned: number }
  >();
  /** Every project instruction file the run read, in order */
  private readonly instructionFiles: LoadedInstructionFile[] = [];
  private readonly found = new Set<string>();
  /** The tools each agent's registry defers by name (`AgentConfig.deferredTools`) */
  private readonly deferredNames = new WeakMap<ToolRegistry, ReadonlySet<string>>();
  private todoList: TodoItem[] | undefined;
  private searchTool?: Tool;
  private todosTool?: Tool;

  constructor(private readonly options: RunHarnessOptions) {}

  /**
   * Finds the `SKILL.md` skills of `owner`, once per agent in a run. A source that fails is logged
   * and skipped, one that is still searching when the run is aborted or times out ends the run.
   *
   * @throws CogitatorError `CONFIGURATION_ERROR` when `owner.config.skills` holds an invalid source
   */
  async prepare(owner: Agent): Promise<void> {
    await this.prepareInstructions(owner);
    if (this.catalogs.has(owner)) return;
    let loaders;
    try {
      loaders = skillLoadersOf(owner.config.skills);
    } catch (error) {
      throw new CogitatorError({
        message: `The skills of agent "${owner.name}" are invalid: ${error instanceof Error ? error.message : String(error)}`,
        code: ErrorCode.CONFIGURATION_ERROR,
        cause: error instanceof Error ? error : undefined,
      });
    }
    if (loaders.length === 0) {
      this.catalogs.set(owner, undefined);
      return;
    }
    const { signal } = this.options;
    const workspace = this.options.workspaceOf(owner);
    const catalogs: SkillCatalog[] = [];
    for (const loader of loaders) {
      signal.throwIfAborted();
      try {
        catalogs.push(
          await untilAborted(loader.discover({ ...(workspace && { workspace }), signal }), signal)
        );
      } catch (error) {
        if (signal.aborted) throw abortReason(signal);
        getLogger().warn('Could not load the skills of an agent, it runs without them', {
          agent: owner.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const catalog = catalogs.length > 0 ? mergeSkillCatalogs(catalogs) : undefined;
    this.catalogs.set(owner, catalog && catalog.skills.length > 0 ? catalog : undefined);
  }

  /**
   * Reads the project instructions of `owner`'s workspace, once per workspace in a run. A
   * problem with a file is logged and the file left out
   */
  private async prepareInstructions(owner: Agent): Promise<void> {
    const options = this.options.instructions;
    const workspace = this.options.workspaceOf(owner);
    if (!options || !workspace || this.projects.has(workspace)) return;
    const loader = new ProjectInstructionsLoader(workspace, options);
    const loaded = await loader.load(this.options.signal);
    for (const warning of loader.warnings) {
      getLogger().warn('Project instructions', { warning, workspace: workspace.id });
    }
    this.projects.set(workspace, { loader, loaded, warned: loader.warnings.length });
    this.instructionFiles.push(...loaded.files);
  }

  /** The system prompt of `owner`: its instructions, the project's, and the skills it can activate. */
  systemPrompt(owner: Agent): string {
    const catalog = this.catalogs.get(owner);
    const workspace = this.options.workspaceOf(owner);
    const project = workspace ? this.projects.get(workspace)?.loaded.text : undefined;
    return [
      owner.instructions,
      ...(project ? [project] : []),
      ...(catalog ? [availableSkillsSection(catalog.skills)] : []),
    ].join('\n\n');
  }

  /** The project instruction files the run read so far, in prompt order */
  get instructions(): readonly LoadedInstructionFile[] {
    return this.instructionFiles;
  }

  /**
   * Counts files a resumed run read before it paused, as the run's own: in the list, and against
   * the size limit, the ones this run did not read again (a nested file, a scoped rule)
   */
  restoreInstructions(files: readonly LoadedInstructionFile[]): void {
    const known = new Set(this.instructionFiles.map((file) => file.path));
    const earlier = files.filter((file) => !known.has(file.path));
    this.instructionFiles.unshift(...earlier);
    const chars = earlier.reduce((sum, file) => sum + file.chars, 0);
    for (const project of this.projects.values()) project.loader.reserve(chars);
  }

  /**
   * The project instructions tool calls reaching `paths` bring for `owner`: the files of the
   * directories below the working directory and the rules scoped to those paths that the
   * conversation does not hold yet, the same file with the same content (the file of another
   * workspace at the same relative path is not taken for it). Undefined when they bring nothing
   */
  async reach(
    owner: Agent,
    paths: readonly string[],
    messages: readonly Message[]
  ): Promise<InstructionsChunk | undefined> {
    const workspace = this.options.workspaceOf(owner);
    const project = workspace ? this.projects.get(workspace) : undefined;
    if (!project || paths.length === 0) return undefined;
    const held = messages
      .filter((message) => message.role === 'system')
      .map((message) => getTextContent(message.content));
    const chunk = await project.loader.reach(
      paths,
      (_path, block) => held.some((text) => text.includes(block)),
      this.options.signal
    );
    for (const warning of project.loader.warnings.slice(project.warned)) {
      getLogger().warn('Project instructions', { warning, workspace: workspace?.id });
    }
    project.warned = project.loader.warnings.length;
    if (chunk.text === '') return undefined;
    this.instructionFiles.push(...chunk.files);
    return chunk;
  }

  /**
   * Adds the harness tools of `owner` to `registry`, which holds its other tools already: those
   * keep their names, a harness tool of the same name is left out.
   */
  addTools(owner: Agent, registry: ToolRegistry): void {
    this.deferredNames.set(registry, new Set(owner.config.deferredTools ?? []));
    const add = (harnessTool: Tool, pinned?: number) => {
      if (registry.has(harnessTool.name)) return;
      registry.register(harnessTool);
      if (pinned !== undefined) this.pinnedOutputs.set(harnessTool.name, pinned);
    };
    const catalog = this.catalogs.get(owner);
    if (catalog) {
      const workspace = this.options.workspaceOf(owner);
      const reader = registry.get('read_file');
      const binding = reader ? readFileBinding(reader) : undefined;
      const workspaceReadFile =
        binding !== undefined &&
        workspace !== undefined &&
        (binding.workspace ?? workspace) === workspace;
      for (const skillTool of skillTools({
        catalog,
        workspaceReadFile,
        conversation: this.options.conversation,
      })) {
        add(skillTool, skillTool.name === USE_SKILL ? MAX_PINNED_SKILL_CHARS : undefined);
      }
    }
    if (owner.config.todos) {
      this.todosTool ??= writeTodosTool(async (todos) => {
        this.todoList = todos;
        await this.options.onTodos(todos);
      });
      add(this.todosTool, Infinity);
    }
    if (registry.getAll().some((candidate) => this.isDeferred(registry, candidate))) {
      this.searchTool ??= toolSearchTool({
        deferred: () => {
          const current = this.options.registry();
          return current.getAll().filter((candidate) => this.isDeferred(current, candidate));
        },
        onFound: (names) => {
          for (const name of names) this.found.add(name);
        },
      });
      add(this.searchTool, Infinity);
    }
  }

  /**
   * The schemas a turn sends: every tool of `registry` but the deferred ones no `tool_search` of
   * the run (or of `messages`) loaded. `forced`, the tool the turn must call, is loaded from then
   * on.
   */
  schemas(registry: ToolRegistry, messages: readonly Message[], forced?: string): ToolSchema[] {
    if (!registry.getAll().some((candidate) => this.isDeferred(registry, candidate))) {
      return registry.getSchemas();
    }
    for (const name of toolsFoundIn(messages)) this.found.add(name);
    if (forced !== undefined) this.found.add(forced);
    return registry.getSchemas(
      (candidate) => !this.isDeferred(registry, candidate) || this.found.has(candidate.name)
    );
  }

  /** Whether `candidate` waits for `tool_search`: deferred itself, or by name for the registry's agent */
  private isDeferred(registry: ToolRegistry, candidate: Tool): boolean {
    return (
      candidate.deferred === true || this.deferredNames.get(registry)?.has(candidate.name) === true
    );
  }

  /**
   * `messages` without the skill instructions compaction kept that `target` has no skill for: a
   * handoff takes along only the instructions of the skills the agent it hands over to has
   */
  forHandoff(target: Agent, messages: readonly Message[]): Message[] {
    const keys = new Set(this.catalogs.get(target)?.skills.map(skillKey) ?? []);
    return messages.filter((message) => {
      if (message.role !== 'system') return true;
      const content = skillContentOf(getTextContent(message.content));
      return !content || keys.has(content.key);
    });
  }

  /**
   * The `allowed-tools` of the skills of `owner` whose instructions `messages` hold, the skills
   * active in the conversation, by skill name. `workspaceTrusted: false` leaves out the skills found
   * in the workspace, which an untrusted project supplies
   */
  activeSkillRules(
    owner: Agent,
    messages: readonly Message[],
    workspaceTrusted = true
  ): Array<{ name: string; rules: readonly string[] }> {
    const catalog = this.catalogs.get(owner);
    if (!catalog) return [];
    const active = activeSkillsIn(messages);
    if (active.size === 0) return [];
    return catalog.skills
      .filter(
        (skill) =>
          skill.allowedTools !== undefined &&
          active.has(skillKey(skill)) &&
          (workspaceTrusted || skill.source !== 'workspace')
      )
      .map((skill) => ({ name: skill.name, rules: skill.allowedTools ?? [] }));
  }

  /** The run's todo list, once it has one */
  get todos(): TodoItem[] | undefined {
    return this.todoList;
  }

  /**
   * Takes the todo list the run goes on from: the one `messages` last wrote, else the one `kept`
   * gives (the copy in the thread's metadata), read only then. Returns where the list came from.
   */
  async restoreTodos(
    messages: readonly Message[],
    kept: () => Promise<TodoItem[] | undefined>
  ): Promise<{ todos: TodoItem[]; from: 'messages' | 'kept' } | undefined> {
    const written = todosIn(messages);
    if (written) {
      this.todoList = written;
      return { todos: written, from: 'messages' };
    }
    const stored = await kept();
    if (!stored) return undefined;
    this.todoList = stored;
    return { todos: stored, from: 'kept' };
  }
}

/** `promise`, or the abort reason once `signal` aborts first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

/** Why `signal` aborted, as an error. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason ?? 'Aborted'));
}

/** What a conversation holds that the model must not lose to a compaction. */
interface Pinned {
  /** Instructions of active skills, oldest first, by skill key */
  skills: Map<string, { name: string; text: string }>;
  /** The newest todo list */
  todos?: TodoItem[];
  /** Tools `tool_search` loaded */
  tools: Set<string>;
}

function pinnedIn(messages: readonly Message[]): Pinned {
  const skills = new Map<string, { name: string; text: string }>();
  for (const message of messages) {
    if (!mayHoldSkill(message)) continue;
    const text = getTextContent(message.content);
    const content = skillContentOf(text);
    if (!content) continue;
    skills.delete(content.key);
    skills.set(content.key, { name: content.name, text });
  }
  const todos = todosIn(messages);
  return { skills, ...(todos !== undefined && { todos }), tools: toolsFoundIn(messages) };
}

/** Whether `message` is a system message the harness put into a conversation. */
function isHarnessNote(message: Message): boolean {
  if (message.role !== 'system') return false;
  const text = getTextContent(message.content);
  return (
    skillContentOf(text) !== undefined ||
    text.startsWith(DROPPED_SKILLS_HEADER) ||
    isLoadedToolsNote(message)
  );
}

/**
 * The system messages that put back into `after` what the model must not lose from `before`:
 * the instructions of active skills `after` lacks (the newest first, at most
 * {@link MAX_PINNED_SKILL_CHARS} characters, a short note naming the rest) and the tools
 * `tool_search` loaded that `after` does not name. The todo list comes back apart, see
 * {@link todosToRecall}.
 */
function notesFor(pinned: Pinned, after: readonly Message[]): Message[] {
  const active = activeSkillsIn(after);
  const skills: Message[] = [];
  const left: string[] = [];
  let budget = MAX_PINNED_SKILL_CHARS;
  for (const [key, skill] of [...pinned.skills].reverse()) {
    if (active.has(key)) continue;
    if (skill.text.length <= budget) {
      budget -= skill.text.length;
      skills.unshift({ role: 'system', content: skill.text });
    } else {
      left.push(skill.name);
    }
  }
  const notes = [...skills];
  if (left.length > 0) {
    notes.push({
      role: 'system',
      content: `${DROPPED_SKILLS_HEADER}: ${left.join(', ')}. Call ${USE_SKILL} again for one before you rely on it.`,
    });
  }
  const shown = toolsFoundIn(after);
  const missing = [...pinned.tools].filter((name) => !shown.has(name));
  if (missing.length > 0) notes.push(loadedToolsNote(missing));
  return notes;
}

/**
 * The system messages a compaction of `messages` may have to put back, as if it dropped
 * everything: what to keep room for when compacting
 */
export function pinnedNotes(messages: readonly Message[]): Message[] {
  const pinned = pinnedIn(messages);
  return [...notesFor(pinned, []), ...todosToRecall(pinned, [])];
}

/** The {@link todosRecall} of the newest todo list of `pinned`, when `after` does not hold it. */
function todosToRecall(pinned: Pinned, after: readonly Message[]): Message[] {
  if (pinned.todos === undefined) return [];
  const shown = todosIn(after);
  return shown && JSON.stringify(shown) === JSON.stringify(pinned.todos)
    ? []
    : todosRecall(pinned.todos);
}

/**
 * `after`, a compaction of `before`, with what the model must not lose put back: the
 * instructions of the skills `before` activated and `after` dropped (within
 * {@link MAX_PINNED_SKILL_CHARS}) and the tools a `tool_search` of `before` loaded as system
 * messages after the system prompt, and the newest todo list, when `after` no longer holds it, as
 * a {@link todosRecall} after the newest message. What an earlier compaction put back is
 * replaced, never piled up. Unchanged when nothing was lost.
 */
export function keepThroughCompaction(
  before: readonly Message[],
  after: readonly Message[]
): Message[] {
  const pinned = pinnedIn(before);
  const recall = todosToRecall(pinned, after);
  const base = after.filter(
    (message, index) =>
      index === 0 || (!isHarnessNote(message) && (recall.length === 0 || !isTodosRecall(message)))
  );
  const notes = notesFor(pinned, base);
  if (notes.length === 0 && recall.length === 0 && base.length === after.length) return [...after];
  let systemEnd = 0;
  while (systemEnd < base.length && base[systemEnd]?.role === 'system') systemEnd++;
  return [...base.slice(0, systemEnd), ...notes, ...base.slice(systemEnd), ...recall];
}
