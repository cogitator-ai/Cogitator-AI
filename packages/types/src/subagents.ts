/**
 * Subagents and commands from Markdown files, in the format of Claude Code: agents a run hands
 * tasks to (`.claude/agents/*.md`) and user message templates (`.claude/commands/*.md`)
 */

import type { HookSettings } from './hooks';
import type { ReasoningEffort } from './llm';
import type { Message } from './message';
import type { PermissionMode } from './permissions';
import type { Tool } from './tool';
import type {
  RunCheckpoint,
  RunOptions,
  RunResult,
  RunUsage,
  ToolApprovalDecision,
} from './runtime';

/** Something wrong with a Markdown definition: `error` skipped it, `warning` loaded it anyway */
export interface DefinitionDiagnostic {
  readonly level: 'error' | 'warning';
  readonly message: string;
  /** The file it is about */
  readonly path: string;
}

/**
 * Where a subagent or a command comes from, highest precedence first: the organization's managed
 * directory, code (`SubagentsConfig.agents`, as Claude Code's `--agents` JSON), the project's
 * folders and the user's folders
 */
export type DefinitionSource = 'managed' | 'code' | 'project' | 'user';

/** Where a subagent keeps what it learns across sessions, see {@link SubagentDefinition.memory} */
export type SubagentMemoryScope = 'user' | 'project' | 'local';

/** Display colors Claude Code accepts for a subagent */
export type SubagentColor =
  'red' | 'blue' | 'green' | 'yellow' | 'purple' | 'orange' | 'pink' | 'cyan';

/**
 * An MCP server a subagent gets: the name of a server whose tools the run already has (it shares
 * that connection), or a server defined inline, its config as `.mcp.json` writes one
 */
export type SubagentMcpServer =
  string | { name: string; config: Readonly<Record<string, unknown>> };

/** A subagent, as the frontmatter and the body of its Markdown file define it */
export interface SubagentDefinition {
  /** Unique name the model asks for (`subagent_type`) and hooks match (`agent_type`) */
  name: string;
  /** When to delegate to it */
  description: string;
  /** The system prompt: the Markdown body */
  prompt: string;
  /**
   * The tools it may use, in the grammar of permission rules (`Read`, `Bash`, `mcp__github__*`,
   * a tool's own name). Unset, it inherits the tools of the agent that delegates
   */
  tools?: readonly string[];
  /** Tools taken away from the inherited or listed ones, applied before `tools` */
  disallowedTools?: readonly string[];
  /**
   * `inherit` (the delegating agent's model, the default), a short name of `llm.modelAliases`
   * (`sonnet`, `opus`, `haiku`, `fable`), or a model as `provider/model`
   */
  model?: string;
  /**
   * The permission mode it runs in. It only ever narrows the delegating run's mode: a mode that
   * would let it do more than the run that delegates (`acceptEdits` under `default`) is ignored
   */
  permissionMode?: PermissionMode;
  /** Most model turns before it stops, its `maxIterations` */
  maxTurns?: number;
  /** Skills whose full instructions are put into its system prompt when it starts */
  skills?: readonly string[];
  /** MCP servers it gets on top of the inherited tools */
  mcpServers?: readonly SubagentMcpServer[];
  /** Hooks that run only while it runs, `Stop` ones as `SubagentStop` */
  hooks?: HookSettings;
  /** A folder of notes it keeps across sessions, `MEMORY.md` read into its prompt */
  memory?: SubagentMemoryScope;
  /** Always run it in the background, whatever the call asks */
  background?: boolean;
  /** `worktree`: run it in a git worktree of its own, removed again when it changed nothing */
  isolation?: 'worktree';
  color?: SubagentColor;
  /** The reasoning effort of its model calls */
  effort?: ReasoningEffort;
  source: DefinitionSource;
  /** The file it was read from, unset for one in code */
  path?: string;
}

/** A subagent defined in code, as an entry of Claude Code's `--agents` JSON */
export type SubagentDefinitionInput = Omit<
  SubagentDefinition,
  'name' | 'source' | 'path' | 'prompt'
> & {
  /** The system prompt (default: none, the agent works from the task alone) */
  prompt?: string;
};

/** The subagents a run may delegate to, and what was wrong with the files */
export interface SubagentCatalog {
  readonly agents: readonly SubagentDefinition[];
  readonly diagnostics: readonly DefinitionDiagnostic[];
  get(name: string): SubagentDefinition | undefined;
}

