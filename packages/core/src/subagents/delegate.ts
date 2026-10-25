import type {
  DelegationApprovalMode,
  DelegationCompleteEvent,
  DelegationHooks,
  DelegationMessages,
  DelegationStartEvent,
  Message,
  PermissionMode,
  RunCheckpoint,
  RunInterrupt,
  RunOptions,
  RunResult,
  ToolApprovalDecision,
  ToolApprovalRequest,
  ToolContext,
  Workspace,
} from '@cogitator-ai/types';
import type { Agent } from '../agent';
import type { Cogitator } from '../runtime';
import { getLogger } from '../logger';
import { ToolInterruptSignal } from '../cogitator/interrupts';
import { pendingQuestions } from '../run-pause';
import { sanitizeToolHistory } from '../utils/tool-history';

/** The decision a delegated run gets for a call nobody can approve, in `decline` mode */
export const DELEGATED_DECLINE: ToolApprovalDecision = {
  approved: false,
  reason: 'no one can approve calls of a delegated agent',
};

/**
 * What a tool that delegates throws when its delegate paused and its approvals and questions
 * bubble up (`approvalMode: 'bubble'`): the run that delegated pauses too, with the delegate's
 * checkpoint inside its own, and its interrupts under the id of the tool call
 */
export class DelegatePauseSignal extends ToolInterruptSignal {
  constructor(
    readonly agent: string,
    readonly checkpoint: RunCheckpoint,
    readonly interrupts: readonly RunInterrupt[],
    readonly pending: readonly ToolApprovalRequest[]
  ) {
    super(
      interrupts[0] ?? {
        id: checkpoint.runId,
        kind: 'input',
        reason: 'delegate_paused',
        message: `The delegated agent "${agent}" paused`,
      }
    );
    this.name = 'DelegatePauseSignal';
  }
}

/** Whether `error` is a delegate's pause bubbling up */
export function isDelegatePause(error: unknown): error is DelegatePauseSignal {
  return error instanceof DelegatePauseSignal;
}

/** The id an interrupt or tool call of a delegate has in the run that delegated with `callId` */
export function nestedId(callId: string, id: string): string {
  return `${callId}/${id}`;
}

/**
 * The interrupts of a delegate that paused, as the run that delegated with tool call `callId`
 * shows them: ids and tool call ids under `<callId>/`, the delegate named in `details.subagent`
 */
export function nestInterrupts(
  callId: string,
  agent: string,
  interrupts: readonly RunInterrupt[]
): RunInterrupt[] {
  return interrupts.map((entry) => ({
    ...entry,
    id: nestedId(callId, entry.id),
    ...(entry.toolCallId !== undefined && { toolCallId: nestedId(callId, entry.toolCallId) }),
    details: {
      ...entry.details,
      subagent:
        typeof entry.details?.subagent === 'string' ? `${agent}/${entry.details.subagent}` : agent,
    },
  }));
}

/** The approvals a delegate waits on, as the run that delegated with tool call `callId` shows them */
export function nestApprovals(
  callId: string,
  agentId: string,
  pending: readonly ToolApprovalRequest[]
): ToolApprovalRequest[] {
  return pending.map((request) => ({
    ...request,
    toolCallId: nestedId(callId, request.toolCallId),
    agentId: request.agentId ?? agentId,
  }));
}

/**
 * The entries of `answers` under `<callId>/`, without that prefix: what a resume answered of the
 * delegate the tool call `callId` left paused
 */
export function answersUnder<T>(
  callId: string,
  answers: Readonly<Record<string, T>>
): Record<string, T> {
  const prefix = `${callId}/`;
  const found: Record<string, T> = {};
  for (const [id, answer] of Object.entries(answers)) {
    if (id.startsWith(prefix)) found[id.slice(prefix.length)] = answer;
  }
  return found;
}

/**
 * The messages of the delegating run a delegate reads before its task, see
 * {@link DelegationMessages}: never system messages or tool calls left without a result
 */
export function delegateHistory(
  messages: readonly Message[],
  mode: DelegationMessages | undefined
): Message[] {
  if (mode === undefined || mode === 'none') return [];
  const visible = messages.filter((message) => message.role !== 'system');
  if (mode === 'conversation') {
    return visible.flatMap((message): Message[] => {
      if (message.role === 'user') return [{ role: 'user', content: message.content }];
      if (message.role !== 'assistant') return [];
      const text = typeof message.content === 'string' ? message.content.trim() : '';
      return text === '' && typeof message.content === 'string'
        ? []
        : [{ role: 'assistant', content: message.content }];
    });
  }
  const picked = mode(visible).filter((message) => message.role !== 'system');
  return sanitizeToolHistory([...picked]);
}

/** How a delegated run is started, see {@link runDelegate} */
export interface DelegateRun extends DelegationHooks {
  agent: Agent;
  task: string;
  approvalMode: DelegationApprovalMode;
  /** Decides the delegate's approvals in `decline` mode, `'pause'` declining them */
  onApproval?: RunOptions['onApproval'];
  messages?: DelegationMessages;
  timeout?: number;
  /** The mode the delegate runs in, instead of the delegating run's */
  mode?: PermissionMode;
  /** The workspace the delegate works in, instead of the delegating run's */
  workspace?: Workspace;
  threadId?: string;
  /** The conversation the delegate goes on from, instead of the delegating run's messages */
  history?: Message[];
  taskId?: string;
  background?: boolean;
  signal?: AbortSignal;
}

