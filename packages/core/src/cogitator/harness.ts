import {
  CogitatorError,
  ErrorCode,
  type Message,
  type SkillCatalog,
  type TodoItem,
  type Tool,
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
import { readFileBinding } from '../tools/workspace-tools';
import { getTextContent } from './span-factory';

/** How a note of the todo list starts, when the run shows the list without a `write_todos` result. */
const TODO_NOTE_HEADER =
  'Your todo list from earlier in this conversation (update it with write_todos):';

/** How the note about skill instructions compaction left out starts. */
const DROPPED_SKILLS_HEADER =
  'Skills activated earlier whose instructions were left out to save context';

/** A system message that shows the model its todo list. */
export function todoNote(todos: readonly TodoItem[]): Message {
  return { role: 'system', content: `${TODO_NOTE_HEADER}\n${renderTodos(todos)}` };
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
  private readonly found = new Set<string>();
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

  /** The system prompt of `owner`: its instructions, and the skills it can activate. */
  systemPrompt(owner: Agent): string {
    const catalog = this.catalogs.get(owner);
    return catalog
      ? `${owner.instructions}\n\n${availableSkillsSection(catalog.skills)}`
      : owner.instructions;
  }

  /**
   * Adds the harness tools of `owner` to `registry`, which holds its other tools already: those
   * keep their names, a harness tool of the same name is left out.
   */
  addTools(owner: Agent, registry: ToolRegistry): void {
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
    if (registry.getAll().some((candidate) => candidate.deferred)) {
      this.searchTool ??= toolSearchTool({
        deferred: () =>
          this.options
            .registry()
            .getAll()
            .filter((candidate) => candidate.deferred),
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
    if (!registry.getAll().some((candidate) => candidate.deferred)) return registry.getSchemas();
    for (const name of toolsFoundIn(messages)) this.found.add(name);
    if (forced !== undefined) this.found.add(forced);
    return registry.getSchemas(
      (candidate) => !candidate.deferred || this.found.has(candidate.name)
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
  /** The newest todo list as `renderTodos` wrote it */
  todos?: string;
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
  const todos = latestTodoText(messages);
  return { skills, ...(todos !== undefined && { todos }), tools: toolsFoundIn(messages) };
}

/** Whether `message` is a system message the harness put into a conversation. */
function isHarnessNote(message: Message): boolean {
  if (message.role !== 'system') return false;
  const text = getTextContent(message.content);
  return (
    skillContentOf(text) !== undefined ||
    text.startsWith(`${TODO_NOTE_HEADER}\n`) ||
    text.startsWith(DROPPED_SKILLS_HEADER) ||
    isLoadedToolsNote(message)
  );
}

/**
 * The system messages that put back into `after` what the model must not lose from `before`:
 * the instructions of active skills `after` lacks (the newest first, at most
 * {@link MAX_PINNED_SKILL_CHARS} characters, a short note naming the rest), the newest todo list
 * when `after` does not show it, and the tools `tool_search` loaded that `after` does not name.
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
  if (pinned.todos !== undefined && latestTodoText(after) !== pinned.todos) {
    notes.push({ role: 'system', content: `${TODO_NOTE_HEADER}\n${pinned.todos}` });
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
  return notesFor(pinnedIn(messages), []);
}

/**
 * `after`, a compaction of `before`, with what the model must not lose put back as system
 * messages after the system prompt: the instructions of the skills `before` activated and
 * `after` dropped (within {@link MAX_PINNED_SKILL_CHARS}), the todo list when `after` no longer
 * shows its newest state, and the tools a `tool_search` of `before` loaded. Notes an earlier
 * compaction put back are replaced, never piled up. Unchanged when nothing was lost.
 */
export function keepThroughCompaction(
  before: readonly Message[],
  after: readonly Message[]
): Message[] {
  const base = after.filter((message, index) => index === 0 || !isHarnessNote(message));
  const notes = notesFor(pinnedIn(before), base);
  if (notes.length === 0 && base.length === after.length) return [...after];
  let systemEnd = 0;
  while (systemEnd < base.length && base[systemEnd]?.role === 'system') systemEnd++;
  return [...base.slice(0, systemEnd), ...notes, ...base.slice(systemEnd)];
}

/** The newest todo list `messages` show the model, as `renderTodos` wrote it. */
function latestTodoText(messages: readonly Message[]): string | undefined {
  let latest: string | undefined;
  for (const message of messages) {
    const text = getTextContent(message.content);
    if (message.role === 'tool' && message.name === WRITE_TODOS && text.startsWith('Todo list')) {
      latest = text;
    } else if (message.role === 'system' && text.startsWith(`${TODO_NOTE_HEADER}\n`)) {
      latest = text.slice(TODO_NOTE_HEADER.length + 1);
    }
  }
  return latest;
}
