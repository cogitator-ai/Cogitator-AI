import type {
  RunBlockReason,
  RunInterrupt,
  RunResult,
  ToolApprovalRequest,
  ToolCall,
  WorkflowResult,
} from '@cogitator-ai/types';
import type { PendingApproval, PendingInterrupt } from './protocol.js';
import { toRunUsage, type RunUsage } from './usage.js';

/** A tool call of a run as clients see it: without the provider state that rides along */
export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * How a run ended, beyond its text. The same fields in the JSON run response, in the stream's
 * `finish` event and in the WebSocket `complete` event of every adapter. Each one is present
 * only when it applies.
 */
export interface AgentRunOutcome {
  /** `paused` when tool calls wait for approval: resume the run with the thread id to go on */
  status: 'completed' | 'paused';
  /** The tool calls a paused run waits on */
  pendingApprovals?: PendingApproval[];
  /**
   * The questions a paused run's tools asked, when it waits on any: answer them by id in
   * `responses` when resuming. A run paused for approvals only has `pendingApprovals`
   */
  interrupts?: PendingInterrupt[];
  /** The answer parsed against the agent's `responseFormat` */
  structured?: unknown;
  /** Why the answer does not match the agent's `responseFormat`; `structured` is then absent */
  structuredError?: string;
  /** The last answer stopped at the output token limit, so it may be cut off */
  truncated?: true;
  /** The provider withheld the last answer: `content_filter` or `refusal` */
  blocked?: RunBlockReason;
  /** Tool calls used up the agent's `maxIterations` before the model answered */
  iterationLimitReached?: true;
  /** A hook or middleware ended the run before its next model call: why, and which middleware */
  stopped?: { reason: string; middleware: string };
}

/**
 * The JSON answer of an agent run or resume, the same in every adapter.
 *
 * It never carries what stays on the server: the system prompt and history (`messages`),
 * trace spans with raw tool arguments and errors, or the checkpoint of a paused run, which
 * the server keeps and resumes by thread id. `traceId` links the answer to the server's traces.
 */
export interface AgentRunResponse extends AgentRunOutcome {
  output: string;
  threadId: string;
  usage: RunUsage;
  toolCalls: AgentToolCall[];
  /** The model's reasoning summary, when the agent asks for one (`reasoning.summary`) */
  reasoning?: string;
  traceId: string;
}

/** A tool call without the provider state (`thoughtSignature`, `replay`) it carries */
export function toAgentToolCall(call: Readonly<ToolCall>): AgentToolCall {
  return { id: call.id, name: call.name, arguments: call.arguments };
}

/** The tool calls a paused run waits on, as clients see them */
export function toPendingApprovals(requests: readonly ToolApprovalRequest[]): PendingApproval[] {
  return requests.map((request) => ({
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    arguments: request.arguments,
    description: request.description,
    ...(request.sideEffects !== undefined && { sideEffects: [...request.sideEffects] }),
    ...(request.reason !== undefined && { reason: request.reason }),
    ...(request.rule !== undefined && { rule: request.rule.rule }),
    ...(request.suggestedRule !== undefined && { suggestedRule: request.suggestedRule }),
    ...(request.mode !== undefined && { mode: request.mode }),
  }));
}

const APPROVAL_DETAILS = ['reason', 'rule', 'suggestedRule'] as const;

/** What a client sees of an interrupt's details: for an approval, only its reason and rule texts */
function detailsOf(entry: RunInterrupt): Record<string, unknown> | undefined {
  if (entry.details === undefined) return undefined;
  if (entry.kind !== 'approval') return { ...entry.details };
  const details: Record<string, unknown> = {};
  for (const key of APPROVAL_DETAILS) {
    const value = entry.details[key];
    if (typeof value === 'string') details[key] = value;
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

/**
 * The interrupts of a paused run as clients see them, without answers: none while it waits for
 * approvals only, which `pendingApprovals` carries
 */
export function toPendingInterrupts(interrupts: readonly RunInterrupt[]): PendingInterrupt[] {
  if (!interrupts.some((entry) => entry.kind !== 'approval')) return [];
  return interrupts.map((entry) => {
    const details = detailsOf(entry);
    return {
      id: entry.id,
      kind: entry.kind,
      reason: entry.reason,
      message: entry.message,
      ...(entry.responseSchema !== undefined && { responseSchema: entry.responseSchema }),
      ...(entry.expiresAt !== undefined && { expiresAt: entry.expiresAt }),
      ...(entry.toolCallId !== undefined && { toolCallId: entry.toolCallId }),
      ...(entry.toolName !== undefined && { toolName: entry.toolName }),
      ...(details !== undefined && { details }),
    };
  });
}

/** How `result` ended: its status and the flags that apply to it */
export function toAgentRunOutcome(result: RunResult): AgentRunOutcome {
  const paused = result.status === 'paused';
  const interrupts = paused ? toPendingInterrupts(result.interrupts ?? []) : [];
  return {
    status: paused ? 'paused' : 'completed',
    ...(paused && { pendingApprovals: toPendingApprovals(result.pendingApprovals ?? []) }),
    ...(interrupts.length > 0 && { interrupts }),
    ...(result.structured !== undefined && { structured: result.structured }),
    ...(result.structuredError !== undefined && { structuredError: result.structuredError }),
    ...(result.truncated === true && { truncated: true as const }),
    ...(result.blocked !== undefined && { blocked: result.blocked }),
    ...(result.iterationLimitReached === true && { iterationLimitReached: true as const }),
    ...(result.stopped && { stopped: { ...result.stopped } }),
  };
}

/** The client-facing answer of a run; see {@link AgentRunResponse} for what it leaves out */
export function toAgentRunResponse(result: RunResult): AgentRunResponse {
  return {
    output: result.output,
    threadId: result.threadId,
    usage: toRunUsage(result.usage),
    toolCalls: result.toolCalls.map(toAgentToolCall),
    ...(result.reasoning !== undefined && { reasoning: result.reasoning }),
    ...toAgentRunOutcome(result),
    traceId: result.trace.traceId,
  };
}

/** The data of the `workflow_completed` event that ends a workflow stream */
export interface WorkflowCompletedData {
  workflowId: string;
  duration: number;
  /** The last checkpoint of a run with `options.checkpoint` or of a resume */
  checkpointId?: string;
}

/** What the `workflow_completed` event of every adapter says about a finished workflow run */
export function toWorkflowCompletedData(
  result: Pick<WorkflowResult<unknown>, 'workflowId' | 'duration' | 'checkpointId'>
): WorkflowCompletedData {
  return {
    workflowId: result.workflowId,
    duration: result.duration,
    ...(result.checkpointId !== undefined && { checkpointId: result.checkpointId }),
  };
}

/** The data of the `workflow_failed` event a workflow stream sends right before its `error` */
export interface WorkflowFailedData {
  /** The last checkpoint the failed run saved: resume the run from it */
  checkpointId?: string;
}

/** What the `workflow_failed` event of every adapter says about a failed workflow run */
export function toWorkflowFailedData(
  result: Pick<WorkflowResult<unknown>, 'checkpointId'>
): WorkflowFailedData {
  return result.checkpointId === undefined ? {} : { checkpointId: result.checkpointId };
}

/**
 * The result of a workflow resume, naming the checkpoint it resumed from when the resumed run
 * saved none of its own, as a run that fails before its first checkpoint does: resuming that
 * checkpoint again starts over from the same place
 */
export function withResumedCheckpoint<R extends { checkpointId?: string }>(
  result: R,
  checkpointId: string
): R {
  return result.checkpointId === undefined ? { ...result, checkpointId } : result;
}
