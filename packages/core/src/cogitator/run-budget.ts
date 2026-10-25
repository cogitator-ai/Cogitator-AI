import { z } from 'zod';
import type {
  BudgetLimits,
  BudgetMetric,
  BudgetResponse,
  BudgetScope,
  BudgetSpend,
  BudgetUsage,
  BudgetWarning,
  RunCheckpoint,
  RunInterrupt,
  SessionBudgetConfig,
  SessionSpend,
  SpendTotals,
} from '@cogitator-ai/types';
import { getLogger } from '../logger';
import { dictionary, own } from '../utils/own';

/** The key of a thread's metadata that keeps what its session spent */
export const SESSION_BUDGET_KEY = 'budget';

const DEFAULT_WARN_AT = 0.8;

/** JSON Schema of the answer to a budget interrupt, a `BudgetResponse`, when raising is allowed */
export const BUDGET_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['continue', 'stop'] },
    limit: { type: 'number', exclusiveMinimum: 0 },
  },
  required: ['action'],
  additionalProperties: false,
};

/** JSON Schema of the answer to a budget interrupt when only the host may raise a limit */
export const BUDGET_STOP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { action: { type: 'string', enum: ['stop'] } },
  required: ['action'],
  additionalProperties: false,
};

const BudgetResponseSchema = z.union([
  z.object({ action: z.literal('continue'), limit: z.number().positive().optional() }),
  z.object({ action: z.literal('stop') }),
]);

const TotalsSchema = z.object({
  costUsd: z.number().nonnegative().catch(0),
  tokens: z.number().nonnegative().catch(0),
  toolCalls: z.number().nonnegative().catch(0),
});

const SessionSpendSchema = TotalsSchema.extend({
  agents: z.record(z.string(), TotalsSchema).optional().catch(undefined),
  raised: z.record(z.string(), z.number().positive()).optional().catch(undefined),
});

/** What a thread's metadata keeps of its session's spending, read leniently: nothing for junk */
export function readSessionSpend(value: unknown): SessionSpend {
  const parsed = SessionSpendSchema.safeParse(value);
  if (!parsed.success) return emptySpend();
  const { agents, raised, ...totals } = parsed.data;
  return {
    ...totals,
    ...(agents && { agents: dictionary(Object.entries(agents)) }),
    ...(raised && { raised: dictionary(Object.entries(raised)) }),
  };
}

function emptyTotals(): SpendTotals {
  return { costUsd: 0, tokens: 0, toolCalls: 0 };
}

function emptySpend(): BudgetSpend {
  return emptyTotals();
}

function copySpend(spend: BudgetSpend): BudgetSpend {
  return {
    costUsd: spend.costUsd,
    tokens: spend.tokens,
    toolCalls: spend.toolCalls,
    ...(spend.agents && {
      agents: dictionary(Object.entries(spend.agents).map(([id, totals]) => [id, { ...totals }])),
    }),
  };
}

