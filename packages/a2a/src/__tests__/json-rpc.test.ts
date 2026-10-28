import { describe, it, expect } from 'vitest';
import * as serverShared from '@cogitator-ai/server-shared';
import {
  isValidRequest,
  parseJsonRpcRequest,
  createSuccessResponse,
  createErrorResponse,
  JsonRpcParseError,
} from '../index';

describe('JSON-RPC re-export', () => {
  it('re-exports the JSON-RPC helpers of server-shared', () => {
    expect(isValidRequest).toBe(serverShared.isValidRequest);
    expect(parseJsonRpcRequest).toBe(serverShared.parseJsonRpcRequest);
    expect(createSuccessResponse).toBe(serverShared.createSuccessResponse);
    expect(createErrorResponse).toBe(serverShared.createErrorResponse);
    expect(JsonRpcParseError).toBe(serverShared.JsonRpcParseError);
  });

  it('still parses and answers A2A requests', () => {
    expect(parseJsonRpcRequest({ jsonrpc: '2.0', method: 'message/send', id: 1 })).toEqual({
      jsonrpc: '2.0',
      method: 'message/send',
      id: 1,
    });
    expect(createErrorResponse(1, { code: -32001, message: 'Task not found' })).toEqual({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Task not found' },
      id: 1,
    });
  });
});
