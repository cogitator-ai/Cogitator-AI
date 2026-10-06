import { z } from 'zod';
import type { ToolApprovalDecision, ToolApprovalRequest } from '@cogitator-ai/types';
import type { A2AMessage, A2ATask, DataPart } from './types.js';

/** `kind` of the data part an agent sends when its run waits for tool approvals. */
export const TOOL_APPROVAL_REQUEST_KIND = 'tool-approval-request';
/** `kind` of the data part a client sends back with its decisions. */
export const TOOL_APPROVAL_RESPONSE_KIND = 'tool-approval-response';

/** Metadata key holding the calls a task waits on; never sent to clients. */
export const TASK_PENDING_APPROVALS_KEY = 'cogitator:pendingApprovals';

/** Decisions for the tool calls an `input-required` task waits on. */
export interface ToolApprovalResponse {
  /** Decisions by tool call id; calls left out keep the task waiting */
  decisions?: Record<string, ToolApprovalDecision>;
  /** Decision for every waiting call `decisions` leaves out, e.g. one "approve all" answer */
  defaultDecision?: ToolApprovalDecision;
}

const decisionSchema = z.union([
  z.object({ approved: z.literal(true) }),
  z.object({ approved: z.literal(false), reason: z.string().optional() }),
]);

const responseSchema = z.object({
  kind: z.literal(TOOL_APPROVAL_RESPONSE_KIND),
  decisions: z.record(z.string(), decisionSchema).optional(),
  defaultDecision: decisionSchema.optional(),
});

const approvalSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  description: z.string(),
  sideEffects: z.array(z.string()).optional(),
});

const requestSchema = z.object({
  kind: z.literal(TOOL_APPROVAL_REQUEST_KIND),
  approvals: z.array(approvalSchema),
});

/** The data part an agent's message carries when its run waits for tool approvals. */
export function toolApprovalRequestPart(approvals: readonly ToolApprovalRequest[]): DataPart {
  return {
    type: 'data',
    mimeType: 'application/json',
    data: {
      kind: TOOL_APPROVAL_REQUEST_KIND,
      approvals: approvals.map((approval) => ({ ...approval })),
    },
  };
}

/**
 * The data part that answers an `input-required` task waiting for tool approvals: send it in the
 * message that continues the task.
 *
 * @example
 * ```ts
 * const waiting = readToolApprovalRequest(task);
 * if (waiting) {
 *   await client.sendMessage({
 *     role: 'user',
 *     taskId: task.id,
 *     parts: [toolApprovalResponsePart({ defaultDecision: { approved: true } })],
 *   });
 * }
 * ```
 */
export function toolApprovalResponsePart(response: ToolApprovalResponse): DataPart {
  return {
    type: 'data',
    mimeType: 'application/json',
    data: {
      kind: TOOL_APPROVAL_RESPONSE_KIND,
      ...(response.decisions && { decisions: response.decisions }),
      ...(response.defaultDecision && { defaultDecision: response.defaultDecision }),
    },
  };
}

/**
 * The tool calls an `input-required` task waits on, read from its last agent message, or
 * undefined when the task does not wait for approvals.
 */
export function readToolApprovalRequest(task: A2ATask): ToolApprovalRequest[] | undefined {
  if (task.status.state !== 'input-required') return undefined;
  const last = [...task.history].reverse().find((message) => message.role === 'agent');
  for (const part of last?.parts ?? []) {
    if (part.type !== 'data') continue;
    const parsed = requestSchema.safeParse(part.data);
    if (parsed.success) return parsed.data.approvals;
  }
  return undefined;
}

/** The decisions a message carries in a tool approval response data part, if any. */
export function readToolApprovalResponse(message: A2AMessage): ToolApprovalResponse | undefined {
  for (const part of message.parts) {
    if (part.type !== 'data') continue;
    const parsed = responseSchema.safeParse(part.data);
    if (!parsed.success) continue;
    const { decisions, defaultDecision } = parsed.data;
    return {
      ...(decisions && { decisions }),
      ...(defaultDecision && { defaultDecision }),
    };
  }
  return undefined;
}

/** The calls a task's paused run waits on, as the task manager keeps them. */
export function taskPendingApprovals(task: A2ATask): ToolApprovalRequest[] | undefined {
  const parsed = z.array(approvalSchema).safeParse(task.metadata?.[TASK_PENDING_APPROVALS_KEY]);
  return parsed.success && parsed.data.length > 0 ? parsed.data : undefined;
}
