import { describe, it, expect } from 'vitest';
import {
  isValidRequest,
  parseJsonRpcRequest,
  createSuccessResponse,
  createErrorResponse,
  JsonRpcParseError,
} from '../json-rpc';
import type { JsonRpcRequest, JsonRpcResponse, JsonRpcError } from '../json-rpc';

describe('JSON-RPC 2.0', () => {
  describe('isValidRequest', () => {
    it('should validate a correct request', () => {
      expect(
        isValidRequest({
          jsonrpc: '2.0',
          method: 'test',
          id: 1,
        })
      ).toBe(true);
    });

    it('should validate request with params', () => {
      expect(
        isValidRequest({
          jsonrpc: '2.0',
          method: 'test',
          params: { foo: 'bar' },
          id: 'abc',
        })
      ).toBe(true);
    });

    it('should reject missing jsonrpc field', () => {
      expect(isValidRequest({ method: 'test', id: 1 })).toBe(false);
    });

    it('should reject wrong jsonrpc version', () => {
      expect(isValidRequest({ jsonrpc: '1.0', method: 'test', id: 1 })).toBe(false);
    });

    it('should reject missing method', () => {
      expect(isValidRequest({ jsonrpc: '2.0', id: 1 })).toBe(false);
    });

    it('should reject non-string method', () => {
      expect(isValidRequest({ jsonrpc: '2.0', method: 123, id: 1 })).toBe(false);
    });

    it('should reject missing id', () => {
      expect(isValidRequest({ jsonrpc: '2.0', method: 'test' })).toBe(false);
    });

    it('should reject null', () => {
      expect(isValidRequest(null)).toBe(false);
    });

    it('should reject non-object', () => {
      expect(isValidRequest('string')).toBe(false);
      expect(isValidRequest(42)).toBe(false);
    });
  });

  describe('parseJsonRpcRequest', () => {
    it('should parse a valid single request', () => {
      const result = parseJsonRpcRequest({
        jsonrpc: '2.0',
        method: 'message/send',
        params: { message: 'hello' },
        id: 1,
      });
      expect(result).not.toBeInstanceOf(Array);
      expect((result as JsonRpcRequest).method).toBe('message/send');
    });

    it('should parse a batch of requests', () => {
      const result = parseJsonRpcRequest([
        { jsonrpc: '2.0', method: 'method1', id: 1 },
        { jsonrpc: '2.0', method: 'method2', id: 2 },
      ]);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
    });

    it('should throw on invalid input', () => {
      expect(() => parseJsonRpcRequest(null)).toThrow(JsonRpcParseError);
      expect(() => parseJsonRpcRequest('not json')).toThrow(JsonRpcParseError);
    });

    it('should throw on invalid request structure', () => {
      expect(() => parseJsonRpcRequest({ foo: 'bar' })).toThrow(JsonRpcParseError);
    });

    it('should throw on empty batch', () => {
      expect(() => parseJsonRpcRequest([])).toThrow(JsonRpcParseError);
    });

    it('should throw if batch contains invalid requests', () => {
      expect(() =>
        parseJsonRpcRequest([{ jsonrpc: '2.0', method: 'ok', id: 1 }, { invalid: true }])
      ).toThrow(JsonRpcParseError);
    });
  });

  describe('createSuccessResponse', () => {
    it('should create a valid success response', () => {
      const response = createSuccessResponse(1, { data: 'test' });
      expect(response).toEqual({
        jsonrpc: '2.0',
        result: { data: 'test' },
        id: 1,
      });
    });

    it('should handle string id', () => {
      const response = createSuccessResponse('abc', 'result');
      expect(response.id).toBe('abc');
    });

    it('should handle null result', () => {
      const response = createSuccessResponse(1, null);
      expect(response.result).toBeNull();
    });
  });

  describe('createErrorResponse', () => {
    it('should create a valid error response', () => {
      const error: JsonRpcError = { code: -32600, message: 'Invalid request' };
      const response = createErrorResponse(1, error);
      expect(response).toEqual({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid request' },
        id: 1,
      });
    });

    it('should handle null id for parse errors', () => {
      const response = createErrorResponse(null, { code: -32700, message: 'Parse error' });
      expect(response.id).toBeNull();
    });

    it('should include error data when provided', () => {
      const response = createErrorResponse(1, {
        code: -32001,
        message: 'Task not found',
        data: { taskId: 'task_123' },
      });
      expect(response.error?.data).toEqual({ taskId: 'task_123' });
    });
  });
});