function notify<T>(name: string, hook: ((event: T) => void) | undefined, event: T): void {
  if (!hook) return;
  try {
    hook(event);
  } catch (error) {
    getLogger().warn(`${name} failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Runs `run.agent` on `run.task` for the tool call of `context`, or resumes the delegate the call
 * left paused when its run resumes (`context.delegation.resume`). The delegate gets the caller's
 * signal, user, deps, permission mode and `session` rules and, unless it has a workspace of its
 * own, the caller's workspace. In `bubble` mode its approvals go to the caller's run decider, and
 * a pause throws a {@link DelegatePauseSignal} that pauses the caller. In `decline` mode, and
 * outside a run, approvals nobody decides are declined and a pause comes back as the result
 */
export async function runDelegate(
  cogitator: Cogitator,
  run: DelegateRun,
  context: ToolContext
): Promise<RunResult> {
  const delegate = run.agent;
  const delegation = context.delegation;
  const bubbles = run.approvalMode === 'bubble' && delegation !== undefined && !run.background;
  const start: DelegationStartEvent = {
    parentRunId: context.runId,
    parentAgent: context.agentId,
    ...(context.toolCallId !== undefined && { toolCallId: context.toolCallId }),
    agent: delegate.name,
    task: run.task,
    ...(run.taskId !== undefined && { taskId: run.taskId }),
    background: run.background === true,
  };
  const resume = delegation?.resume;
  if (!resume) notify('onDelegationStart', run.onDelegationStart, start);
  const complete = (event: Omit<DelegationCompleteEvent, keyof DelegationStartEvent>) =>
    notify('onDelegationComplete', run.onDelegationComplete, { ...start, ...event });
  const shared = delegateRunOptions(run, context, bubbles);
  const signal = shared.signal;
  let result: RunResult;
  try {
    if (resume) {
      result = await cogitator.resume(delegate, resume.checkpoint, {
        ...shared,
        decisions: resume.decisions,
        responses: resume.responses,
        ...(resume.defaultDecision && { defaultDecision: resume.defaultDecision }),
      });
    } else {
      const history =
        run.history ?? delegateHistory(delegation?.conversation() ?? [], run.messages);
      result = await cogitator.run(delegate, {
        ...shared,
        input: run.task,
        ...(run.threadId !== undefined && { threadId: run.threadId }),
        ...(history.length > 0 && { history }),
      });
    }
  } catch (error) {
    complete({
      status: signal.aborted ? 'stopped' : 'failed',
      output: '',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  if (result.status === 'paused') {
    complete({ status: 'paused', output: result.output, runId: result.runId, usage: result.usage });
    if (bubbles && result.checkpoint) {
      throw new DelegatePauseSignal(
        delegate.name,
        result.checkpoint,
        result.interrupts ?? [],
        result.pendingApprovals ?? []
      );
    }
    return result;
  }
  complete({
    status: 'completed',
    output: result.output,
    runId: result.runId,
    usage: result.usage,
  });
  return result;
}

/**
 * The options a delegated run gets from the tool call that starts it: the caller's signal, user,
 * deps, permission mode (or the one `run.mode` narrows it to) and `session` rules, the caller's
 * workspace unless the delegate has its own, and the approval decider of the mode
 */
export function delegateRunOptions(
  run: DelegateRun,
  context: ToolContext,
  bubbles: boolean
): Omit<RunOptions, 'input'> & { signal: AbortSignal } {
  const delegate = run.agent;
  const workspace = run.workspace ?? (!delegate.config.workspace ? context.workspace : undefined);
  const permissions = context.permissions
    ? { mode: run.mode ?? context.permissions.mode, inherited: context.permissions.inherited }
    : run.mode !== undefined
      ? { mode: run.mode }
      : undefined;
  const onApproval: RunOptions['onApproval'] = bubbles
    ? context.delegation?.onApproval
    : async (request) => {
        const decision = run.onApproval ? await run.onApproval(request) : 'pause';
        return decision === 'pause' ? DELEGATED_DECLINE : decision;
      };
  return {
    timeout: run.timeout ?? delegate.config.timeout,
    signal: run.signal ?? context.signal,
    ...(context.userId !== undefined && { userId: context.userId }),
    ...(context.deps !== undefined && { deps: context.deps }),
    ...(workspace && { workspace }),
    ...(permissions && { permissions }),
    ...(onApproval && { onApproval }),
  };
}

/** Why a delegate that paused could not go on, for the model of the run that delegated */
export function pausedDelegateError(result: RunResult): string {
  const questions = pendingQuestions(result);
  return questions.length > 0
    ? `The delegated agent paused to ask ${questions.map((question) => `"${question.message}"`).join(', ')}, which a delegated run cannot wait for`
    : `The delegated agent paused for approval of ${(result.pendingApprovals ?? []).map((p) => p.toolName).join(', ')}, which a delegated run cannot wait for`;
}
