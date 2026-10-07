import { CogitatorError } from '@cogitator-ai/types';
import type { JsonRpcError } from './json-rpc.js';
import { JsonRpcParseError } from './json-rpc.js';

/** JSON-RPC error codes of A2A v0.3 (section 8), plus the server error this package adds. */
export const A2A_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  pushNotificationNotSupported: -32003,
  unsupportedOperation: -32004,
  contentTypeNotSupported: -32005,
  invalidAgentResponse: -32006,
  authenticatedExtendedCardNotConfigured: -32007,
  /** Cogitator: the request carries no valid credentials (answered with HTTP 401) */
  unauthorized: -32000,
} as const;

export function taskNotFound(taskId: string): JsonRpcError {
  return {
    code: A2A_ERROR_CODES.taskNotFound,
    message: `Task not found: ${taskId}`,
    data: { taskId },
  };
}

export function taskNotCancelable(taskId: string): JsonRpcError {
  return {
    code: A2A_ERROR_CODES.taskNotCancelable,
    message: `Task cannot be canceled: ${taskId}`,
    data: { taskId },
  };
}

/**
 * A message for a task that cannot take one: a task in a terminal state can't be restarted (A2A
 * v0.3, section 7.1), and a task that is still running takes no second message.
 */
export function taskNotContinuable(taskId: string, state: string): JsonRpcError {
  return {
    code: A2A_ERROR_CODES.invalidRequest,
    message: `Task ${taskId} cannot take a message in state '${state}'`,
    data: { taskId, state },
  };
}

export function pushNotificationsNotSupported(): JsonRpcError {
  return {
    code: A2A_ERROR_CODES.pushNotificationNotSupported,
    message: 'Push Notification is not supported',
  };
}

export function pushNotificationConfigNotFound(taskId: string, configId: string): JsonRpcError {
  return {
    code: A2A_ERROR_CODES.invalidParams,
    message: `Push notification config ${configId} not found for task ${taskId}`,
    data: { taskId, pushNotificationConfigId: configId },
  };
}

export function unsupportedOperation(method: string): JsonRpcError {
  return {
    code: A2A_ERROR_CODES.unsupportedOperation,
    message: `Unsupported operation: ${method}`,
    data: { method },
  };
}

export function contentTypeNotSupported(contentType: string): JsonRpcError {
  return {
    code: A2A_ERROR_CODES.contentTypeNotSupported,
    message: `Content type not supported: ${contentType}`,
    data: { contentType },
  };
}

export function invalidAgentResponse(detail: string): JsonRpcError {
  return {
    code: A2A_ERROR_CODES.invalidAgentResponse,
    message: `Invalid agent response: ${detail}`,
  };
}

export function authenticatedExtendedCardNotConfigured(): JsonRpcError {
  return {
    code: A2A_ERROR_CODES.authenticatedExtendedCardNotConfigured,
    message: 'Authenticated Extended Card not configured',
  };
}

/** An agent name the server does not host. */
export function agentNotFound(agentName: string): JsonRpcError {
  return {
    code: A2A_ERROR_CODES.invalidParams,
    message: `Agent not found: ${agentName}`,
    data: { agentName },
  };
}

export function unauthorized(detail?: string): JsonRpcError {
  return {
    code: A2A_ERROR_CODES.unauthorized,
    message: detail ? `Unauthorized: ${detail}` : 'Unauthorized',
  };
}

export function parseError(detail?: string): JsonRpcError {
  return {
    code: A2A_ERROR_CODES.parseError,
    message: detail ? `Parse error: ${detail}` : 'Parse error',
  };
}

export function invalidRequest(detail?: string): JsonRpcError {
  return {
    code: A2A_ERROR_CODES.invalidRequest,
    message: detail ? `Invalid request: ${detail}` : 'Invalid request',
  };
}

export function methodNotFound(method: string): JsonRpcError {
  return {
    code: A2A_ERROR_CODES.methodNotFound,
    message: `Method not found: ${method}`,
    data: { method },
  };
}

export function invalidParams(detail: string): JsonRpcError {
  return { code: A2A_ERROR_CODES.invalidParams, message: `Invalid params: ${detail}` };
}

export function internalError(detail?: string): JsonRpcError {
  return {
    code: A2A_ERROR_CODES.internalError,
    message: detail ? `Internal error: ${detail}` : 'Internal error',
  };
}

export class A2AError extends Error {
  constructor(public readonly jsonRpcError: JsonRpcError) {
    super(jsonRpcError.message);
    this.name = 'A2AError';
  }

  get code(): number {
    return this.jsonRpcError.code;
  }
}

function logInternalError(error: unknown, context: string): void {
  console.error('[a2a] %s:', context, error);
}

/**
 * The message a client may see for an error: the message of an `A2AError`,
 * a `JsonRpcParseError` or a `CogitatorError`. Anything else is a failure of
 * the server: it is logged with `context` and reported as `Internal error`.
 */
export function clientErrorMessage(error: unknown, context: string): string {
  if (
    error instanceof A2AError ||
    error instanceof JsonRpcParseError ||
    CogitatorError.isCogitatorError(error)
  ) {
    return error.message;
  }
  logInternalError(error, context);
  return internalError().message;
}

/**
 * The JSON-RPC error a client may see for an error: an `A2AError` as it is, a
 * `CogitatorError` as an internal error with its message, and anything else,
 * logged with `context`, as a bare `Internal error`.
 */
export function clientJsonRpcError(error: unknown, context: string): JsonRpcError {
  if (error instanceof A2AError) return error.jsonRpcError;
  if (error instanceof JsonRpcParseError) {
    return error.code === A2A_ERROR_CODES.invalidRequest
      ? invalidRequest(error.message)
      : parseError(error.message);
  }
  if (CogitatorError.isCogitatorError(error)) return internalError(error.message);
  logInternalError(error, context);
  return internalError();
}
