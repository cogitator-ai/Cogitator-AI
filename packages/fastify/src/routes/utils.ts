import type { FastifyReply, FastifyRequest } from 'fastify';
import { CogitatorError, ERROR_STATUS_CODES, ErrorCode, type RunResult } from '@cogitator-ai/types';
import type { AgentRunResponse } from '../types.js';

export function sendError(
  reply: FastifyReply,
  status: number,
  message: string,
  code: string
): FastifyReply {
  return reply.status(status).send({ error: { message, code } });
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

/**
 * What a client may see of an error: a `CogitatorError` as it is, anything
 * else as `500 Internal server error`, logged through `source.log` (a request
 * or the server).
 */
export function resolveError(
  source: Pick<FastifyRequest, 'log'>,
  error: unknown,
  label: string
): ResolvedError {
  if (CogitatorError.isCogitatorError(error)) {
    return {
      status: ERROR_STATUS_CODES[error.code] || 500,
      message: error.message,
      code: error.code,
    };
  }
  source.log.error({ err: error }, label);
  return { status: 500, message: 'Internal server error', code: ErrorCode.INTERNAL_ERROR };
}

export function sendRouteError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  label: string
): FastifyReply {
  const resolved = resolveError(request, error, label);
  return sendError(reply, resolved.status, resolved.message, resolved.code);
}

export function onClientDisconnect(reply: FastifyReply, handler: () => void): void {
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) handler();
  });
}

/** The client-facing shape of a run; never carries the paused run's checkpoint */
export function toAgentRunResponse(result: RunResult): AgentRunResponse {
  return {
    output: result.output,
    threadId: result.threadId,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
    },
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
