export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
  id?: string | number | null;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  result?: unknown;
  error?: JsonRpcError;
  id: string | number | null;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class JsonRpcParseError extends Error {
  constructor(
    message: string,
    public readonly code: number = -32700
  ) {
    super(message);
    this.name = 'JsonRpcParseError';
  }
}

export function isValidRequest(req: unknown): req is JsonRpcRequest {
  if (req === null || typeof req !== 'object' || Array.isArray(req)) {
    return false;
  }

  const obj = req as Record<string, unknown>;

  if (obj.jsonrpc !== '2.0' || typeof obj.method !== 'string') {
    return false;
  }

  if (obj.id === undefined || obj.id === null) return true;
  return typeof obj.id === 'string' || typeof obj.id === 'number';
}

const INVALID_REQUEST_CODE = -32600;

export function parseJsonRpcRequest(body: unknown): JsonRpcRequest | JsonRpcRequest[] {
  if (body === null || body === undefined || typeof body !== 'object') {
    throw new JsonRpcParseError(
      'Invalid JSON-RPC request: expected object or array',
      INVALID_REQUEST_CODE
    );
  }

  if (Array.isArray(body)) {
    if (body.length === 0) {
      throw new JsonRpcParseError('Invalid JSON-RPC batch: empty array', INVALID_REQUEST_CODE);
    }

    for (const item of body) {
      if (!isValidRequest(item)) {
        throw new JsonRpcParseError('Invalid JSON-RPC request in batch', INVALID_REQUEST_CODE);
      }
    }

    return body as JsonRpcRequest[];
  }

  if (!isValidRequest(body)) {
    throw new JsonRpcParseError('Invalid JSON-RPC request structure', INVALID_REQUEST_CODE);
  }

  return body as JsonRpcRequest;
}

export function createSuccessResponse(
  id: string | number | null,
  result: unknown
): JsonRpcResponse {
  return { jsonrpc: '2.0', result, id };
}

export function createErrorResponse(
  id: string | number | null,
  error: JsonRpcError
): JsonRpcResponse {
  return { jsonrpc: '2.0', error, id };
}