function add(target: BudgetSpend, agentId: string, delta: Partial<SpendTotals>): void {
  const agents = (target.agents ??= dictionary());
  let totals = own(agents, agentId);
  if (!totals) {
    totals = emptyTotals();
    Object.defineProperty(agents, agentId, {
      value: totals,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  for (const key of ['costUsd', 'tokens', 'toolCalls'] as const) {
    const value = delta[key] ?? 0;
    target[key] += value;
    totals[key] += value;
  }
}

/** `a` minus `b`, by agent too */
function minus(a: BudgetSpend, b: BudgetSpend): BudgetSpend {
  const result: BudgetSpend = {
    costUsd: a.costUsd - b.costUsd,
    tokens: a.tokens - b.tokens,
    toolCalls: a.toolCalls - b.toolCalls,
  };
  const agents = Object.entries(a.agents ?? {}).map(([id, totals]): [string, SpendTotals] => {
    const before = own(b.agents, id) ?? emptyTotals();
    return [
      id,
      {
        costUsd: totals.costUsd - before.costUsd,
        tokens: totals.tokens - before.tokens,
        toolCalls: totals.toolCalls - before.toolCalls,
      },
    ];
  });
  if (agents.length > 0) result.agents = dictionary(agents);
  return result;
}

/**
 * The fresher of two records of one session's spending, counter by counter: spending only grows,
 * so the larger value is the newer one. For a record kept in the process when memory refused it
 */
export function freshestSpend(a: SessionSpend, b: SessionSpend): SessionSpend {
  const totals = (x: SpendTotals | undefined, y: SpendTotals | undefined): SpendTotals => ({
    costUsd: Math.max(x?.costUsd ?? 0, y?.costUsd ?? 0),
    tokens: Math.max(x?.tokens ?? 0, y?.tokens ?? 0),
    toolCalls: Math.max(x?.toolCalls ?? 0, y?.toolCalls ?? 0),
  });
  const ids = new Set([...Object.keys(a.agents ?? {}), ...Object.keys(b.agents ?? {})]);
  const raised = dictionary([...Object.entries(a.raised ?? {}), ...Object.entries(b.raised ?? {})]);
  for (const [key, value] of Object.entries(a.raised ?? {})) {
    raised[key] = Math.max(value, own(raised, key) ?? value);
  }
  return {
    ...totals(a, b),
    ...(ids.size > 0 && {
      agents: dictionary([...ids].map((id) => [id, totals(own(a.agents, id), own(b.agents, id))])),
    }),
    ...(Object.keys(raised).length > 0 && { raised }),
  };
}

/** `spend` added to what a session spent, with the limits it raised */
export function addToSession(
  session: SessionSpend,
  spend: BudgetSpend,
  raised: Record<string, number>
): SessionSpend {
  const result: SessionSpend = copySpend(session);
  for (const [id, totals] of Object.entries(spend.agents ?? {})) add(result, id, totals);
  const unattributed = {
    costUsd: spend.costUsd - sum(spend.agents, 'costUsd'),
    tokens: spend.tokens - sum(spend.agents, 'tokens'),
    toolCalls: spend.toolCalls - sum(spend.agents, 'toolCalls'),
  };
  result.costUsd += unattributed.costUsd;
  result.tokens += unattributed.tokens;
  result.toolCalls += unattributed.toolCalls;
  const allRaised = dictionary([
    ...Object.entries(session.raised ?? {}),
    ...Object.entries(raised),
  ]);
  if (Object.keys(allRaised).length > 0) result.raised = allRaised;
  return result;
}

function sum(agents: BudgetSpend['agents'], key: keyof SpendTotals): number {
  return Object.values(agents ?? {}).reduce((total, totals) => total + totals[key], 0);
}

function keyOf(usage: Pick<BudgetUsage, 'scope' | 'metric' | 'agentId'>): string {
  return `${usage.scope === 'agent' ? `agent:${usage.agentId ?? ''}` : usage.scope}.${usage.metric}`;
}

/**
 * The interrupt a run pauses with when it reaches `usage`. Without `allowRaise` its answer can only
 * stop the run: the host raises a limit by resuming with a higher `budget` of its own
 */
export function budgetInterrupt(usage: BudgetUsage, allowRaise = false): RunInterrupt {
  return {
    id: `budget:${keyOf(usage)}`,
    kind: 'budget',
    reason: 'budget_exceeded',
    message: budgetMessage(usage, allowRaise),
    responseSchema: allowRaise ? BUDGET_RESPONSE_SCHEMA : BUDGET_STOP_SCHEMA,
    details: { ...usage },
  };
}

function amount(metric: BudgetMetric, value: number): string {
  if (metric === 'cost') return `$${value.toFixed(4)}`;
  return metric === 'tokens' ? `${Math.round(value)} tokens` : `${Math.round(value)} tool calls`;
}

function whose(usage: BudgetUsage): string {
  switch (usage.scope) {
    case 'session':
      return 'The session';
    case 'agent':
      return `Agent ${usage.agentId ?? ''} in this session`;
    case 'run':
      return 'The run';
    case 'hour':
      return 'Spending in the last hour';
    case 'day':
      return 'Spending in the last day';
  }
}

/** Why a run paused at `usage`, for the person who answers */
export function budgetMessage(usage: BudgetUsage, allowRaise = false): string {
  const subject = whose(usage);
  const verb = usage.metric === 'toolCalls' ? 'would pass' : 'reached';
  const spent = `${subject} ${verb} its budget: ${amount(usage.metric, usage.used)} of ${amount(usage.metric, usage.limit)}.`;
  return allowRaise
    ? `${spent} Answer { "action": "continue", "limit": <new limit> } to raise it, { "action": "continue" } to go on past it for this run, or { "action": "stop" }`
    : `${spent} Answer { "action": "stop" } to end the run. Only the host can raise the limit`;
}

/** Reads the answer to a budget interrupt */
export function readBudgetResponse(response: unknown): BudgetResponse | undefined {
  const parsed = BudgetResponseSchema.safeParse(response);
  return parsed.success ? parsed.data : undefined;
}

/** What a run's budgets are made of */
export interface RunBudgetOptions {
  runId: string;
  threadId: string;
  /** The session and agent budgets, the runtime's and the run's merged */
  config: SessionBudgetConfig;
  /** An agent's own `budget` */
  agentLimits: (agentId: string) => BudgetLimits | undefined;
  /** `limits.maxTokensPerRun`, when reaching it pauses the run instead of failing it */
  maxTokensPerRun?: number;
  /** The cost routing budgets, when reaching them pauses the run instead of failing it */
  costLimits?: (
    runCost: number
  ) => Array<{ scope: 'run' | 'hour' | 'day'; used: number; limit: number }>;
  /** Hears each warning, besides `config.onWarning` */
  onWarning?: (warning: BudgetWarning) => void;
  /** Whether an agent of the run has a `budget` of its own, so the session's spending is kept */
  agentBudgets?: boolean;
  /** The run's own budgets, kept in the checkpoint */
  ownLimits?: Omit<SessionBudgetConfig, 'onWarning'>;
  /**
   * The budgets the caller passed to this very call (`run()` or `resume()`): the host's decision,
   * which wins over limits an earlier answer raised or lifted
   */
  explicit?: SessionBudgetConfig;
}

interface LimitState {
  usage: BudgetUsage;
}

/**
 * The live spending of one session in this process: what its record held when last read or
 * written, and every run of it going on, whose spending not yet recorded counts too. Runs of one
 * thread at the same time share it, so each sees what the others spend before every model call
 * and tool call
 */
export class SessionLedger {
  private readonly runs = new Set<RunBudget>();

  constructor(private recorded: SessionSpend) {}

  /** What the session's record holds, the fresher of what this ledger knew and `stored` */
  refresh(stored: SessionSpend): void {
    this.recorded = freshestSpend(this.recorded, stored);
  }

  join(run: RunBudget): void {
    this.runs.add(run);
  }

  /** Takes a run that ended out, true when no run of the session goes on any more */
  leave(run: RunBudget): boolean {
    this.runs.delete(run);
    return this.idle;
  }

  /** Whether no run of the session goes on */
  get idle(): boolean {
    return this.runs.size === 0;
  }

  /** The session's record, with the limits it raised */
  get record(): SessionSpend {
    return this.recorded;
  }

  /** What the session spent: its record and what every run of it spent that is not recorded */
  totals(): SessionSpend {
    let total = this.recorded;
    for (const run of this.runs) {
      const pending = run.pendingRecord();
      total = addToSession(total, pending.spend, pending.raised);
    }
    return total;
  }
}

/**
 * What a run counts against its budgets: the session's spending before it, what it spends itself
 * by agent, and the limits answers lifted or raised. It tells the run which limit it reached
 * before a model call or a tool turn, and warns once per run per limit past `warnAt`
 */
export class RunBudget {
  private readonly spent: BudgetSpend;
  private recorded: BudgetSpend;
  private readonly lifted: Set<string>;
  private readonly runRaised: Record<string, number>;
  private readonly sessionRaised: Record<string, number> = dictionary();
  private readonly warned = new Set<string>();

  private readonly ledger: SessionLedger;

  /**
   * `session` is the session's spending as its record holds it, or the ledger the runs of the
   * session in this process share
   */
  constructor(
    private readonly options: RunBudgetOptions,
    session: SessionSpend | SessionLedger,
    state?: RunCheckpoint['budget']
  ) {
    this.spent = state ? copySpend(state.spent) : emptySpend();
    this.recorded = state ? copySpend(state.recorded) : emptySpend();
    this.lifted = new Set(state?.lifted ?? []);
    this.runRaised = dictionary(Object.entries(state?.raised ?? {}));
    this.ledger = session instanceof SessionLedger ? session : new SessionLedger(session);
    this.ledger.join(this);
  }

  /** Takes the run out of its session's ledger once it ended: true when it was the last one */
  leave(): boolean {
    return this.ledger.leave(this);
  }

  /** Whether any budget applies to the run */
  get configured(): boolean {
    const { config } = this.options;
    return (
      hasLimit(config.session) ||
      hasLimit(config.agent) ||
      this.options.agentBudgets === true ||
      this.options.maxTokensPerRun !== undefined ||
      this.options.costLimits !== undefined
    );
  }

  /** Whether a limit of money applies to what the run spends for `agentId` */
  limitsCost(agentId: string): boolean {
    const { config, explicit } = this.options;
    const agent = this.options.agentLimits(agentId) ?? config.agent;
    return (
      config.session?.maxCostUsd !== undefined ||
      explicit?.session?.maxCostUsd !== undefined ||
      agent?.maxCostUsd !== undefined ||
      explicit?.agent?.maxCostUsd !== undefined ||
      this.options.costLimits !== undefined
    );
  }

  /** Whether the run has session or agent budgets, so its spending is kept for the thread */
  get keepsSession(): boolean {
    return (
      hasLimit(this.options.config.session) ||
      hasLimit(this.options.config.agent) ||
      this.options.agentBudgets === true
    );
  }

  noteModel(agentId: string, costUsd: number, tokens: number): void {
    add(this.spent, agentId, { costUsd, tokens });
  }

  /** What the run spent so far, its delegates included */
  runTotals(): { costUsd: number; tokens: number } {
    return { costUsd: this.spent.costUsd, tokens: this.spent.tokens };
  }

  noteToolCalls(agentId: string, count: number): void {
    add(this.spent, agentId, { toolCalls: count });
  }

  /**
   * What the session spent, the spending not yet recorded of this run and of the other runs of
   * the session going on in this process included
   */
  sessionTotals(): SessionSpend {
    return this.ledger.totals();
  }

  /** What the run spent that the session's record does not hold yet, with the limits it raised */
  pendingRecord(): { spend: BudgetSpend; raised: Record<string, number> } {
    return {
      spend: minus(this.spent, this.recorded),
      raised: dictionary(Object.entries(this.sessionRaised)),
    };
  }

  /** The session's record now holds everything the run spent */
  markRecorded(session: SessionSpend): void {
    this.ledger.refresh(session);
    this.recorded = copySpend(this.spent);
  }

  private limitOf(
    key: string,
    configured: number | undefined,
    explicit: number | undefined
  ): number | undefined {
    return (
      explicit ??
      own(this.sessionRaised, key) ??
      own(this.ledger.record.raised, key) ??
      own(this.runRaised, key) ??
      configured
    );
  }

  private limits(
    agentId: string,
    runCost: number,
    runTokens: number,
    metrics: readonly BudgetMetric[]
  ): LimitState[] {
    const totals = this.sessionTotals();
    const agentTotals = own(totals.agents, agentId) ?? emptyTotals();
    const agentLimits = this.options.agentLimits(agentId) ?? this.options.config.agent;
    const session = this.options.config.session;
    const states: LimitState[] = [];
    const explicit = this.options.explicit;
    const push = (
      usage: Omit<BudgetUsage, 'limit'>,
      configured: number | undefined,
      given?: number
    ) => {
      const key = keyOf(usage);
      if (given !== undefined) this.lifted.delete(key);
      const limit = this.limitOf(key, configured, given);
      if (limit === undefined || this.lifted.has(key)) return;
      states.push({ usage: { ...usage, limit } });
    };
    for (const metric of metrics) {
      const field = metric === 'cost' ? 'costUsd' : metric;
      const option =
        metric === 'cost' ? 'maxCostUsd' : metric === 'tokens' ? 'maxTokens' : 'maxToolCalls';
      push(
        { scope: 'session', metric, used: totals[field] },
        session?.[option],
        explicit?.session?.[option]
      );
      push(
        { scope: 'agent', metric, used: agentTotals[field], agentId },
        agentLimits?.[option],
        explicit?.agent?.[option]
      );
    }
    if (metrics.includes('tokens') && this.options.maxTokensPerRun !== undefined) {
      push({ scope: 'run', metric: 'tokens', used: runTokens }, this.options.maxTokensPerRun);
    }
    if (metrics.includes('cost')) {
      for (const limit of this.options.costLimits?.(runCost) ?? []) {
        push({ scope: limit.scope, metric: 'cost', used: limit.used }, limit.limit);
      }
    }
    return states;
  }

  /** The first limit the run reached, before its next model call */
  beforeModel(agentId: string, runCost: number, runTokens: number): BudgetUsage | undefined {
    return this.limits(agentId, runCost, runTokens, ['cost', 'tokens']).find(
      (state) => state.usage.used >= state.usage.limit
    )?.usage;
  }

  /** The first tool call limit `count` more calls would pass */
  beforeTools(agentId: string, count: number): BudgetUsage | undefined {
    return this.limits(agentId, 0, 0, ['toolCalls']).find(
      (state) => state.usage.used + count > state.usage.limit
    )?.usage;
  }

  /** Warns of each limit past its warning share for the first time in this run */
  warn(agentId: string, runCost: number, runTokens: number): void {
    const warnAt = this.options.config.warnAt ?? DEFAULT_WARN_AT;
    for (const { usage } of this.limits(agentId, runCost, runTokens, [
      'cost',
      'tokens',
      'toolCalls',
    ])) {
      const key = keyOf(usage);
      if (this.warned.has(key) || usage.limit <= 0) continue;
      const share = usage.used / usage.limit;
      if (share < warnAt || share >= 1) continue;
      this.warned.add(key);
      const warning: BudgetWarning = {
        ...usage,
        runId: this.options.runId,
        threadId: this.options.threadId,
      };
      for (const listener of [this.options.config.onWarning, this.options.onWarning]) {
        try {
          listener?.(warning);
        } catch (error) {
          getLogger().warn('A budget warning listener failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  /**
   * Applies the answer to the interrupt of `usage`: `stop`, or `continue` with a new limit (kept
   * for the session for a session or agent limit, for the run otherwise) or without one (the limit
   * is lifted for the rest of the run)
   */
  answer(usage: BudgetUsage, response: BudgetResponse): 'stop' | 'continue' {
    if (response.action === 'stop' || this.options.config.allowRaise !== true) return 'stop';
    const key = keyOf(usage);
    if (response.limit === undefined) {
      this.lifted.add(key);
    } else if (usage.scope === 'session' || usage.scope === 'agent') {
      this.sessionRaised[key] = response.limit;
    } else {
      this.runRaised[key] = response.limit;
    }
    this.warned.delete(key);
    return 'continue';
  }

  /** What a checkpoint keeps of the run's budgets */
  state(): NonNullable<RunCheckpoint['budget']> {
    const pending = this.pendingRecord();
    const limits = this.options.ownLimits;
    return {
      ...(limits && Object.keys(limits).length > 0 && { limits: { ...limits } }),
      spent: copySpend(this.spent),
      recorded: copySpend(this.recorded),
      ...(this.lifted.size > 0 && { lifted: [...this.lifted] }),
      ...((Object.keys(this.runRaised).length > 0 || Object.keys(pending.raised).length > 0) && {
        raised: dictionary([...Object.entries(this.runRaised), ...Object.entries(pending.raised)]),
      }),
    };
  }
}

function hasLimit(limits: BudgetLimits | undefined): boolean {
  return (
    limits !== undefined &&
    (limits.maxCostUsd !== undefined ||
      limits.maxTokens !== undefined ||
      limits.maxToolCalls !== undefined)
  );
}

/** The usage a budget interrupt names, read back from its `details` */
export function usageOf(entry: RunInterrupt): BudgetUsage | undefined {
  const details = entry.details;
  if (!details) return undefined;
  const parsed = z
    .object({
      scope: z.enum(['session', 'agent', 'run', 'hour', 'day']),
      metric: z.enum(['cost', 'tokens', 'toolCalls']),
      used: z.number(),
      limit: z.number(),
      agentId: z.string().optional(),
    })
    .safeParse(details);
  if (!parsed.success) return undefined;
  const scope: BudgetScope = parsed.data.scope;
  return { ...parsed.data, scope };
}