/**
 * Where Markdown definitions (`agents/*.md`, `commands/*.md`) are read. The project's folders
 * count only once the project is trusted: they come from the repository, and a subagent runs
 * tools and hooks
 */
export interface DefinitionFileOptions {
  /**
   * The project root whose `.agents/`, `.cogitator/` and `.claude/` folders are read. Default: the
   * root of `permissions.settings`, else the run's workspace root, else the working directory
   */
  root?: string;
  /**
   * Directories of the user's own definitions (default `~/.agents`, `~/.cogitator` and
   * `CLAUDE_CONFIG_DIR` or `~/.claude`), `[]` for none
   */
  userDirs?: readonly string[];
  /** Directories of the organization's definitions (default the managed settings directories) */
  managedDirs?: readonly string[];
  /** More folders of definitions the host trusts, read before the project's */
  dirs?: readonly string[];
  /**
   * Trust the project at `root` (default false), so its folders are read. With `true` for the
   * files, `permissions.settings.trusted` and its root count too
   */
  trusted?: boolean;
  /** Absolute project roots that are trusted, for a host that serves several projects */
  trustedRoots?: readonly string[];
}

/**
 * Which messages of the delegating run the delegate reads before its task: none (default, the
 * delegate works from the task alone, as in Claude Code), the conversation's user messages and
 * answers without tool calls (`conversation`), or what a function picks. Whatever it picks, tool
 * calls without results and system messages are left out
 */
export type DelegationMessages =
  'none' | 'conversation' | ((messages: readonly Message[]) => readonly Message[]);

/** A run handed a task to another agent */
export interface DelegationStartEvent {
  /** The run that delegates */
  parentRunId: string;
  /** The agent of that run */
  parentAgent: string;
  /** The tool call that delegates, when a tool call does */
  toolCallId?: string;
  /** The agent the task goes to */
  agent: string;
  task: string;
  /** The id `send_message` and `task_output` know the delegated agent by */
  taskId?: string;
  background: boolean;
}

/** A delegated task ended */
export interface DelegationCompleteEvent extends DelegationStartEvent {
  /**
   * `completed`, `paused` (it waits on an approval or a question that bubbled up or was
   * declined), `failed` or `stopped` (aborted)
   */
  status: 'completed' | 'paused' | 'failed' | 'stopped';
  output: string;
  /** The delegated run, once it ran */
  runId?: string;
  error?: string;
  usage?: RunUsage;
}

/** Hears of delegated tasks, see {@link DelegationStartEvent} */
export interface DelegationHooks {
  onDelegationStart?: (event: DelegationStartEvent) => void;
  onDelegationComplete?: (event: DelegationCompleteEvent) => void;
}

/**
 * What happens to an approval or a question a delegated run stops at: `decline` (default) answers
 * it no, so the delegate goes on without the call, `bubble` pauses the run that delegated, with
 * the delegate's checkpoint inside its own (`turn.children`), and a resume answers it there
 */
export type DelegationApprovalMode = 'bubble' | 'decline';

/** The MCP servers a subagent defines inline, connected while it runs */
export interface SubagentMcpConnection {
  tools: readonly Tool[];
  close(): Promise<void>;
}

/** Connects the inline MCP servers of a subagent, see `SubagentsConfig.mcp` */
export type SubagentMcpConnector = (
  servers: readonly { name: string; config: Readonly<Record<string, unknown>> }[],
  context: { agent: string; signal: AbortSignal }
) => Promise<SubagentMcpConnection>;

