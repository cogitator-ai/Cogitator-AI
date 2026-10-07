import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  HistoryMessage,
  HostEvent,
  RawSpan,
  RegistryInfo,
  RunRecord,
  SpanRecord,
  ThreadRecord,
  UsageInfo,
  WorkflowNodeRecord,
} from '../protocol.js';

/** Prices a model call, `null` when the model's price is unknown. */
export type Pricer = (
  model: string,
  usage: { inputTokens: number; outputTokens: number }
) => number | null;

export interface RunQuery {
  /** Registry key of an agent or workflow. */
  target?: string;
  kind?: RunRecord['kind'];
  /** Words looked up in the input, the output, the target and the error. */
  q?: string;
  limit?: number;
}

/** What changed after an event, for the server to push to the UI. */
export interface StoreChange {
  runs: RunRecord[];
  token?: { runId: string; text: string };
  reasoning?: { runId: string; text: string };
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function spanKind(name: string): SpanRecord['kind'] {
  if (name === 'llm.chat') return 'llm';
  if (name.startsWith('tool.')) return 'tool';
  if (name === 'agent.run') return 'agent';
  if (name === 'agent.handoff') return 'handoff';
  return 'other';
}

function writeAtomic(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

/**
 * The runs and threads of the studio, kept as JSON files under
 * `.cogitator/studio` so the history survives restarts without a database.
 * It turns what the host reports into run records: spans priced per model
 * call, nested runs under the tool call that started them, workflow nodes
 * with their status.
 */
export class StudioStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly threads = new Map<string, ThreadRecord>();
  private readonly roots = new Map<string, string>();
  private registry?: RegistryInfo;

  constructor(
    private readonly directory: string,
    private readonly price: Pricer
  ) {
    mkdirSync(join(directory, 'runs'), { recursive: true });
    this.load();
  }

  private load(): void {
    for (const name of readdirSync(join(this.directory, 'runs'))) {
      if (!name.endsWith('.json')) continue;
      try {
        const run = JSON.parse(
          readFileSync(join(this.directory, 'runs', name), 'utf-8')
        ) as RunRecord;
        if (run.status === 'running' || run.status === 'waiting') {
          run.status = 'failed';
          run.error = 'Cogitator Studio stopped during the run';
          run.endedAt ??= run.startedAt;
          this.persist(run);
        }
        this.runs.set(run.id, run);
      } catch {
        continue;
      }
    }
    const threadsFile = join(this.directory, 'threads.json');
    if (existsSync(threadsFile)) {
      try {
        for (const thread of JSON.parse(readFileSync(threadsFile, 'utf-8')) as ThreadRecord[]) {
          this.threads.set(thread.id, thread);
        }
      } catch {
        this.threads.clear();
      }
    }
  }

  private persist(run: RunRecord): void {
    writeAtomic(
      join(this.directory, 'runs', `${run.id.replace(/[^\w-]/g, '_')}.json`),
      JSON.stringify(run)
    );
  }

  private persistThreads(): void {
    writeAtomic(join(this.directory, 'threads.json'), JSON.stringify([...this.threads.values()]));
  }

  setRegistry(registry: RegistryInfo): void {
    this.registry = registry;
  }

  getRun(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  /** A run with every run it started, nested ones included, and its forks. */
  getRunTree(
    id: string
  ): { run: RunRecord; descendants: RunRecord[]; forks: RunRecord[] } | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    const descendants: RunRecord[] = [];
    const visit = (parent: RunRecord) => {
      for (const childId of parent.children) {
        const child = this.runs.get(childId);
        if (child) {
          descendants.push(child);
          visit(child);
        }
      }
    };
    visit(run);
    const forks = run.forks
      .map((forkId) => this.runs.get(forkId))
      .filter((fork): fork is RunRecord => fork !== undefined);
    return { run, descendants, forks };
  }

  /** Runs the user started (not the nested ones), newest first. */
  listRuns(query: RunQuery = {}): RunRecord[] {
    const words = (query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    return [...this.runs.values()]
      .filter((run) => !run.parentRunId)
      .filter((run) => !query.target || run.target === query.target)
      .filter((run) => !query.kind || run.kind === query.kind)
      .filter((run) => {
        if (words.length === 0) return true;
        const text = [run.input, run.output ?? '', run.target, run.error ?? '']
          .join('\n')
          .toLowerCase();
        return words.every((word) => text.includes(word));
      })
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, query.limit ?? 200);
  }

  listThreads(agent?: string): ThreadRecord[] {
    return [...this.threads.values()]
      .filter((thread) => !agent || thread.agent === agent)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getThread(id: string): ThreadRecord | undefined {
    return this.threads.get(id);
  }

  /** The thread a chat message goes to, created on the first message. */
  touchThread(id: string, agent: string, input: string): ThreadRecord {
    const now = Date.now();
    const existing = this.threads.get(id);
    if (existing && existing.agent !== agent) {
      throw new Error(`Thread ${id} belongs to the agent "${existing.agent}"`);
    }
    const thread: ThreadRecord = existing ?? {
      id,
      agent,
      title: input.trim().replace(/\s+/g, ' ').slice(0, 80) || 'New thread',
      createdAt: now,
      updatedAt: now,
      runs: [],
    };
    thread.updatedAt = now;
    this.threads.set(id, thread);
    this.persistThreads();
    return thread;
  }

  addRunToThread(threadId: string, runId: string): ThreadRecord | undefined {
    const thread = this.threads.get(threadId);
    if (!thread || thread.runs.includes(runId)) return thread;
    thread.runs.push(runId);
    thread.updatedAt = Date.now();
    this.persistThreads();
    return thread;
  }

  /** The finished turns of a thread, to replay into a fresh memory. */
  history(threadId: string): HistoryMessage[] {
    const thread = this.threads.get(threadId);
    if (!thread) return [];
    return thread.runs.flatMap((runId) => {
      const run = this.runs.get(runId);
      if (run?.status !== 'completed') return [];
      return [
        { role: 'user' as const, content: run.input },
        { role: 'assistant' as const, content: run.output ?? '' },
      ];
    });
  }

  /** Marks the runs still going as failed, when the host they ran in went away. */
  abandonRunning(reason: string): RunRecord[] {
    const changed: RunRecord[] = [];
    for (const run of this.runs.values()) {
      if (run.status !== 'running' && run.status !== 'waiting') continue;
      run.status = 'failed';
      run.error = reason;
      run.endedAt = Date.now();
      for (const call of run.toolCalls) {
        if (call.approval?.status === 'waiting')
          call.approval = { ...call.approval, status: 'rejected', reason };
      }
      this.persist(run);
      changed.push(run);
    }
    return changed;
  }

  /**
   * A span as the trace shows it. Model calls name the model without its
   * provider; the run's `provider/model` qualifies it, so it is priced at
   * that provider's price.
   */
  private spanRecord(span: RawSpan, run: RunRecord): SpanRecord {
    const kind = spanKind(span.name);
    const attributes = span.attributes;
    const bare = kind === 'llm' ? str(attributes['llm.model']) : undefined;
    const model = bare && !bare.includes('/') && run.model?.endsWith(`/${bare}`) ? run.model : bare;
    const inputTokens = kind === 'llm' ? num(attributes['llm.input_tokens']) : undefined;
    const outputTokens = kind === 'llm' ? num(attributes['llm.output_tokens']) : undefined;
    const cost =
      model && inputTokens !== undefined && outputTokens !== undefined
        ? (this.price(model, { inputTokens, outputTokens }) ?? undefined)
        : undefined;
    return {
      id: span.id,
      ...(span.parentId && { parentId: span.parentId }),
      name: span.name,
      kind,
      status: span.status,
      startTime: span.startTime,
      endTime: span.endTime,
      duration: span.duration,
      ...(model && { model }),
      ...(inputTokens !== undefined && { inputTokens }),
      ...(outputTokens !== undefined && { outputTokens }),
      ...(cost !== undefined && { cost }),
      attributes,
    };
  }

  private initialNodes(target: string): WorkflowNodeRecord[] {
    const workflow = this.registry?.workflows.find((candidate) => candidate.key === target);
    return (workflow?.nodes ?? []).map((name) => ({ name, status: 'pending' }));
  }

  /**
   * Puts every nested run of a finished root under the run whose tool call
   * started it: the run with the latest tool span that was open when the
   * nested run started. Runs no tool span holds stay under the root.
   */
  private linkNested(rootId: string): RunRecord[] {
    const root = this.runs.get(rootId);
    if (!root) return [];
    const members = [...this.roots]
      .filter(([, r]) => r === rootId)
      .map(([id]) => this.runs.get(id))
      .filter((run): run is RunRecord => run !== undefined);
    const nested = members.filter((run) => run.id !== rootId);
    if (nested.length === 0) return [];
    for (const run of members) run.children = [];
    for (const run of nested) {
      let parent: RunRecord = root;
      let callId: string | undefined;
      let latest = -Infinity;
      for (const candidate of members) {
        if (candidate.id === run.id) continue;
        for (const span of candidate.spans) {
          if (span.kind !== 'tool') continue;
          if (
            span.startTime <= run.startedAt &&
            span.endTime >= run.startedAt &&
            span.startTime > latest
          ) {
            latest = span.startTime;
            parent = candidate;
            callId = str(span.attributes['tool.call_id']);
          }
        }
      }
      run.parentRunId = parent.id;
      if (callId) run.parentToolCallId = callId;
      else delete run.parentToolCallId;
      parent.children.push(run.id);
    }
    for (const run of members) {
      run.children.sort(
        (a, b) => (this.runs.get(a)?.startedAt ?? 0) - (this.runs.get(b)?.startedAt ?? 0)
      );
      this.persist(run);
    }
    return members;
  }

  private sumChildren(run: RunRecord): UsageInfo {
    const total: UsageInfo = {
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      priced: false,
      duration: 0,
    };
    const add = (id: string) => {
      const child = this.runs.get(id);
      if (!child) return;
      if (child.usage) {
        total.inputTokens += child.usage.inputTokens;
        total.outputTokens += child.usage.outputTokens;
        total.cost += child.usage.cost;
        total.priced = total.priced === true || child.usage.priced === true;
      }
    };
    for (const [id, root] of this.roots) if (root === run.id && id !== run.id) add(id);
    total.duration = (run.endedAt ?? Date.now()) - run.startedAt;
    return total;
  }

  /** Applies an event of the host and returns what changed. */
  apply(event: HostEvent): StoreChange {
    switch (event.type) {
      case 'run.started': {
        const run: RunRecord = {
          id: event.runId,
          kind: event.kind,
          target: event.target,
          ...(event.agentName && { agentName: event.agentName }),
          ...(event.threadId && { threadId: event.threadId }),
          input: event.input,
          status: 'running',
          startedAt: event.startedAt,
          ...(event.model && { model: event.model }),
          toolCalls: [],
          spans: [],
          children: [],
          forks: [],
          ...(event.forkOf && { forkOf: event.forkOf }),
          ...(event.rerunOf && { rerunOf: event.rerunOf }),
          ...(event.kind === 'workflow' && { nodes: this.initialNodes(event.target) }),
        };
        this.runs.set(run.id, run);
        this.roots.set(run.id, event.rootRunId);
        const changed = [run];
        if (event.rootRunId !== event.runId) {
          const root = this.runs.get(event.rootRunId);
          if (root) {
            run.parentRunId = root.id;
            root.children.push(run.id);
            changed.push(root);
          }
        }
        const origin = event.forkOf ? this.runs.get(event.forkOf.runId) : undefined;
        if (origin) {
          origin.forks.push(run.id);
          this.persist(origin);
          changed.push(origin);
        }
        this.persist(run);
        return { runs: changed };
      }
      case 'run.token': {
        const run = this.runs.get(event.runId);
        if (!run) return { runs: [] };
        run.output = (run.output ?? '') + event.text;
        return { runs: [], token: { runId: event.runId, text: event.text } };
      }
      case 'run.reasoning': {
        const run = this.runs.get(event.runId);
        if (!run) return { runs: [] };
        run.reasoning = (run.reasoning ?? '') + event.text;
        return { runs: [], reasoning: { runId: event.runId, text: event.text } };
      }
      case 'run.tool.call': {
        const run = this.runs.get(event.runId);
        if (!run) return { runs: [] };
        if (!run.toolCalls.some((call) => call.id === event.call.id)) {
          run.toolCalls.push({
            id: event.call.id,
            name: event.call.name,
            arguments: event.call.arguments,
          });
        }
        return { runs: [run] };
      }
      case 'run.tool.result': {
        const run = this.runs.get(event.runId);
        const call = run?.toolCalls.find((candidate) => candidate.id === event.callId);
        if (!run || !call) return { runs: [] };
        call.result = event.result;
        if (event.error) call.error = event.error;
        return { runs: [run] };
      }
      case 'run.approval': {
        const run = this.runs.get(event.runId);
        if (!run) return { runs: [] };
        let call = run.toolCalls.find((candidate) => candidate.id === event.callId);
        if (!call) {
          call = { id: event.callId, name: event.toolName, arguments: event.arguments };
          run.toolCalls.push(call);
        }
        call.approval = { id: event.approvalId, status: 'waiting' };
        run.status = 'waiting';
        this.persist(run);
        return { runs: [run] };
      }
      case 'run.approval.decided': {
        const run = this.runs.get(event.runId);
        const call = run?.toolCalls.find(
          (candidate) => candidate.approval?.id === event.approvalId
        );
        if (!run || !call?.approval) return { runs: [] };
        call.approval = {
          id: event.approvalId,
          status: event.approved ? 'approved' : 'rejected',
          ...(event.reason && { reason: event.reason }),
        };
        if (
          run.status === 'waiting' &&
          !run.toolCalls.some((c) => c.approval?.status === 'waiting')
        ) {
          run.status = 'running';
        }
        this.persist(run);
        return { runs: [run] };
      }
      case 'run.span': {
        const run = this.runs.get(event.runId);
        if (!run) return { runs: [] };
        if (!run.spans.some((span) => span.id === event.span.id))
          run.spans.push(this.spanRecord(event.span, run));
        run.spans.sort((a, b) => a.startTime - b.startTime);
        if (!run.model) {
          const model = run.spans.find((span) => span.model)?.model;
          if (model) run.model = model;
        }
        return { runs: [run] };
      }
      case 'run.completed': {
        const run = this.runs.get(event.runId);
        if (!run) return { runs: [] };
        run.status = 'completed';
        run.output = event.output;
        run.endedAt = event.endedAt;
        if (event.steps) run.steps = event.steps;
        for (const call of event.toolCalls ?? []) {
          const known = run.toolCalls.find((candidate) => candidate.id === call.id);
          if (!known) run.toolCalls.push({ ...call });
          else {
            if (known.result === undefined && call.result !== undefined) known.result = call.result;
            if (!known.error && call.error) known.error = call.error;
          }
        }
        if (event.workflowRunId) run.workflowRunId = event.workflowRunId;
        if (run.nodes) {
          for (const node of run.nodes) if (node.status === 'pending') node.status = 'skipped';
        }
        const spanCost = run.spans.reduce((sum, span) => sum + (span.cost ?? 0), 0);
        const priced = event.usage.cost > 0 || run.spans.some((span) => span.cost !== undefined);
        run.usage =
          run.kind === 'workflow'
            ? this.sumChildren(run)
            : { ...event.usage, cost: event.usage.cost > 0 ? event.usage.cost : spanCost, priced };
        this.persist(run);
        const linked = this.roots.get(run.id) === run.id ? this.linkNested(run.id) : [];
        return { runs: [run, ...linked.filter((other) => other.id !== run.id)] };
      }
      case 'run.failed': {
        const run = this.runs.get(event.runId);
        if (!run) return { runs: [] };
        run.status = event.stopped ? 'stopped' : 'failed';
        run.error = event.error;
        run.endedAt = event.endedAt;
        if (run.kind === 'workflow') run.usage = this.sumChildren(run);
        this.persist(run);
        const linked = this.roots.get(run.id) === run.id ? this.linkNested(run.id) : [];
        return { runs: [run, ...linked.filter((other) => other.id !== run.id)] };
      }
      case 'workflow.node': {
        const run = this.runs.get(event.runId);
        if (!run) return { runs: [] };
        run.nodes ??= [];
        let node = run.nodes.find((candidate) => candidate.name === event.node);
        if (!node) {
          node = { name: event.node, status: 'pending' };
          run.nodes.push(node);
        }
        node.status = event.status;
        if (event.status === 'running') node.startedAt = event.at;
        if (event.duration !== undefined) node.duration = event.duration;
        if (event.output !== undefined) node.output = event.output;
        if (event.error) node.error = event.error;
        this.persist(run);
        return { runs: [run] };
      }
    }
  }
}
