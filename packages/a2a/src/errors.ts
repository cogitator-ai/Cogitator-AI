import type { JsonRpcError } from './json-rpc.js';

export function taskNotFound(taskId: string): JsonRpcError {
  return { code: -32001, message: `Task not found: ${taskId}`, data: { taskId } };
}

export function taskNotCancelable(taskId: string): JsonRpcError {
  return { code: -32002, message: `Task is not cancelable: ${taskId}`, data: { taskId } };
}

export function taskNotContinuable(taskId: string, state: string): JsonRpcError {
  return {
    code: -32008,
    message: `Task cannot be continued in state '${state}': ${taskId}`,
    data: { taskId, state },
  };
}

export function pushNotificationsNotSupported(): JsonRpcError {
  return { code: -32003, message: 'Push notifications are not supported' };
}

export function pushNotificationsNotConfigured(taskId: string): JsonRpcError {
  return {
    code: -32009,
    message: `Push notifications not configured for task: ${taskId}`,
    data: { taskId },
  };
}

export function unsupportedOperation(method: string): JsonRpcError {
  return { code: -32004, message: `Unsupported operation: ${method}`, data: { method } };
}

export function contentTypeNotSupported(contentType: string): JsonRpcError {
  return {
    code: -32005,
    message: `Content type not supported: ${contentType}`,
    data: { contentType },
  };
}

export function invalidAgentResponse(detail: string): JsonRpcError {
  return { code: -32006, message: `Invalid agent response: ${detail}` };
}

export function agentNotFound(agentName: string): JsonRpcError {
  return { code: -32007, message: `Agent not found: ${agentName}`, data: { agentName } };
}

export function parseError(detail?: string): JsonRpcError {
  return { code: -32700, message: detail ? `Parse error: ${detail}` : 'Parse error' };
}

export function invalidRequest(detail?: string): JsonRpcError {
  return { code: -32600, message: detail ? `Invalid request: ${detail}` : 'Invalid request' };
}

export function methodNotFound(method: string): JsonRpcError {
  return { code: -32601, message: `Method not found: ${method}`, data: { method } };
}

export function invalidParams(detail: string): JsonRpcError {
  return { code: -32602, message: `Invalid params: ${detail}` };
}

export function internalError(detail?: string): JsonRpcError {
  return { code: -32603, message: detail ? `Internal error: ${detail}` : 'Internal error' };
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
