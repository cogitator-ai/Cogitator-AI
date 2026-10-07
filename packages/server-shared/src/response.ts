import type { RunBlockReason, RunResult, ToolApprovalRequest, ToolCall } from '@cogitator-ai/types';
import type { PendingApproval } from './protocol.js';
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
  }));
}

/** How `result` ended: its status and the flags that apply to it */
export function toAgentRunOutcome(result: RunResult): AgentRunOutcome {
  const paused = result.status === 'paused';
  return {
    status: paused ? 'paused' : 'completed',
    ...(paused && { pendingApprovals: toPendingApprovals(result.pendingApprovals ?? []) }),
    ...(result.structured !== undefined && { structured: result.structured }),
    ...(result.structuredError !== undefined && { structuredError: result.structuredError }),
    ...(result.truncated === true && { truncated: true as const }),
    ...(result.blocked !== undefined && { blocked: result.blocked }),
    ...(result.iterationLimitReached === true && { iterationLimitReached: true as const }),
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
