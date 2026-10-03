import type { JsonRpcResponse } from '../json-rpc';

export function expectResponse(response: JsonRpcResponse | null): JsonRpcResponse {
  if (response === null) {
    throw new Error('Expected a JSON-RPC response, got null');
  }
  return response;
}
