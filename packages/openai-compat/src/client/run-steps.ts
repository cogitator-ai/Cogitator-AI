import { nanoid } from 'nanoid';
import type { Span, ToolCall as AgentToolCall, ToolResult } from '@cogitator-ai/types';
import type {
  Run,
  RunError,
  RunStep,
  RunStepDelta,
  RunStepStatus,
  StepDetails,
  Usage,
} from '../types/openai-types';

export type RunStepEventType =
  | 'thread.run.step.created'
  | 'thread.run.step.in_progress'
  | 'thread.run.step.delta'
  | 'thread.run.step.completed'
  | 'thread.run.step.failed'
  | 'thread.run.step.cancelled'
  | 'thread.run.step.expired';

/** How a run ended, which settles the steps it left in progress. */
export type RunStepOutcome =
  | { status: 'completed' }
  | { status: 'cancelled' }
  | { status: 'expired' }
  | { status: 'failed'; error: RunError };

type FunctionStepCall = Extract<
  Extract<StepDetails, { type: 'tool_calls' }>['tool_calls'][number],
  { type: 'function' }
>;

interface OpenToolStep {
  step: RunStep;
  calls: FunctionStepCall[];
  awaiting: Set<string>;
}

const SETTLED_EVENT: Record<Exclude<RunStepStatus, 'in_progress'>, RunStepEventType> = {
  completed: 'thread.run.step.completed',
  failed: 'thread.run.step.failed',
  cancelled: 'thread.run.step.cancelled',
  expired: 'thread.run.step.expired',
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function toOutput(result: ToolResult): string {
  if (result.error !== undefined) return result.error;
  if (typeof result.result === 'string') return result.result;
  return JSON.stringify(result.result) ?? String(result.result);
}

/**
 * The steps of one run, built from what the agent run reports: a `tool_calls` step for each model
 * turn that called tools, which completes once every call of the turn has its output (after
 * `submit_tool_outputs` for the calls the client answers), and a `message_creation` step for the
 * assistant message of the run. Each step carries the usage of the model call that produced it
 * when the run reports it (`llm.chat` spans), and emits the `thread.run.step.*` events in order.
 */
export class RunStepRecorder {
  private readonly steps: RunStep[] = [];
  private toolStep?: OpenToolStep;
  private messageStep?: RunStep;
  private unclaimedUsage: Usage | null = null;
  private settled = false;

  constructor(
    private readonly run: Run,
    private readonly emit: (event: RunStepEventType, data: RunStep | RunStepDelta) => void
  ) {}

  /** The steps in the order they were created */
  list(): RunStep[] {
    return this.steps.map((step) => structuredClone(step));
  }

  get(stepId: string): RunStep | undefined {
    const step = this.steps.find((candidate) => candidate.id === stepId);
    return step ? structuredClone(step) : undefined;
  }

  /** Count the tokens of a finished model call toward the step that call leads to. */
  recordSpan(span: Span): void {
    if (this.settled || span.name !== 'llm.chat') return;
    const input = span.attributes['llm.input_tokens'];
    const output = span.attributes['llm.output_tokens'];
    if (typeof input !== 'number' || typeof output !== 'number') return;
    const prior = this.unclaimedUsage;
    this.unclaimedUsage = {
      prompt_tokens: (prior?.prompt_tokens ?? 0) + input,
      completion_tokens: (prior?.completion_tokens ?? 0) + output,
      total_tokens: (prior?.total_tokens ?? 0) + input + output,
    };
  }

  /** A tool call of the current model turn: it joins the open `tool_calls` step, or opens one. */
  toolCalled(call: AgentToolCall): void {
    if (this.settled) return;
    let open = this.toolStep;
    if (!open) {
      const calls: FunctionStepCall[] = [];
      const step = this.createStep({ type: 'tool_calls', tool_calls: calls });
      open = { step, calls, awaiting: new Set() };
      this.toolStep = open;
    }

    const index = open.calls.length;
    const stepCall: FunctionStepCall = {
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments), output: null },
    };
    open.calls.push(stepCall);
    open.awaiting.add(call.id);
    this.emit('thread.run.step.delta', {
      id: open.step.id,
      object: 'thread.run.step.delta',
      delta: {
        step_details: {
          type: 'tool_calls',
          tool_calls: [{ index, ...structuredClone(stepCall) }],
        },
      },
    });
  }

  /** The output of a tool call: the step completes once every call of its turn has one. */
  toolReturned(result: ToolResult): void {
    const open = this.toolStep;
    if (this.settled || !open?.awaiting.has(result.callId)) return;
    const call = open.calls.find((candidate) => candidate.id === result.callId);
    if (call) call.function.output = toOutput(result);
    open.awaiting.delete(result.callId);
    if (open.awaiting.size === 0) {
      this.toolStep = undefined;
      this.settle(open.step, 'completed');
    }
  }

  /**
   * The run started an assistant message: opens a `message_creation` step pointing at it. A run
   * writes one message per model turn that answered with text, each with its own step.
   */
  messageStarted(messageId: string): void {
    if (this.settled || this.messageStep?.status === 'in_progress') return;
    this.messageStep = this.createStep({
      type: 'message_creation',
      message_creation: { message_id: messageId },
    });
  }

  /**
   * The assistant message is written. The step takes the usage of the model calls since the last
   * step (a turn that wrote text and then called tools counts toward its message, the first step
   * it produced), or `runUsage` when it is the only step of the run, so every call was its own.
   */
  messageFinished(runUsage: Usage | null): void {
    const step = this.messageStep;
    if (this.settled || step?.status !== 'in_progress') return;
    step.usage = this.claimUsage() ?? (this.steps.length === 1 ? runUsage : null);
    this.settle(step, 'completed');
  }

  /** Settle the steps still in progress as the run ended; later reports are ignored. */
  finish(outcome: RunStepOutcome): void {
    if (this.settled) return;
    for (const step of this.steps) {
      if (step.status !== 'in_progress') continue;
      if (outcome.status === 'failed') step.last_error = { ...outcome.error };
      this.settle(step, outcome.status);
    }
    this.toolStep = undefined;
    this.settled = true;
  }

  private claimUsage(): Usage | null {
    const usage = this.unclaimedUsage;
    this.unclaimedUsage = null;
    return usage;
  }

  private createStep(details: StepDetails): RunStep {
    const step: RunStep = {
      id: `step_${nanoid()}`,
      object: 'thread.run.step',
      created_at: nowSeconds(),
      run_id: this.run.id,
      assistant_id: this.run.assistant_id,
      thread_id: this.run.thread_id,
      type: details.type,
      status: 'in_progress',
      step_details: details,
      last_error: null,
      expired_at: null,
      cancelled_at: null,
      failed_at: null,
      completed_at: null,
      metadata: {},
      usage: details.type === 'tool_calls' ? this.claimUsage() : null,
    };
    this.steps.push(step);
    this.emit('thread.run.step.created', step);
    this.emit('thread.run.step.in_progress', step);
    return step;
  }

  private settle(step: RunStep, status: Exclude<RunStepStatus, 'in_progress'>): void {
    const now = nowSeconds();
    step.status = status;
    if (status === 'completed') step.completed_at = now;
    else if (status === 'failed') step.failed_at = now;
    else if (status === 'cancelled') step.cancelled_at = now;
    else step.expired_at = now;
    this.emit(SETTLED_EVENT[status], step);
  }
}
