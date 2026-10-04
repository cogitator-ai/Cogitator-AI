import type { Response } from 'express';
import {
  CogitatorError,
  ERROR_STATUS_CODES,
  ErrorCode,
  type RunResult,
  type ToolApprovalDecision,
} from '@cogitator-ai/types';
import { toRunUsage, type ParseResult } from '@cogitator-ai/server-shared';
import type { AgentResumeRequest, AgentRunResponse } from '../types.js';

export function sendError(res: Response, status: number, message: string, code: string): void {
  res.status(status).json({ error: { message, code } });
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isModuleNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')
  );
}

export interface ResolvedError {
  status: number;
  message: string;
  code: string;
}

export function resolveError(error: unknown, label: string): ResolvedError {
  if (CogitatorError.isCogitatorError(error)) {
    return {
      status: ERROR_STATUS_CODES[error.code] || 500,
      message: error.message,
      code: error.code,
    };
  }
  console.error(`[CogitatorServer] ${label}:`, error);
  return { status: 500, message: 'Internal server error', code: ErrorCode.INTERNAL_ERROR };
}

export function handleRouteError(res: Response, error: unknown, label: string): void {
  if (res.headersSent) return;
  const resolved = resolveError(error, label);
  sendError(res, resolved.status, resolved.message, resolved.code);
}

export function onClientDisconnect(res: Response, handler: () => void): void {
  res.on('close', () => {
    if (!res.writableEnded) handler();
  });
}

export type { ParseResult };

const DECISION_SHAPE = '{ approved: boolean, reason?: string }';

function parseDecision(value: unknown): ToolApprovalDecision | null {
  if (!isPlainObject(value) || typeof value.approved !== 'boolean') return null;
  if (value.reason !== undefined && typeof value.reason !== 'string') return null;
  if (value.approved) return { approved: true };
  return value.reason === undefined
    ? { approved: false }
    : { approved: false, reason: value.reason };
}

export function parseResumeBody(body: unknown): ParseResult<AgentResumeRequest> {
  if (!isPlainObject(body) || typeof body.threadId !== 'string' || body.threadId.trim() === '') {
    return { ok: false, message: 'Missing required field: threadId' };
  }

  let decisions: Record<string, ToolApprovalDecision> | undefined;
  if (body.decisions !== undefined) {
    if (!isPlainObject(body.decisions)) {
      return { ok: false, message: 'Field decisions must be an object' };
    }
    const entries: Array<[string, ToolApprovalDecision]> = [];
    for (const [toolCallId, value] of Object.entries(body.decisions)) {
      const decision = parseDecision(value);
      if (!decision) {
        return { ok: false, message: `Each entry of decisions must be ${DECISION_SHAPE}` };
      }
      entries.push([toolCallId, decision]);
    }
    decisions = Object.fromEntries(entries);
  }

  let defaultDecision: ToolApprovalDecision | undefined;
  if (body.defaultDecision !== undefined) {
    const decision = parseDecision(body.defaultDecision);
    if (!decision) {
      return { ok: false, message: `Field defaultDecision must be ${DECISION_SHAPE}` };
    }
    defaultDecision = decision;
  }

  return {
    ok: true,
    value: {
      threadId: body.threadId,
      ...(decisions && { decisions }),
      ...(defaultDecision && { defaultDecision }),
    },
  };
}

/** The client-facing shape of a run; never carries the paused run's checkpoint */
export function toAgentRunResponse(result: RunResult): AgentRunResponse {
  return {
    output: result.output,
    threadId: result.threadId,
    usage: toRunUsage(result.usage),
    toolCalls: [...result.toolCalls],
    ...(result.reasoning && { reasoning: result.reasoning }),
    status: result.status ?? 'completed',
    ...(result.pendingApprovals && { pendingApprovals: [...result.pendingApprovals] }),
  };
}

export function withoutCheckpoint(result: RunResult): Omit<RunResult, 'checkpoint'> {
  const { checkpoint: _checkpoint, ...rest } = result;
  return rest;
}

export interface WorkflowBody {
  input?: Record<string, unknown>;
  options: {
    maxConcurrency?: number;
    maxIterations?: number;
    checkpoint?: boolean;
  };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function parseWorkflowBody(body: unknown): ParseResult<WorkflowBody> {
  const data = body ?? {};
  if (!isPlainObject(data)) {
    return { ok: false, message: 'Request body must be an object' };
  }
  if (data.input !== undefined && !isPlainObject(data.input)) {
    return { ok: false, message: 'Field input must be an object' };
  }
  const rawOptions = data.options ?? {};
  if (!isPlainObject(rawOptions)) {
    return { ok: false, message: 'Field options must be an object' };
  }
  const { maxConcurrency, maxIterations, checkpoint } = rawOptions;
  if (maxConcurrency !== undefined && !isPositiveInteger(maxConcurrency)) {
    return { ok: false, message: 'options.maxConcurrency must be a positive integer' };
  }
  if (maxIterations !== undefined && !isPositiveInteger(maxIterations)) {
    return { ok: false, message: 'options.maxIterations must be a positive integer' };
  }
  if (checkpoint !== undefined && typeof checkpoint !== 'boolean') {
    return { ok: false, message: 'options.checkpoint must be a boolean' };
  }
  return {
    ok: true,
    value: {
      input: data.input,
      options: { maxConcurrency, maxIterations, checkpoint },
    },
  };
}
