import {
  CogitatorError,
  ErrorCode,
  type RunCheckpoint,
  type RunInterrupt,
  type ToolApprovalRequest,
} from '@cogitator-ai/types';

/** What every run outcome has that tells a paused run apart: a `RunResult` or its wire form. */
export interface PausableRun {
  readonly status?: string;
  readonly pendingApprovals?: readonly ToolApprovalRequest[];
  /** What a paused run waits on, questions of its tools among them */
  readonly interrupts?: readonly RunInterrupt[];
}

/** A run outcome that waits for tool approvals, as {@link isPausedRun} narrows it. */
export type PausedRun<T extends PausableRun> = T & {
  readonly status: 'paused';
  readonly pendingApprovals: readonly ToolApprovalRequest[];
};

/**
 * Whether a run stopped to wait for tool approvals (`status: 'paused'`). Its `output` is then not
 * the agent's answer: the calls in `pendingApprovals` wait for a decision, and the run goes on
 * with `cogitator.resume()`. Every layer that hands a run on checks this, so a pause never passes
 * for a finished run.
 */
export function isPausedRun<T extends PausableRun>(result: T): result is PausedRun<T> {
  return result.status === 'paused';
}

/**
 * The questions a paused run's tools asked (`context.interrupt()`) that wait for an answer: the
 * interrupts that are not approvals. Code that decides approvals and resumes on its own must
 * stop at a pause with any: no decision answers them, and resuming without answers only pauses
 * again. Empty for a run that is not paused
 */
export function pendingQuestions(result: PausableRun): RunInterrupt[] {
  if (result.status !== 'paused') return [];
  return (result.interrupts ?? []).filter((entry) => entry.kind !== 'approval');
}

/** The run a {@link AgentRunPausedError} reports. */
export interface PausedRunInfo {
  readonly threadId: string;
  readonly runId?: string;
  readonly pendingApprovals?: readonly ToolApprovalRequest[];
  /** What the run waits on, questions of its tools among them */
  readonly interrupts?: readonly RunInterrupt[];
  readonly checkpoint?: RunCheckpoint;
}

/** What a paused run waits for, for the message of {@link AgentRunPausedError} */
function describeWait(run: PausedRunInfo): string {
  const approvals = run.pendingApprovals ?? [];
  const questions = (run.interrupts ?? []).filter((entry) => entry.kind !== 'approval');
  if (approvals.length === 0 && questions.length > 0) {
    return `answers to ${questions.map((entry) => entry.reason).join(', ')}`;
  }
  return `approval of ${describeCalls(approvals)}`;
}

/** What the caller does to go on, for the message of {@link AgentRunPausedError} */
function nextStep(run: PausedRunInfo): string {
  const asks = (run.pendingApprovals ?? []).length === 0 && (run.interrupts ?? []).length > 0;
  return asks
    ? 'Answer them in the responses of cogitator.resume() to continue the run.'
    : 'Decide the calls and continue the run with cogitator.resume(), or let the agent decide them with onApproval.';
}

function describeCalls(approvals: readonly ToolApprovalRequest[]): string {
  if (approvals.length === 0) return 'tool calls';
  return approvals.map((approval) => approval.toolName).join(', ');
}

/**
 * An agent run paused where the caller cannot wait for it: for tool approvals in a workflow node
 * without an approval store, a swarm turn, a queued workflow job, or for questions its tools
 * asked, which only a person answers. It carries what the run waits
 * on and the `checkpoint` to resume it with `cogitator.resume()` once someone decided.
 */
export class AgentRunPausedError extends CogitatorError {
  readonly agentName: string;
  readonly threadId: string;
  readonly runId?: string;
  readonly pendingApprovals: readonly ToolApprovalRequest[];
  /** The questions of its tools the run waits on, answered in `responses` of the resume */
  readonly interrupts: readonly RunInterrupt[];
  readonly checkpoint?: RunCheckpoint;

  /**
   * @param run - The paused run (a `RunResult` or its wire form)
   * @param agentName - The agent whose run paused
   * @param where - Where the run paused, for the message (e.g. `workflow "refunds", node "pay"`)
   */
  constructor(run: PausedRunInfo, agentName: string, where?: string) {
    const pendingApprovals = [...(run.pendingApprovals ?? [])];
    super({
      message:
        `Agent "${agentName}" paused${where ? ` in ${where}` : ''} to wait for ${describeWait(run)} ` +
        `(thread ${run.threadId}). ${nextStep(run)}`,
      code: ErrorCode.RUN_PAUSED,
      details: {
        agent: agentName,
        threadId: run.threadId,
        ...(run.runId !== undefined && { runId: run.runId }),
        pendingApprovals,
        ...(run.interrupts?.length && { interrupts: [...run.interrupts] }),
      },
    });
    this.name = 'AgentRunPausedError';
    this.agentName = agentName;
    this.threadId = run.threadId;
    this.runId = run.runId;
    this.pendingApprovals = pendingApprovals;
    this.interrupts = [...(run.interrupts ?? [])];
    this.checkpoint = run.checkpoint;
  }
}

/**
 * The {@link AgentRunPausedError} behind `error`, when an agent run paused somewhere below it:
 * the error itself or one in its `cause` chain.
 */
export function findAgentRunPausedError(error: unknown): AgentRunPausedError | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof AgentRunPausedError) return current;
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}
