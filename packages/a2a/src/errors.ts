import { CogitatorError } from '@cogitator-ai/types';
import type { JsonRpcError } from './json-rpc.js';
import { JsonRpcParseError } from './json-rpc.js';

/**
 * JSON-RPC error codes of A2A (v0.3 section 8, v1.0 section 5.4), plus the server error this
 * package adds.
 */
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
  /** A2A 1.0: the agent requires an extension the client did not ask for */
  extensionSupportRequired: -32008,
  /** A2A 1.0: the server does not speak the protocol version the client asked for */
  versionNotSupported: -32009,
  /** Cogitator: the request carries no valid credentials (answered with HTTP 401) */
  unauthorized: -32000,
} as const;

/** A field of a request that failed validation, as `google.rpc.BadRequest` reports it. */
export interface FieldViolation {
  /** The path of the field, e.g. `message.parts[0].text` */
  field: string;
  description: string;
}

/**
 * The A2A 1.0 code of errors whose meaning got its own code in 1.0, kept apart so the 0.3 error
 * stays exactly what it was.
 */
const V1_CODES = new WeakMap<JsonRpcError, number>();

function withV1Code(error: JsonRpcError, code: number): JsonRpcError {
  V1_CODES.set(error, code);
  return error;
}

/** The code an error carries in A2A 1.0. */
export function v1ErrorCode(error: JsonRpcError): number {
  return V1_CODES.get(error) ?? error.code;
}

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
  return withV1Code(
    {
      code: A2A_ERROR_CODES.invalidRequest,
      message: `Task ${taskId} cannot take a message in state '${state}'`,
      data: { taskId, state },
    },
    A2A_ERROR_CODES.unsupportedOperation
  );
}

export function pushNotificationsNotSupported(): JsonRpcError {
  return {
    code: A2A_ERROR_CODES.pushNotificationNotSupported,
    message: 'Push Notification is not supported',
  };
}

/** A push notification config the task does not have: `TaskNotFoundError` in A2A 1.0. */
export function pushNotificationConfigNotFound(taskId: string, configId: string): JsonRpcError {
  return withV1Code(
    {
      code: A2A_ERROR_CODES.invalidParams,
      message: `Push notification config ${configId} not found for task ${taskId}`,
      data: { taskId, pushNotificationConfigId: configId },
    },
    A2A_ERROR_CODES.taskNotFound
  );
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

/** The client did not ask for extensions the agent requires (A2A 1.0, section 3.3.4). */
export function extensionSupportRequired(uris: readonly string[]): JsonRpcError {
  return {
    code: A2A_ERROR_CODES.extensionSupportRequired,
    message: `Extension support required: ${uris.join(', ')}`,
    data: { extensions: [...uris] },
  };
}

/** The server does not speak the protocol version the client asked for (A2A 1.0, section 3.6.2). */
export function versionNotSupported(requested: string, supported: readonly string[]): JsonRpcError {
  return {
    code: A2A_ERROR_CODES.versionNotSupported,
    message: `A2A protocol version ${requested} is not supported, supported versions: ${supported.join(', ')}`,
    data: { requestedVersion: requested, supportedVersions: [...supported] },
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

export interface A2AErrorOptions {
  /** The request fields that failed validation, reported in A2A 1.0 as `google.rpc.BadRequest` */
  fieldViolations?: readonly FieldViolation[];
}

export class A2AError extends Error {
  /** The request fields that failed validation, when the error is about invalid params */
  readonly fieldViolations?: readonly FieldViolation[];

  constructor(
    public readonly jsonRpcError: JsonRpcError,
    options?: A2AErrorOptions
  ) {
    super(jsonRpcError.message);
    this.name = 'A2AError';
    if (options?.fieldViolations?.length) this.fieldViolations = options.fieldViolations;
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
