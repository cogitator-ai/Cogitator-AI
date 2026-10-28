import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type * as CoreModule from '@cogitator-ai/core';
import type { Agent, FileRewindReport, RewindReport, TimeTravel } from '@cogitator-ai/core';
import { InMemoryAdapter } from '@cogitator-ai/memory';
import { fileCheckpointOf } from '@cogitator-ai/types';
import type {
  ExecutionCheckpoint,
  MemoryEntry,
  RunObserver,
  RunInterrupt,
  RunResult,
  Span,
  Tool,
  ToolApp,
  ToolAppCallResult,
  ToolAppResource,
  ToolApprovalDecision,
  ToolApprovalRequest,
  Workflow,
  WorkflowExecuteOptionsV2,
  WorkflowResult,
  WorkflowState,
} from '@cogitator-ai/types';
import type * as WorkflowsModule from '@cogitator-ai/workflows';
import type * as SwarmsModule from '@cogitator-ai/swarms';
import type {
  FileRestoreSummary,
  ForkOrigin,
  ForkPreview,
  ForkSummary,
  HistoryMessage,
  HostEvent,
  HostRequest,
  InboxChangeRecord,
  MemoryPlace,
  PluginsState,
  RawSpan,
  RegistryInfo,
  ReplayEntry,
  ThreadLineage,
  ThreadReplay,
  RewindRequest,
  RewindSummary,
  RunRecord,
  ThreadForkRequest,
  StepRecord,
  ThreadTree,
  ToolAppCallOutcome,
  TreeEntry,
  UsageInfo,
} from '../protocol.js';
import { describeRegistry } from '../registry.js';
import { z } from 'zod';

/** What an app's tool call returned, as the tool of its server sent it */
function appResult(value: unknown): ToolAppCallResult {
  if (
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    Array.isArray(value.content)
  ) {
    const result: ToolAppCallResult = {
      content: value.content.filter(
        (block): block is ToolAppCallResult['content'][number] =>
          typeof block === 'object' && block !== null && typeof block.type === 'string'
      ),
    };
    if ('structuredContent' in value && isPlainRecord(value.structuredContent)) {
      result.structuredContent = value.structuredContent;
    }
    if ('isError' in value && value.isError === true) result.isError = true;
    return result;
  }
  return { content: [{ type: 'text', text: JSON.stringify(value ?? null) }] };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A tool app request the host refuses, by its code: an unknown app, or a call it may not make */
class ToolAppRefusal extends Error {
  constructor(
    message: string,
    readonly code: 'TOOL_APP_NOT_FOUND' | 'TOOL_APP_FORBIDDEN'
  ) {
    super(message);
    this.name = 'ToolAppRefusal';
  }
}
import { openCheckpointStore } from './checkpoints.js';
import { ProjectPlugins } from './plugins.js';
import { importFromProject, loadProject, type LoadedProject } from './project.js';
import { ProjectTriggers } from './triggers.js';

const CHECKPOINT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const STOPPED = 'Stopped in Cogitator Studio';
const TREE_ENTRIES = 500;
const TREE_TEXT = 280;

/** Which studio request a run belongs to, carried through every run it starts. */
interface RunContext {
  kind: RunRecord['kind'];
  target: string;
  /** The run the request started; set by the first run that starts under it. */
  rootRunId?: string;
  threadId?: string;
  forkOf?: ForkOrigin;
  rerunOf?: { runId: string; fromNode: string };
  started: (runId: string) => void;
}

interface PendingApproval {
  runId: string;
  resolve: (decision: ToolApprovalDecision) => void;
}

function rawSpan(span: Span): RawSpan {
  return {
    id: span.id,
    traceId: span.traceId,
    ...(span.parentId && { parentId: span.parentId }),
    name: span.name,
    status: span.status,
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    attributes: span.attributes,
  };
}

function usageOf(result: RunResult): UsageInfo {
  return {
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cost: result.usage.cost,
    duration: result.usage.duration,
  };
}

/** The tool calls of a run with what each returned, from its messages. */
function toolCallsOf(result: RunResult) {
  const results = new Map<string, string>();
  for (const entry of result.messages) {
    if (entry.role === 'tool' && entry.toolCallId && typeof entry.content === 'string') {
      results.set(entry.toolCallId, entry.content);
    }
  }
  return result.toolCalls.map((call) => {
    const raw = results.get(call.id);
    let value: unknown = raw;
    if (raw !== undefined) {
      try {
        value = JSON.parse(raw) as unknown;
      } catch {
        value = raw;
      }
    }
    return {
      id: call.id,
      name: call.name,
      arguments: plain(call.arguments),
      ...(raw !== undefined && { result: plain(value) }),
    };
  });
}

/** Where a run wrote in memory, from a runtime that reports it. */
function memoryOf(result: RunResult): MemoryPlace | undefined {
  const place = result.memory;
  if (!place) return undefined;
  return {
    threadId: place.threadId,
    branchPoint: place.branchPoint,
    ...(place.leafId && { leafId: place.leafId }),
  };
}

function treeEntry(entry: MemoryEntry): TreeEntry {
  const content = entry.message.content;
  const text =
    typeof content === 'string'
      ? content
      : content.map((part) => (part.type === 'text' ? part.text : `[${part.type}]`)).join(' ');
  return {
    id: entry.id,
    ...(entry.parentId !== undefined && { parentId: entry.parentId }),
    type: entry.type ?? (entry.message.role === 'tool' ? 'tool_result' : 'message'),
    role: entry.message.role,
    text: text.length > TREE_TEXT ? `${text.slice(0, TREE_TEXT)}…` : text,
    ...(entry.toolCalls?.length && { toolCalls: entry.toolCalls.map((call) => call.name) }),
    ...(entry.event !== undefined && { event: plain(entry.event) }),
    createdAt: new Date(entry.createdAt).getTime(),
    ...(fileCheckpointOf(entry.metadata) && { checkpoint: true }),
  };
}

/** What brings a thread of the studio's own memory back after a restart. */
interface ThreadSeed {
  history: readonly HistoryMessage[];
  replay?: ThreadReplay;
  lineage?: readonly ThreadLineage[];
}

function seedOf(request: ThreadSeed): ThreadSeed {
  return {
    history: request.history,
    ...(request.replay && { replay: request.replay }),
    ...(request.lineage && { lineage: request.lineage }),
  };
}

/** Thread metadata of a run's state, which a replay leaves out: paused and durable runs */
function replayable(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(
      ([key]) => key !== 'pausedRun' && key !== 'durableRuns' && !key.startsWith('durableFence')
    )
  );
}

