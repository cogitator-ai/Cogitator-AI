import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type * as CoreModule from '@cogitator-ai/core';
import type { Agent, TimeTravel } from '@cogitator-ai/core';
import { InMemoryAdapter } from '@cogitator-ai/memory';
import type {
  ExecutionCheckpoint,
  RunObserver,
  RunResult,
  Span,
  ToolApprovalDecision,
  ToolApprovalRequest,
  Workflow,
  WorkflowExecuteOptionsV2,
  WorkflowResult,
  WorkflowState,
} from '@cogitator-ai/types';
import type * as WorkflowsModule from '@cogitator-ai/workflows';
import type {
  ForkOrigin,
  HistoryMessage,
  HostEvent,
  HostRequest,
  RawSpan,
  RegistryInfo,
  RunRecord,
  StepRecord,
  UsageInfo,
} from '../protocol.js';
import { describeRegistry } from '../registry.js';
import { openCheckpointStore } from './checkpoints.js';
import { importFromProject, loadProject, type LoadedProject } from './project.js';

const CHECKPOINT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const STOPPED = 'Stopped in Cogitator Studio';

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
 * to approve tool calls, forks runs from their steps and runs its workflows.
 * Everything that happens is reported through `emit`, from the runtime's own
 * observer, so runs agent tools start show up too.
 */
export class StudioHost {
  private readonly als = new AsyncLocalStorage<RunContext>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly seeded = new Set<string>();
  private readonly workflowRunIds = new Map<string, string>();
  private timeTravel?: Promise<TimeTravel>;
  private manager?: Promise<WorkflowsModule.DefaultWorkflowManager>;

  private constructor(
    private readonly project: LoadedProject,
    private readonly core: typeof CoreModule,
    private readonly options: {
      projectDir: string;
      studioDir: string;
      memory: 'project' | 'studio';
      emit: (event: HostEvent) => void;
    }
  ) {}

  static async create(
    projectDir: string,
    studioDir: string,
    emit: (event: HostEvent) => void
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
    const host = new StudioHost(project, core, { projectDir, studioDir, memory, emit });
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
    await this.project.cogitator.close();
  }

  handle(request: HostRequest): Promise<unknown> {
    switch (request.type) {
      case 'chat':
        return this.chat(request.agent, request.input, request.threadId, request.history);
      case 'stop':
        return Promise.resolve(this.stop(request.runId));
      case 'approve':
        return Promise.resolve(this.decide(request.approvalId, request.approved, request.reason));
      case 'fork':
        return this.fork(request.run, request.fork);
      case 'workflow.run':
        return this.runWorkflow(request.workflow, request.input);
      case 'workflow.rerun':
        return this.rerunWorkflow(request.run, request.fromNode);
    }
  }

  private emit(event: HostEvent): void {
    this.options.emit(event);
  }

  /** Reports every run started for a studio request, nested ones included. */
  private observer(): RunObserver {
    return {
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

  /** Replays a thread's earlier messages into the studio's own memory, once per host. */
  private async seed(
    threadId: string,
    agent: Agent,
    history: readonly HistoryMessage[]
  ): Promise<void> {
    if (this.options.memory !== 'studio' || this.seeded.has(threadId)) return;
    this.seeded.add(threadId);
    if (history.length === 0) return;
    const memory = await this.project.cogitator.getMemory();
    if (!memory) return;
    const existing = await memory.getThread(threadId);
    if (!existing.success || !existing.data) await memory.createThread(agent.id, {}, threadId);
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
    history: readonly HistoryMessage[]
  ): Promise<{ runId: string }> {
    const agent = this.agent(key);
    await this.seed(threadId, agent, history);
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
          }),
        onRunStart: (event) => (current = event.runId),
        onApproval: (request) => this.ask(current, request),
      })
    );
    this.finish(runId, done, controller);
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
            const tools = (result.pendingApprovals ?? [])
              .map((request) => request.toolName)
              .join(', ');
            this.emit({
              type: 'run.failed',
              runId,
              error: `The run paused for approval of ${tools}: approvals are asked only in chats, mock the tool result in the fork instead`,
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
          this.emit({
            type: 'run.completed',
            runId,
            output: result.output,
            usage: usageOf(result),
            endedAt: Date.now(),
            toolCalls: toolCallsOf(result),
            ...(steps && { steps }),
          });
        },
        (error: unknown) =>
          this.emit({
            type: 'run.failed',
            runId,
            error: controller?.signal.aborted ? STOPPED : message(error),
            endedAt: Date.now(),
            stopped: controller?.signal.aborted === true,
          })
      )
      .finally(() => {
        this.controllers.delete(runId);
        for (const [id, pending] of this.approvals) {
          if (pending.runId === runId) this.decide(id, false, STOPPED);
        }
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
      });
    });
  }

  private decide(approvalId: string, approved: boolean, reason?: string): { decided: boolean } {
    const pending = this.approvals.get(approvalId);
    if (!pending) return { decided: false };
    this.approvals.delete(approvalId);
    pending.resolve(approved ? { approved: true } : { approved: false, ...(reason && { reason }) });
    this.emit({
      type: 'run.approval.decided',
      runId: pending.runId,
      approvalId,
      approved,
      ...(reason && { reason }),
    });
    return { decided: true };
  }

  private stop(runId: string): { stopped: boolean } {
    const controller = this.controllers.get(runId);
    if (!controller) return { stopped: false };
    controller.abort(new Error(STOPPED));
    for (const [id, pending] of this.approvals) {
      if (pending.runId === runId) this.decide(id, false, STOPPED);
    }
    return { stopped: true };
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
