import type {
  Message,
  SkillCatalog,
  TodoItem,
  Tool,
  ToolSchema,
  Workspace,
} from '@cogitator-ai/types';
import type { Agent } from '../agent';
import type { ToolRegistry } from '../registry';
import { getLogger } from '../logger';
import { mergeSkillCatalogs, skillLoadersOf } from '../skills/skill-registry';
import {
  activeSkillsIn,
  availableSkillsSection,
  mayHoldSkill,
  skillContentName,
  skillTools,
} from '../skills/skill-tools';
import { toolSearchTool, toolsFoundIn } from '../tools/tool-search';
import { renderTodos, todosIn, WRITE_TODOS, writeTodosTool } from '../tools/write-todos';
import { readFileBinding } from '../tools/workspace-tools';
import { getTextContent } from './span-factory';

/** How a note of the todo list starts, when the run shows the list without a `write_todos` result. */
const TODO_NOTE_HEADER =
  'Your todo list from earlier in this conversation (update it with write_todos):';

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
}

/**
 * What a run gives its agents on top of their own tools: the `SKILL.md` skills of their `skills`
 * (`<available_skills>` in the system prompt, `use_skill` and `read_skill_file`), `tool_search`
 * for their deferred tools, and `write_todos` with `todos: true`. The tools a search loaded and
 * the todo list are read back from the conversation each turn, so a run that goes on from saved
 * messages (resumed, forked, a later run of the thread) has them too.
 */
export class RunHarness {
  private readonly catalogs = new Map<Agent, SkillCatalog | undefined>();
  private readonly found = new Set<string>();
  private todoList: TodoItem[] | undefined;
  private searchTool?: Tool;
  private todosTool?: Tool;

  constructor(private readonly options: RunHarnessOptions) {}

  /** Finds the `SKILL.md` skills of `owner`, once per agent in a run. A source that fails is logged and skipped. */
  async prepare(owner: Agent): Promise<void> {
    if (this.catalogs.has(owner)) return;
    const loaders = skillLoadersOf(owner.config.skills);
    if (loaders.length === 0) {
      this.catalogs.set(owner, undefined);
      return;
    }
    const workspace = this.options.workspaceOf(owner);
    const catalogs: SkillCatalog[] = [];
    for (const loader of loaders) {
      try {
        catalogs.push(await loader.discover(workspace ? { workspace } : {}));
      } catch (error) {
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
    const add = (harnessTool: Tool) => {
      if (!registry.has(harnessTool.name)) registry.register(harnessTool);
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
        add(skillTool);
      }
    }
    if (owner.config.todos) {
      this.todosTool ??= writeTodosTool(async (todos) => {
        this.todoList = todos;
        await this.options.onTodos(todos);
      });
      add(this.todosTool);
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
      add(this.searchTool);
    }
  }

  /**
   * The schemas a turn sends: every tool of `registry` but the deferred ones no `tool_search` of
   * the run (or of `messages`) loaded, and `forced`, the tool the turn must call.
   */
  schemas(registry: ToolRegistry, messages: readonly Message[], forced?: string): ToolSchema[] {
    if (!registry.getAll().some((candidate) => candidate.deferred)) return registry.getSchemas();
    for (const name of toolsFoundIn(messages)) this.found.add(name);
    return registry.getSchemas(
      (candidate) =>
        !candidate.deferred || this.found.has(candidate.name) || candidate.name === forced
    );
  }

  /** The run's todo list, once it has one */
  get todos(): TodoItem[] | undefined {
    return this.todoList;
  }

  /**
   * Takes the todo list the run goes on from: the one `messages` last wrote, else the one `kept`
   * gives (the copy in the thread's metadata), read only then. Returns the list when it came from
   * `kept`, so the run shows it to the model.
   */
  async restoreTodos(
    messages: readonly Message[],
    kept: () => Promise<TodoItem[] | undefined>
  ): Promise<TodoItem[] | undefined> {
    const written = todosIn(messages);
    if (written) {
      this.todoList = written;
      return undefined;
    }
    const stored = await kept();
    if (stored) this.todoList = stored;
    return stored;
  }
}

/**
 * `after`, a compaction of `before`, with what the model must not lose put back as system
 * messages after the system prompt: the instructions of every skill `before` activated and
 * `after` dropped, and the todo list when `after` no longer shows its newest state. Unchanged when
 * nothing was lost.
 */
export function keepThroughCompaction(
  before: readonly Message[],
  after: readonly Message[]
): Message[] {
  const skills = new Map<string, string>();
  for (const message of before) {
    if (!mayHoldSkill(message)) continue;
    const text = getTextContent(message.content);
    const name = skillContentName(text);
    if (name !== undefined) skills.set(name, text);
  }
  const todos = latestTodoText(before);

  const active = activeSkillsIn(after);
  const kept: Message[] = [];
  for (const [name, text] of skills) {
    if (!active.has(name)) kept.push({ role: 'system', content: text });
  }
  if (todos !== undefined && latestTodoText(after) !== todos) {
    kept.push({ role: 'system', content: `${TODO_NOTE_HEADER}\n${todos}` });
  }
  if (kept.length === 0) return [...after];
  let systemEnd = 0;
  while (systemEnd < after.length && after[systemEnd]?.role === 'system') systemEnd++;
  return [...after.slice(0, systemEnd), ...kept, ...after.slice(systemEnd)];
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