/** The text of a message entry, its text parts joined. */
function textOf(entry: MemoryEntry): string {
  const content = entry.message.content;
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

function fileSummary(files: FileRewindReport): FileRestoreSummary {
  return {
    snapshotId: files.snapshotId,
    dryRun: files.dryRun,
    restored: [...files.restored],
    deleted: [...files.deleted],
    unchanged: files.unchanged,
    kept: [...files.kept],
    entryId: files.entryId,
    exact: files.exact,
    workspaceId: files.workspaceId,
    ...(files.busy !== undefined && { busy: files.busy }),
    ...(files.safetySnapshotId !== undefined && { safetySnapshotId: files.safetySnapshotId }),
  };
}

function rewindSummary(report: RewindReport): RewindSummary {
  return {
    threadId: report.threadId,
    toEntryId: report.toEntryId,
    dryRun: report.dryRun,
    conversation: {
      rewound: report.conversation.rewound,
      cut: [...report.conversation.cut],
      ...(report.conversation.previousLeafId !== undefined && {
        previousLeafId: report.conversation.previousLeafId,
      }),
    },
    staleItems: report.items.stale.length,
    ...(report.files && { files: fileSummary(report.files) }),
    runs: {
      going: [...report.runs.going],
      interrupted: [...report.runs.interrupted],
      paused: report.runs.paused,
      durable: [...report.runs.durable],
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** JSON-safe copy of what a workflow node or a tool returned. */
function plain(value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(value);
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as unknown;
  } catch {
    return String(value);
  }
}

/**
 * Runs the project for the studio: chats with its agents, asks the studio
 * to approve tool calls, forks runs from their steps and runs its workflows
 * and swarms.
 * Everything that happens is reported through `emit`, from the runtime's own
 * observer, so runs agent tools start show up too.
 */
export class StudioHost {
  private readonly als = new AsyncLocalStorage<RunContext>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly approvals = new Map<string, PendingApproval>();
  /**
   * The replay of each thread into the studio's memory, once per host: a request asked for while
   * it runs waits for it, so no run sees part of a thread
   */
  private readonly seeded = new Map<string, Promise<void>>();
  /** The thread of each chat run going on, which a forced rewind of the thread stops first. */
  private readonly runThreads = new Map<string, string>();
  private readonly workflowRunIds = new Map<string, string>();
  private timeTravel?: Promise<TimeTravel>;
  private manager?: Promise<WorkflowsModule.DefaultWorkflowManager>;

  private constructor(
    private readonly project: LoadedProject,
    private readonly core: typeof CoreModule,
    private readonly plugins: ProjectPlugins,
    private readonly triggers: ProjectTriggers,
    private readonly options: {
      projectDir: string;
      studioDir: string;
      memory: 'project' | 'studio';
      emit: (event: HostEvent) => void;
    }
  ) {}

  /**
   * Loads the project and its plugins. `onPlugins` hears every change of the runtime's plugins:
   * one loaded, reloaded, enabled, disabled or failed. `onInbox` hears every change of the inbox
   * of its routines, with the unread items counted after it.
   */
  static async create(
    projectDir: string,
    studioDir: string,
    emit: (event: HostEvent) => void,
    onPlugins: (plugins: PluginsState) => void = () => undefined,
    onInbox: (change: InboxChangeRecord, unread: number) => void = () => undefined
  ): Promise<StudioHost> {
    const project = await loadProject(projectDir);
    const core = await importFromProject<typeof CoreModule>(projectDir, '@cogitator-ai/core');
    let memory: 'project' | 'studio' = 'project';
    if (!(await project.cogitator.getMemory())) {
      const adapter = new InMemoryAdapter({ provider: 'memory' });
      await adapter.connect();
      project.cogitator.memory = adapter;
      memory = 'studio';
    }
    const plugins = await ProjectPlugins.open(project.cogitator, onPlugins);
    const triggers = ProjectTriggers.open(project.cogitator, onInbox);
    const host = new StudioHost(project, core, plugins, triggers, {
      projectDir,
      studioDir,
      memory,
      emit,
    });
    project.cogitator.observe(host.observer());
    return host;
  }

  get memory(): 'project' | 'studio' {
    return this.options.memory;
  }

  registry(): RegistryInfo {
    return describeRegistry(this.project.module);
  }

  async close(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort(new Error(STOPPED));
    this.plugins.close();
    this.triggers.close();
    await this.project.cogitator.close();
  }

  handle(request: HostRequest): Promise<unknown> {
    switch (request.type) {
      case 'chat':
        return this.chat(request.agent, request.input, request.threadId, seedOf(request));
      case 'stop':
        return Promise.resolve(this.stop(request.runId));
      case 'approve':
        return Promise.resolve(
          this.decide(request.approvalId, request.approved, request.reason, request.remember)
        );
      case 'fork':
        return this.fork(request.run, request.fork);
      case 'workflow.run':
        return this.runWorkflow(request.workflow, request.input);
      case 'workflow.rerun':
        return this.rerunWorkflow(request.run, request.fromNode);
      case 'swarm.run':
        return this.runSwarm(request.swarm, request.input);
      case 'thread.tree':
        return this.threadTree(request.threadId, request.agent, seedOf(request));
      case 'thread.rewind':
        return this.rewind(request.threadId, request.agent, seedOf(request), request);
      case 'thread.fork':
        return this.forkThread(request);
      case 'plugins.list':
        return Promise.resolve(this.plugins.state());
      case 'plugins.reload':
        return this.plugins.reload(request.plugin);
      case 'plugins.enable':
        return this.plugins.setEnabled(request.plugin, request.enabled);
      case 'plugins.panel':
        return this.plugins.panelHtml(request.plugin, request.panel);
      case 'plugins.call':
        return this.plugins.call(request.plugin, request.panel, request.method, request.params);
      case 'tools.app':
        return this.readToolApp(request.agent, request.tool);
      case 'tools.app.call':
        return this.callForApp(request);
      case 'triggers.state':
        return this.triggers.state();
      case 'triggers.start':
        return this.triggers.start();
      case 'triggers.stop':
        return this.triggers.stop();
      case 'triggers.fire':
        return this.triggers.fire(request.trigger, request.text);
      case 'schedules.run':
        return this.triggers.schedule('run', request.schedule);
      case 'schedules.pause':
        return this.triggers.schedule('pause', request.schedule);
      case 'schedules.resume':
        return this.triggers.schedule('resume', request.schedule);
      case 'inbox.list':
        return this.triggers.inbox(request.query);
      case 'inbox.update':
        return this.triggers.update(request.item, request.status);
      case 'inbox.respond':
        return this.triggers.respond(request.item, request.answer);
      case 'inbox.approve':
        return this.triggers.approve(request.approvalId, request.approved, request.reason);
    }
  }

  /**
   * Rewinds a thread to an entry of its active branch through the runtime, with the agent's
   * workspace for its files, or reports what it would change with `dryRun`.
   */
  private async rewind(
    threadId: string,
    key: string,
    seed: ThreadSeed,
    request: RewindRequest
  ): Promise<RewindSummary> {
    const agent = this.agent(key);
    await this.seed(threadId, agent, seed);
    const report = await this.project.cogitator.rewind(threadId, request.entryId, {
      agents: [agent],
      ...(request.memory !== undefined && { memory: request.memory }),
      ...(request.files !== undefined && { files: request.files }),
      ...(request.dryRun !== undefined && { dryRun: request.dryRun }),
      ...(request.force !== undefined && { force: request.force }),
    });
    const summary = rewindSummary(report);
    if (!report.dryRun && this.options.memory === 'studio') {
      summary.replay = await this.replayOf(threadId);
    }
    return summary;
  }

  /**
   * Forks a thread at an entry into `newThreadId` through the runtime, with the files of the
   * agent's workspace restored to that point when asked, and the messages of the forked branch.
   */
  private async forkThread(
    request: {
      threadId: string;
      agent: string;
      entryId: string;
      newThreadId: string;
    } & ThreadForkRequest &
      ThreadSeed
  ): Promise<ForkSummary | ForkPreview> {
    const agent = this.agent(request.agent);
    await this.seed(request.threadId, agent, seedOf(request));
    const options = {
      agents: [agent],
      ...(request.files !== undefined && { files: request.files }),
      ...(request.force !== undefined && { force: request.force }),
    };
    if (request.dryRun) {
      const plan = await this.project.cogitator.forkThread(request.threadId, request.entryId, {
        ...options,
        dryRun: true,
      });
      return {
        dryRun: true,
        snapshotsCopied: [...plan.snapshotsCopied],
        ...(plan.files && { files: fileSummary(plan.files) }),
        going: [...plan.going],
      };
    }
    const result = await this.project.cogitator.forkThread(request.threadId, request.entryId, {
      ...options,
      newThreadId: request.newThreadId,
    });
    const threadId = result.thread.id;
    this.seeded.set(threadId, Promise.resolve());
    return {
      threadId,
      snapshotsCopied: [...result.snapshotsCopied],
      ...(result.files && { files: fileSummary(result.files) }),
      base: await this.messagesOf(threadId),
      ...(this.options.memory === 'studio' && { replay: await this.replayOf(threadId) }),
    };
  }

  /**
   * The active branch of a thread entry by entry, with ids and metadata, for the server to replay
   * into a fresh memory after a restart
   */
  private async replayOf(threadId: string): Promise<ThreadReplay> {
    const memory = await this.project.cogitator.getMemory();
    if (!memory?.getPath) return { metadata: {}, entries: [] };
    const thread = await memory.getThread(threadId);
    if (!thread.success) throw new Error(thread.error);
    const all = await memory.getEntries({ threadId, types: 'all', includeToolCalls: true });
    if (!all.success) throw new Error(all.error);
    const entries = [...all.data]
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
      .map((entry): ReplayEntry => ({
        id: entry.id,
        parentId: entry.parentId ?? null,
        ...(entry.type !== undefined && { type: entry.type }),
        message: entry.message,
        ...(entry.toolCalls && { toolCalls: entry.toolCalls }),
        ...(entry.toolResults && { toolResults: entry.toolResults }),
        ...(entry.metadata && { metadata: entry.metadata }),
        ...(entry.event && { event: entry.event }),
      }));
    const activeLeafId = thread.data?.activeLeafId;
    return {
      metadata: replayable(thread.data?.metadata ?? {}),
      entries,
      ...(activeLeafId !== undefined && { activeLeafId }),
    };
  }

  /** Tells the server the active branch of a thread of the studio's own memory, after a run */
  private async reportReplay(threadId: string): Promise<void> {
    if (this.options.memory !== 'studio') return;
    try {
      this.emit({ type: 'thread.replay', threadId, replay: await this.replayOf(threadId) });
    } catch (error) {
      console.error(
        `[studio host] could not read thread ${threadId} to keep it: ${message(error)}`
      );
    }
  }

  /** The user and assistant messages of a thread's active branch with their text. */
  private async messagesOf(threadId: string): Promise<HistoryMessage[]> {
    const memory = await this.project.cogitator.getMemory();
    if (!memory?.getPath) return [];
    const path = await memory.getPath({ threadId, types: ['message'] });
    if (!path.success) throw new Error(path.error);
    return path.data.flatMap((entry): HistoryMessage[] => {
      const role = entry.message.role;
      if (role !== 'user' && role !== 'assistant') return [];
      const content = textOf(entry);
      return content ? [{ role, content }] : [];
    });
  }

  /**
   * Every branch of a thread as memory keeps it, the newest entries when there are more than the
   * studio shows. A memory without trees gives its entries as a list. The studio's own memory
   * gets the thread's earlier messages first, as a chat in it would.
   */
  private async threadTree(threadId: string, key: string, seed: ThreadSeed): Promise<ThreadTree> {
    const agent = this.project.agents.get(key);
    if (agent) await this.seed(threadId, agent, seed);
    const memory = await this.project.cogitator.getMemory();
    const empty: ThreadTree = { threadId, entries: [], truncated: false, branching: false };
    if (!memory) return empty;
    const thread = await memory.getThread(threadId);
    if (!thread.success) throw new Error(thread.error);
    if (!thread.data) return empty;
    const read = await memory.getEntries({
      threadId,
      limit: TREE_ENTRIES + 1,
      types: 'all',
      includeToolCalls: true,
    });
    if (!read.success) throw new Error(read.error);
    const all =
      read.data.length > TREE_ENTRIES
        ? await memory.getEntries({ threadId, types: 'all' })
        : { success: true as const, data: read.data };
    if (!all.success) throw new Error(all.error);
    const filesAt = this.filesAt(all.data);
    const entries = read.data.slice(-TREE_ENTRIES).map((entry) => {
      const files = filesAt(entry.id);
      return { ...treeEntry(entry), ...(files && { files }) };
    });
    return {
      threadId,
      ...(thread.data.activeLeafId && { activeLeafId: thread.data.activeLeafId }),
      entries,
      truncated: read.data.length > TREE_ENTRIES,
      branching: typeof memory.getPath === 'function',
    };
  }

  /**
   * What files a rewind or a fork to each entry of `tree` (every entry of a thread) restores, by
   * the runtime's own `checkpointAt`, so the studio offers them exactly when the runtime can
   */
  private filesAt(tree: readonly MemoryEntry[]): (entryId: string) => TreeEntry['files'] {
    const checkpointAt = this.core.checkpointAt;
    if (typeof checkpointAt !== 'function') return () => undefined;
    const byId = new Map(tree.map((entry) => [entry.id, entry]));
    return (entryId) => {
      const path: MemoryEntry[] = [];
      const seen = new Set<string>();
      for (let id: string | null | undefined = entryId; id && !seen.has(id);) {
        seen.add(id);
        const entry = byId.get(id);
        if (!entry) break;
        path.unshift(entry);
        id = entry.parentId;
      }
      const at = checkpointAt(path, path.length - 1, tree);
      return at ? (at.exact ? 'exact' : 'before') : undefined;
    };
  }

  private emit(event: HostEvent): void {
    this.options.emit(event);
  }

  /** Reports every run started for a studio request, nested ones included. */
  private observer(): RunObserver {
    return {
      captureContent: true,
      onRunStart: (event) => {
        const context = this.als.getStore();
        if (!context) return;
        const root = context.rootRunId === undefined;
        if (root) {
          context.rootRunId = event.runId;
          context.started(event.runId);
        }
        this.emit({
          type: 'run.started',
          runId: event.runId,
          kind: root ? context.kind : 'agent',
          target: root ? context.target : event.agentName,
          agentName: event.agentName,
          input: event.input,
          threadId: root && context.threadId ? context.threadId : event.threadId,
          ...(event.model && { model: event.model }),
          rootRunId: context.rootRunId ?? event.runId,
          startedAt: Date.now(),
          ...(root && context.forkOf && { forkOf: context.forkOf }),
        });
      },
      onSpan: (span, run) => {
        if (!this.als.getStore()) return;
        this.emit({ type: 'run.span', runId: run.runId, span: rawSpan(span) });
      },
      onTodos: (todos, run) => {
        if (!this.als.getStore()) return;
        this.emit({
          type: 'run.todos',
          runId: run.runId,
          todos: todos.map(({ id, content, status }) => ({ id, content, status })),
        });
      },
      onRunComplete: (result) => {
        const context = this.als.getStore();
        if (!context || result.runId === context.rootRunId) return;
        this.emit({
          type: 'run.completed',
          runId: result.runId,
          output: result.output,
          usage: usageOf(result),
          endedAt: Date.now(),
          toolCalls: toolCallsOf(result),
        });
      },
      onRunError: (error, runId) => {
        const context = this.als.getStore();
        if (!context || runId === context.rootRunId) return;
        this.emit({
          type: 'run.failed',
          runId,
          error: error.message,
          endedAt: Date.now(),
          stopped: false,
        });
      },
    };
  }

  /** The MCP App of the tool `tool` of agent `key` */
  /** The agent `key`, its tool `tool` and the tool's MCP App */
  private toolApp(key: string, tool: string): { agent: Agent; tool: Tool; app: ToolApp } {
    const agent = this.project.agents.get(key);
    const found = agent?.tools.find((candidate) => candidate.name === tool);
    if (!agent || !found?.app) {
      throw new ToolAppRefusal(
        agent
          ? `The tool "${tool}" of agent "${key}" has no MCP App`
          : `There is no agent "${key}" in the registry`,
        'TOOL_APP_NOT_FOUND'
      );
    }
    return { agent, tool: found, app: found.app };
  }

  private async readToolApp(key: string, tool: string): Promise<ToolAppResource> {
    return this.toolApp(key, tool).app.read();
  }

  /**
   * A tool call an MCP App asked for, on the server it came from, held to what a call of the agent
   * is: the runtime's and the agent's permission rules (a tool of an MCP server by its
   * `mcp__<server>__<tool>` name too), hooks and guardrails decide, and a call that needs approval,
   * because a rule asks or the server's tool needs it, waits for the person to allow it in the
   * studio. A denied call answers the app with an error
   */
  private async callForApp(request: {
    agent: string;
    tool: string;
    name: string;
    arguments: Record<string, unknown>;
    approved?: boolean;
  }): Promise<ToolAppCallOutcome> {
    const { agent, tool, app } = this.toolApp(request.agent, request.tool);
    const callTool = app.callTool?.bind(app);
    if (!callTool) {
      throw new ToolAppRefusal(
        `The MCP App of "${request.tool}" may call no tools`,
        'TOOL_APP_FORBIDDEN'
      );
    }
    const called: Tool<Record<string, unknown>, ToolAppCallResult> = this.core.tool({
      name: request.name,
      description: `A call the MCP App of ${request.tool} makes`,
      parameters: z.record(z.string(), z.unknown()),
      requiresApproval: (await app.requiresApproval?.(request.name)) === true,
      ...(tool.mcp && { mcp: { server: tool.mcp.server, tool: request.name } }),
      execute: (args) => callTool(request.name, args),
    });
    const invoked = await this.project.cogitator.invokeTool(called, request.arguments, {
      agent,
      ...(request.approved === true && { onApproval: async () => ({ approved: true }) }),
    });
    if (invoked.pendingApproval) return { status: 'approval', tool: request.name };
    if (invoked.error !== undefined) {
      return {
        status: 'done',
        result: { content: [{ type: 'text', text: invoked.error }], isError: true },
      };
    }
    return { status: 'done', result: appResult(invoked.result) };
  }

  private agent(key: string): Agent {
    const agent = this.project.agents.get(key);
    if (!agent) throw new Error(`There is no agent "${key}" in the registry`);
    return agent;
  }

  private workflow(key: string): Workflow {
    const workflow = this.project.workflows.get(key);
    if (!workflow) throw new Error(`There is no workflow "${key}" in the registry`);
    return workflow;
  }

  /**
   * Starts `start` under a new studio request and resolves with the id of
   * the run it started, or rejects when it failed before starting one.
   */
  private async begin<T>(
    context: Omit<RunContext, 'started' | 'rootRunId'>,
    start: () => Promise<T>
  ): Promise<{ runId: string; done: Promise<T> }> {
    let resolveStarted!: (runId: string) => void;
    const started = new Promise<string>((resolve) => (resolveStarted = resolve));
    const full: RunContext = { ...context, started: resolveStarted };
    const done = this.als.run(full, start);
    const runId = await Promise.race([started, done.then(() => started)]);
    return { runId, done };
  }

  /**
   * Brings a thread of the studio's own memory back after a restart: its active branch entry by
   * entry, with the ids and metadata it had (file checkpoints included), or for a thread kept
   * before the studio kept branches, its finished turns
   */
  private seed(threadId: string, agent: Agent, seed: ThreadSeed): Promise<void> {
    if (this.options.memory !== 'studio') return Promise.resolve();
    const known = this.seeded.get(threadId);
    if (known) return known;
    const replayed = this.replay(threadId, agent, seed);
    this.seeded.set(threadId, replayed);
    replayed.catch(() => {
      if (this.seeded.get(threadId) === replayed) this.seeded.delete(threadId);
    });
    return replayed;
  }

  private async replay(threadId: string, agent: Agent, seed: ThreadSeed): Promise<void> {
    for (const ancestor of seed.lineage ?? []) {
      const owner = this.project.agents.get(ancestor.agent) ?? agent;
      await this.seed(ancestor.threadId, owner, {
        history: ancestor.history,
        ...(ancestor.replay && { replay: ancestor.replay }),
      });
    }
    const { history, replay } = seed;
    if (history.length === 0 && !replay?.entries.length) return;
    const memory = await this.project.cogitator.getMemory();
    if (!memory) return;
    const existing = await memory.getThread(threadId);
    if (!existing.success || !existing.data) {
      await memory.createThread(agent.id, replay?.metadata ?? {}, threadId);
    } else if (replay) {
      await memory.updateThread(threadId, replay.metadata);
    }
    if (replay?.entries.length) {
      for (const entry of replay.entries) {
        const added = await memory.addEntry({
          id: entry.id,
          threadId,
          message: entry.message,
          ...(entry.type !== undefined && { type: entry.type }),
          ...(entry.toolCalls && { toolCalls: entry.toolCalls }),
          ...(entry.toolResults && { toolResults: entry.toolResults }),
          ...(entry.metadata && { metadata: entry.metadata }),
          ...(entry.event && { event: entry.event }),
          tokenCount: Math.ceil(JSON.stringify(entry.message.content).length / 4),
          parentId: entry.parentId,
          activate: false,
        });
        if (!added.success) throw new Error(added.error);
      }
      if (replay.activeLeafId !== undefined && memory.checkout) {
        const moved = await memory.checkout(threadId, replay.activeLeafId);
        if (!moved.success) throw new Error(moved.error);
      }
      return;
    }
    for (const entry of history) {
      await memory.addEntry({
        threadId,
        message: { role: entry.role, content: entry.content },
        tokenCount: Math.ceil(entry.content.length / 4),
      });
    }
  }

  private async chat(
    key: string,
    input: string,
    threadId: string,
    seed: ThreadSeed
  ): Promise<{ runId: string }> {
    const agent = this.agent(key);
    await this.seed(threadId, agent, seed);
    const controller = new AbortController();
    let current = '';
    const { runId, done } = await this.begin({ kind: 'agent', target: key, threadId }, () =>
      this.project.cogitator.run(agent, {
        input,
        threadId,
        stream: true,
        signal: controller.signal,
        onToken: (text) => this.emit({ type: 'run.token', runId: current, text }),
        onReasoning: (text) => this.emit({ type: 'run.reasoning', runId: current, text }),
        onToolCall: (call) =>
          this.emit({
            type: 'run.tool.call',
            runId: current,
            call: { id: call.id, name: call.name, arguments: call.arguments },
          }),
        onToolResult: (result) =>
          this.emit({
            type: 'run.tool.result',
            runId: current,
            callId: result.callId,
            result: plain(result.result),
            ...(result.error && { error: result.error }),
            ...(result.details !== undefined && { details: plain(result.details) }),
            ...(result.presentation && { presentation: { ...result.presentation } }),
          }),
        onToolUpdate: (update) =>
          this.emit({
            type: 'run.tool.update',
            runId: current,
            callId: update.callId,
            ...(update.content !== undefined && { content: plain(update.content) }),
            ...(update.details !== undefined && { details: plain(update.details) }),
            ...(update.presentation && { presentation: { ...update.presentation } }),
          }),
        onRunStart: (event) => (current = event.runId),
        onApproval: (request) => this.ask(current, request),
        onPermissionDecision: (event) => {
          if (!event.remembered) return;
          this.emit({
            type: 'run.approval.remembered',
            runId: current,
            callId: event.toolCallId,
            rule: event.remembered.rule,
            layer: event.remembered.layer,
          });
        },
      })
    );
    this.runThreads.set(runId, threadId);
    this.finish(runId, done, controller);
    void done.then(
      () => this.reportReplay(threadId),
      () => this.reportReplay(threadId)
    );
    return { runId };
  }

  /**
   * Reports how a run the studio started ended, with its fork steps. A run
   * with a controller can be stopped from the studio.
   */
  private finish(runId: string, done: Promise<RunResult>, controller?: AbortController): void {
    if (controller) this.controllers.set(runId, controller);
    void done
      .then(
        async (result) => {
          if (result.status === 'paused') {
            this.emit({
              type: 'run.failed',
              runId,
              error: pauseError(result),
              endedAt: Date.now(),
              stopped: false,
            });
            return;
          }
          let steps: StepRecord[] | undefined;
          try {
            steps = await this.steps(result);
          } catch (error) {
            console.error(
              `[studio host] could not record the steps of run ${runId}, it cannot be forked: ${message(error)}`
            );
          }
          const memory = memoryOf(result);
          this.emit({
            type: 'run.completed',
            runId,
            output: result.output,
            usage: usageOf(result),
            endedAt: Date.now(),
            toolCalls: toolCallsOf(result),
            ...(steps && { steps }),
            ...(memory && { memory }),
          });
        },
        (error: unknown) => {
          const interrupted =
            error instanceof Error && 'code' in error && error.code === 'RUN_INTERRUPTED';
          this.emit({
            type: 'run.failed',
            runId,
            error: controller?.signal.aborted ? STOPPED : message(error),
            endedAt: Date.now(),
            stopped: controller?.signal.aborted === true || interrupted,
          });
        }
      )
      .finally(() => {
        this.controllers.delete(runId);
        this.runThreads.delete(runId);
        this.rejectApprovals(runId, STOPPED);
      });
  }

  /** Holds a tool call until the studio approves or rejects it. */
  private ask(runId: string, request: ToolApprovalRequest): Promise<ToolApprovalDecision> {
    const approvalId = `${runId}:${request.toolCallId}`;
    return new Promise((resolve) => {
      this.approvals.set(approvalId, { runId, resolve });
      this.emit({
        type: 'run.approval',
        runId,
        approvalId,
        callId: request.toolCallId,
        toolName: request.toolName,
        arguments: plain(request.arguments),
        description: request.description,
        ...(request.reason !== undefined && { askReason: request.reason }),
        ...(request.rule && { rule: request.rule.rule }),
        ...(request.suggestedRule !== undefined && { suggestedRule: request.suggestedRule }),
      });
    });
  }

  private decide(
    approvalId: string,
    approved: boolean,
    reason?: string,
    remember?: boolean
  ): { decided: boolean } {
    const pending = this.approvals.get(approvalId);
    if (!pending) return { decided: false };
    this.approvals.delete(approvalId);
    pending.resolve(
      approved
        ? { approved: true, ...(remember === true && { remember: true }) }
        : { approved: false, ...(reason && { reason }) }
    );
    this.emit({
      type: 'run.approval.decided',
      runId: pending.runId,
      approvalId,
      approved,
      ...(!approved && reason && { reason }),
    });
    return { decided: true };
  }

  private stop(runId: string): { stopped: boolean } {
    const controller = this.controllers.get(runId);
    if (!controller) return { stopped: false };
    controller.abort(new Error(STOPPED));
    this.rejectApprovals(runId, STOPPED);
    return { stopped: true };
  }

  /** Rejects the approvals a run waits for, so a run that was stopped does not wait on. */
  private rejectApprovals(runId: string, reason: string): void {
    for (const [id, pending] of this.approvals) {
      if (pending.runId === runId) this.decide(id, false, reason);
    }
  }

  private travel(): Promise<TimeTravel> {
    this.timeTravel ??= openCheckpointStore(
      this.core.InMemoryCheckpointStore,
      join(this.options.studioDir, 'checkpoints')
    ).then(
      (checkpointStore) =>
        new this.core.TimeTravel(this.project.cogitator, {
          checkpointStore,
          config: { maxCheckpointsPerTrace: 500, checkpointRetention: CHECKPOINT_RETENTION_MS },
        })
    );
    return this.timeTravel;
  }

  /** The steps a run can be forked from: one before each tool call, or its start. */
  private async steps(result: RunResult): Promise<StepRecord[]> {
    const travel = await this.travel();
    let checkpoints: ExecutionCheckpoint[] = await travel.checkpointAll(result, 'step');
    if (checkpoints.length === 0) checkpoints = [await travel.checkpoint(result, 0, 'start')];
    return checkpoints.map((checkpoint) => ({
      index: checkpoint.stepIndex,
      checkpointId: checkpoint.id,
      label:
        checkpoint.pendingToolCalls.length > 0
          ? `before ${checkpoint.pendingToolCalls.map((call) => call.name).join(', ')}`
          : 'from the start',
      toolCalls: result.toolCalls.slice(0, checkpoint.stepIndex).map((call) => ({
        name: call.name,
        result: plain(checkpoint.toolResults[call.id]),
      })),
    }));
  }

  private async fork(
    run: RunRecord,
    request: {
      step: number;
      input?: string;
      context?: string;
      toolResults?: Record<string, unknown>;
    }
  ): Promise<{ runId: string }> {
    const step = run.steps?.find((candidate) => candidate.index === request.step);
    if (!step) throw new Error(`Run ${run.id} has no step ${request.step} to fork from`);
    const agent = this.agent(run.target);
    const travel = await this.travel();
    const forkOf: ForkOrigin = {
      runId: run.id,
      step: request.step,
      ...(request.input !== undefined && { input: request.input }),
      ...(request.context !== undefined && { context: request.context }),
      ...(request.toolResults !== undefined && { toolResults: request.toolResults }),
    };
    const { runId, done } = await this.begin({ kind: 'fork', target: run.target, forkOf }, () =>
      travel.fork(agent, step.checkpointId, {
        ...(request.input !== undefined && { input: request.input }),
        ...(request.context !== undefined && { additionalContext: request.context }),
        ...(request.toolResults !== undefined && { mockToolResults: request.toolResults }),
        label: `fork of ${run.id} at step ${request.step}`,
      })
    );
    this.finish(
      runId,
      done.then((forked) => forked.result)
    );
    return { runId };
  }

  private workflowManager(): Promise<WorkflowsModule.DefaultWorkflowManager> {
    this.manager ??= importFromProject<typeof WorkflowsModule>(
      this.options.projectDir,
      '@cogitator-ai/workflows'
    ).then(
      (workflows) =>
        new workflows.DefaultWorkflowManager({
          cogitator: this.project.cogitator,
          checkpointStore: new workflows.FileCheckpointStore(
            join(this.options.studioDir, 'workflow-checkpoints')
          ),
          runStore: workflows.createFileRunStore({
            directory: join(this.options.studioDir, 'workflow-runs'),
          }),
          onRunStateChange: (run) => {
            const tag = run.tags.find((candidate) => candidate.startsWith('studio:'));
            if (tag) this.workflowRunIds.set(tag.slice('studio:'.length), run.id);
          },
        })
    );
    return this.manager;
  }

  private nodeCallbacks(runId: string): WorkflowExecuteOptionsV2 {
    return {
      checkpoint: true,
      tags: [`studio:${runId}`],
      onNodeStart: (node) =>
        this.emit({ type: 'workflow.node', runId, node, status: 'running', at: Date.now() }),
      onNodeComplete: (node, output, duration) =>
        this.emit({
          type: 'workflow.node',
          runId,
          node,
          status: 'completed',
          at: Date.now(),
          duration,
          output: plain(output),
        }),
      onNodeError: (node, error) =>
        this.emit({
          type: 'workflow.node',
          runId,
          node,
          status: 'failed',
          at: Date.now(),
          error: error.message,
        }),
    };
  }

  /** Runs a workflow under a studio id the run is known by from its first event. */
  private startWorkflow(
    key: string,
    input: unknown,
    rerunOf: { runId: string; fromNode: string } | undefined,
    execute: (runId: string) => Promise<WorkflowResult<WorkflowState>>
  ): { runId: string } {
    const runId = `wfrun_${randomUUID()}`;
    const context: RunContext = {
      kind: 'workflow',
      target: key,
      rootRunId: runId,
      ...(rerunOf && { rerunOf }),
      started: () => undefined,
    };
    this.emit({
      type: 'run.started',
      runId,
      kind: 'workflow',
      target: key,
      input: JSON.stringify(input ?? {}),
      rootRunId: runId,
      startedAt: Date.now(),
      ...(rerunOf && { rerunOf }),
    });
    void this.als
      .run(context, () => execute(runId))
      .then((result) => {
        if (result.error) throw result.error;
        this.emit({
          type: 'run.completed',
          runId,
          output: JSON.stringify(plain(result.state), null, 2),
          usage: { inputTokens: 0, outputTokens: 0, cost: 0, duration: result.duration },
          endedAt: Date.now(),
          ...(this.workflowRunIds.has(runId) && { workflowRunId: this.workflowRunIds.get(runId) }),
        });
      })
      .catch((error: unknown) =>
        this.emit({
          type: 'run.failed',
          runId,
          error: message(error),
          endedAt: Date.now(),
          stopped: false,
        })
      );
    return { runId };
  }

  private async runWorkflow(key: string, input: unknown): Promise<{ runId: string }> {
    const workflow = this.workflow(key);
    const manager = await this.workflowManager();
    const state =
      typeof input === 'object' && input !== null ? (input as Partial<WorkflowState>) : {};
    return this.startWorkflow(key, input, undefined, (runId) =>
      manager.execute(workflow, state, this.nodeCallbacks(runId))
    );
  }

  /**
   * Runs a swarm of the registry, a fresh one built from its configuration each time, under a
   * studio id the run is known by from its first event. Its agent runs are nested under it, and
   * its team events are reported as they happen, so a team's graph and task list fill in live.
   */
  private async runSwarm(key: string, input: string): Promise<{ runId: string }> {
    const config = this.project.swarms.get(key);
    if (!config) throw new Error(`There is no swarm "${key}" in the registry`);
    const swarms = await importFromProject<typeof SwarmsModule>(
      this.options.projectDir,
      '@cogitator-ai/swarms'
    );
    const swarm = new swarms.Swarm(this.project.cogitator, config);
    const runId = `swrun_${randomUUID()}`;
    const controller = new AbortController();
    const context: RunContext = {
      kind: 'swarm',
      target: key,
      rootRunId: runId,
      started: () => undefined,
    };
    const startedAt = Date.now();
    this.emit({
      type: 'run.started',
      runId,
      kind: 'swarm',
      target: key,
      input,
      rootRunId: runId,
      startedAt,
    });
    const unsubscribe = swarm.on('*', (event) => {
      if (!event.type.startsWith('team:')) return;
      this.emit({
        type: 'swarm.event',
        runId,
        event: {
          type: event.type,
          ...(event.agentName && { agentName: event.agentName }),
          data: plain(event.data),
          at: event.timestamp,
        },
      });
    });
    this.controllers.set(runId, controller);
    void this.als
      .run(context, () => swarm.run({ input, signal: controller.signal }))
      .then((result) => {
        const output =
          typeof result.output === 'string'
            ? result.output
            : JSON.stringify(plain(result.output), null, 2);
        this.emit({
          type: 'run.completed',
          runId,
          output,
          usage: { inputTokens: 0, outputTokens: 0, cost: 0, duration: Date.now() - startedAt },
          endedAt: Date.now(),
        });
      })
      .catch((error: unknown) =>
        this.emit({
          type: 'run.failed',
          runId,
          error: controller.signal.aborted ? STOPPED : message(error),
          endedAt: Date.now(),
          stopped: controller.signal.aborted,
        })
      )
      .finally(async () => {
        unsubscribe();
        this.controllers.delete(runId);
        await swarm.close().catch((error: unknown) => {
          console.error(
            `[studio host] could not close the connections of swarm "${key}": ${message(error)}`
          );
        });
      });
    return { runId };
  }

  private async rerunWorkflow(run: RunRecord, fromNode: string): Promise<{ runId: string }> {
    if (!run.workflowRunId) {
      throw new Error(
        `Run ${run.id} has no checkpoint to rerun from: it did not finish in this studio`
      );
    }
    const workflow = this.workflow(run.target);
    if (!workflow.nodes.has(fromNode)) {
      throw new Error(`The workflow "${run.target}" has no node "${fromNode}"`);
    }
    const manager = await this.workflowManager();
    const workflowRunId = run.workflowRunId;
    return this.startWorkflow(
      run.target,
      JSON.parse(run.input) as unknown,
      { runId: run.id, fromNode },
      (runId) => manager.replay(workflow, workflowRunId, fromNode, this.nodeCallbacks(runId))
    );
  }
}

/**
 * Why a run the studio started ended paused: the questions its tools asked
 * (`context.interrupt()`), a plan it waits to have approved, a budget it
 * reached, none of which the studio answers, or the calls it waits to have
 * approved outside a chat.
 */
export function pauseError(result: RunResult): string {
  const waiting = (result.interrupts ?? []).filter((entry) => entry.kind !== 'approval');
  if (waiting.length > 0) {
    const kinds = new Set(waiting.map((entry) => entry.kind));
    const what = waiting.map(pausedFor).join(', ');
    const advice = [
      kinds.has('input') &&
        'The studio does not answer questions of tools, mock the tool result in a fork instead.',
      kinds.has('plan') &&
        'The studio does not approve plans, run the agent outside plan mode or mock exit_plan_mode in a fork.',
      kinds.has('budget') &&
        'The studio does not raise budgets, raise the budget of the project and run it again.',
    ].filter((line): line is string => typeof line === 'string');
    return `The run paused ${what}. ${advice.join(' ')}`;
  }
  const tools =
    (result.pendingApprovals ?? []).map((request) => request.toolName).join(', ') || 'tool calls';
  return `The run paused for approval of ${tools}: approvals are asked only in chats, mock the tool result in the fork instead`;
}

/** What a run waits on, as the end of "The run paused ..." */
function pausedFor(entry: RunInterrupt): string {
  switch (entry.kind) {
    case 'plan':
      return 'for the approval of its plan';
    case 'budget': {
      const scope = typeof entry.details?.scope === 'string' ? `${entry.details.scope} ` : '';
      const metric = entry.details?.metric;
      const counts =
        metric === 'cost'
          ? 'cost '
          : metric === 'tokens'
            ? 'token '
            : metric === 'toolCalls'
              ? 'tool call '
              : '';
      return `at a ${scope}${counts}budget it reached`;
    }
    default:
      return `to ask ${entry.reason} ("${entry.message}")`;
  }
}
