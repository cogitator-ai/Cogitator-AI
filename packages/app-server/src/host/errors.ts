import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { JsonRpcCallError, type JsonRpcError } from '@cogitator-ai/server-shared';
import type { ZodError } from 'zod';
import { APP_SERVER_ERROR_CODES, type NotFoundKind } from '../protocol/errors.js';

export function notFound(kind: NotFoundKind, id: string): JsonRpcCallError {
  const label = kind.charAt(0).toUpperCase() + kind.slice(1);
  return new JsonRpcCallError({
    code: APP_SERVER_ERROR_CODES.notFound,
    message: `${label} ${id} does not exist`,
    data: { kind, id },
  });
}

export function invalidParams(message: string, error?: ZodError): JsonRpcCallError {
  return new JsonRpcCallError({
    code: APP_SERVER_ERROR_CODES.invalidParams,
    message,
    data: {
      issues: (error?.issues ?? []).map((issue) => ({
        path: issue.path.filter(
          (key): key is string | number => typeof key === 'string' || typeof key === 'number'
        ),
        message: issue.message,
        code: issue.code,
      })),
    },
  });
}

export function threadBusy(threadId: string, activeTurnId: string): JsonRpcCallError {
  return new JsonRpcCallError({
    code: APP_SERVER_ERROR_CODES.threadBusy,
    message: `Thread ${threadId} has turn ${activeTurnId} going on`,
    data: { threadId, activeTurnId },
  });
}

export function turnNotActive(
  threadId: string,
  turnId: string,
  activeTurnId: string | undefined
): JsonRpcCallError {
  return new JsonRpcCallError({
    code: APP_SERVER_ERROR_CODES.turnNotActive,
    message: activeTurnId
      ? `Turn ${turnId} is not the turn going on in thread ${threadId}`
      : `Thread ${threadId} has no turn going on`,
    data: { threadId, ...(activeTurnId !== undefined && { activeTurnId }) },
  });
}

export function threadPaused(threadId: string): JsonRpcCallError {
  return new JsonRpcCallError({
    code: APP_SERVER_ERROR_CODES.threadPaused,
    message: `Thread ${threadId} waits on approvals or answers: resume it with turn/start and resume`,
    data: { threadId },
  });
}

export function threadArchived(threadId: string): JsonRpcCallError {
  return new JsonRpcCallError({
    code: APP_SERVER_ERROR_CODES.threadArchived,
    message: `Thread ${threadId} is archived: unarchive it first`,
    data: { threadId },
  });
}

export function runtimeError(code: string, message: string): JsonRpcCallError {
  return new JsonRpcCallError({
    code: APP_SERVER_ERROR_CODES.runtimeError,
    message,
    data: { code },
  });
}

/**
 * How an error a call ended with reaches the client: a {@link JsonRpcCallError} as it is, an
 * error of the runtime as `runtimeError` with its code, anything else as `internalError`, its
 * message shown only with `expose` since it may hold what a client must not see
 */
export function describeAppServerError(error: unknown, expose = false): JsonRpcError {
  if (error instanceof JsonRpcCallError) return error.toJSON();
  if (CogitatorError.isCogitatorError(error)) {
    return runtimeError(error.code, error.message).toJSON();
  }
  return {
    code: APP_SERVER_ERROR_CODES.internalError,
    message: expose && error instanceof Error ? error.message : 'Internal error',
  };
}

/** The error a failed turn reports: the runtime's code and message, others hidden unless `expose` */
export function describeTurnError(
  error: unknown,
  expose = false
): { message: string; code?: string } {
  if (CogitatorError.isCogitatorError(error)) return { message: error.message, code: error.code };
  if (expose && error instanceof Error) return { message: error.message };
  return { message: 'Internal error', code: ErrorCode.INTERNAL_ERROR };
}
