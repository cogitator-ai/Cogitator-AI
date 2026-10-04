import type { RunResult, ToolApprovalRequest } from '@cogitator-ai/types';
import type { AgentResponse, PendingApproval } from '../types.js';
import { toRunUsage } from '../streaming/protocol.js';

/** The tool calls a paused run waits on, as clients see them. */
export function toPendingApprovals(requests: readonly ToolApprovalRequest[]): PendingApproval[] {
  return requests.map((request) => ({
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    arguments: request.arguments,
    description: request.description,
    ...(request.sideEffects !== undefined && { sideEffects: [...request.sideEffects] }),
  }));
}

/** The JSON answer of a run: everything a client needs, never the run's checkpoint. */
export function toAgentResponse(result: RunResult): AgentResponse {
  return {
    output: result.output,
    threadId: result.threadId,
    usage: toRunUsage(result.usage),
    toolCalls: [...result.toolCalls],
    trace: {
      traceId: result.trace.traceId,
      spans: [...result.trace.spans],
    },
    ...(result.reasoning !== undefined && { reasoning: result.reasoning }),
    ...(result.status !== undefined && { status: result.status }),
    ...(result.pendingApprovals !== undefined && {
      pendingApprovals: toPendingApprovals(result.pendingApprovals),
    }),
  };
}