/** Subagents of a runtime, see `CogitatorConfig.subagents` */
export interface SubagentsConfig extends DelegationHooks {
  /**
   * Read Markdown subagents from `agents/` folders: `true` for the default places (the user's
   * folders, the managed ones, and the project's once it is trusted), or where to read
   */
  files?: boolean | DefinitionFileOptions;
  /** Subagents in code, by name, as Claude Code's `--agents` JSON defines them */
  agents?: Readonly<Record<string, SubagentDefinitionInput>>;
  /** What happens to a delegate's approvals and questions (default `decline`) */
  approvalMode?: DelegationApprovalMode;
  /**
   * How the model reaches them: one `agent` tool that takes `subagent_type` (default, as Claude
   * Code's `Agent` tool), a tool per subagent named after it (`each`), or both
   */
  tools?: 'agent' | 'each' | 'both';
  /** How many layers of subagents may run below a run nobody delegated (default 3) */
  maxDepth?: number;
  /**
   * Most background subagents running at once in this runtime (default 20). A run that would stop
   * waits for the background subagents it started and reads their results first, one that pauses
   * or fails stops them
   */
  maxBackground?: number;
  /** Which messages of the delegating run a delegate reads (default `none`) */
  messages?: DelegationMessages;
  /** Connects the MCP servers subagents define inline. Without it they are skipped with a warning */
  mcp?: SubagentMcpConnector;
  /** Hears of each problem found in a definition file, once */
  onDiagnostic?: (diagnostic: DefinitionDiagnostic) => void;
}

/** The paused delegated run a tool call left, handed back to the call when its run resumes */
export interface DelegatedResume {
  /** Where the delegated run paused */
  checkpoint: RunCheckpoint;
  /** Decisions for its approvals, by its own tool call ids */
  decisions: Record<string, ToolApprovalDecision>;
  /** Answers to its interrupts, by its own interrupt ids */
  responses: Record<string, unknown>;
  /** The decision for every approval left out, when the resume gave one */
  defaultDecision?: ToolApprovalDecision;
}

/** What a tool that hands work to another agent gets from its run, see `ToolContext.delegation` */
export interface ToolDelegationContext {
  /** The run's conversation as it is now, system messages included */
  conversation(): readonly Message[];
  /**
   * Decides approvals the way the run decides its own (`RunOptions.onApproval`), for a delegate
   * whose approvals bubble up. Unset when the run has none
   */
  onApproval?: RunOptions['onApproval'];
  /** The paused delegate an earlier execution of this call left, when the run resumes with it */
  resume?: DelegatedResume;
  /** How many runs delegated down to this one: 0 for a run nobody delegated to */
  depth: number;
}

/** A command, as the frontmatter and the body of its Markdown file define it */
export interface CommandDefinition {
  /** What follows the `/`: the file's path under `commands/` with `:` between folders */
  name: string;
  description?: string;
  /** What arguments it expects, for a client's autocomplete, such as `[issue-number]` */
  argumentHint?: string;
  /** Names of positional arguments for `$name` placeholders, in order */
  arguments?: readonly string[];
  /** Permission rules allowed without asking for the run the command starts */
  allowedTools?: readonly string[];
  /** Tools taken away from the run the command starts, as a subagent's `disallowedTools` */
  disallowedTools?: readonly string[];
  /** The model of the run it starts, as a subagent's `model` names one */
  model?: string;
  /** The reasoning effort of the run it starts */
  effort?: ReasoningEffort;
  /** The message template: the Markdown body */
  template: string;
  source: DefinitionSource;
  path?: string;
}

/** A command in code */
export type CommandDefinitionInput = Omit<CommandDefinition, 'name' | 'source' | 'path'>;

/** Commands of a runtime, see `CogitatorConfig.commands` */
export interface CommandsConfig {
  /**
   * Read Markdown commands from `commands/` folders: `true` for the default places (the user's
   * folders, the managed ones, and the project's once it is trusted), or where to read
   */
  files?: boolean | DefinitionFileOptions;
  /** Commands in code, by name, as a template or a definition */
  commands?: Readonly<Record<string, string | CommandDefinitionInput>>;
  /** Hears of each problem found in a command file, once */
  onDiagnostic?: (diagnostic: DefinitionDiagnostic) => void;
}

/** A run's input that named a command, as the runtime expanded it */
export interface ExpandedCommand {
  name: string;
  /** What followed the name, as typed */
  arguments: string;
  /** The message the run got instead of the input */
  input: string;
  allowedTools?: readonly string[];
  disallowedTools?: readonly string[];
  model?: string;
  effort?: ReasoningEffort;
  source: DefinitionSource;
  path?: string;
}

/** A background subagent, as `task_output` reports it */
export interface BackgroundSubagentStatus {
  taskId: string;
  agent: string;
  status: 'running' | 'completed' | 'paused' | 'failed' | 'stopped';
  output?: string;
  error?: string;
  /** The run it went on in last */
  result?: RunResult;
}
