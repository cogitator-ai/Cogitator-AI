import { describe, it, expect } from 'vitest';
import {
  taskNotFound,
  taskNotCancelable,
  pushNotificationsNotSupported,
  unsupportedOperation,
  contentTypeNotSupported,
  invalidAgentResponse,
  agentNotFound,
  parseError,
  invalidRequest,
  methodNotFound,
  invalidParams,
  internalError,
  A2AError,
} from '../errors';

describe('A2A errors', () => {
  describe('A2A-specific errors', () => {
    it('taskNotFound returns correct error', () => {
      const err = taskNotFound('task_123');
      expect(err.code).toBe(-32001);
      expect(err.message).toContain('task_123');
      expect(err.data).toEqual({ taskId: 'task_123' });
    });

    it('taskNotCancelable returns correct error', () => {
      const err = taskNotCancelable('task_456');
      expect(err.code).toBe(-32002);
      expect(err.message).toContain('task_456');
    });

    it('pushNotificationsNotSupported returns correct error', () => {
      const err = pushNotificationsNotSupported();
      expect(err.code).toBe(-32003);
    });

    it('unsupportedOperation returns correct error', () => {
      const err = unsupportedOperation('tasks/list');
      expect(err.code).toBe(-32004);
      expect(err.data).toEqual({ method: 'tasks/list' });
    });

    it('contentTypeNotSupported returns correct error', () => {
      const err = contentTypeNotSupported('image/raw');
      expect(err.code).toBe(-32005);
    });

    it('invalidAgentResponse returns correct error', () => {
      const err = invalidAgentResponse('missing output');
      expect(err.code).toBe(-32006);
    });

    it('agentNotFound returns correct error', () => {
      const err = agentNotFound('unknown-agent');
      expect(err.code).toBe(-32007);
      expect(err.data).toEqual({ agentName: 'unknown-agent' });
    });
  });

  describe('standard JSON-RPC errors', () => {
    it('parseError returns -32700', () => {
      expect(parseError().code).toBe(-32700);
      expect(parseError('bad json').message).toContain('bad json');
    });

    it('invalidRequest returns -32600', () => {
      expect(invalidRequest().code).toBe(-32600);
    });

    it('methodNotFound returns -32601', () => {
      const err = methodNotFound('unknown/method');
      expect(err.code).toBe(-32601);
      expect(err.data).toEqual({ method: 'unknown/method' });
    });

    it('invalidParams returns -32602', () => {
      expect(invalidParams('missing field').code).toBe(-32602);
    });

    it('internalError returns -32603', () => {
      expect(internalError().code).toBe(-32603);
      expect(internalError('crash').message).toContain('crash');
    });
  });

  describe('A2AError class', () => {
    it('wraps a JsonRpcError', () => {
      const err = new A2AError(taskNotFound('task_1'));
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('A2AError');
      expect(err.code).toBe(-32001);
      expect(err.message).toContain('task_1');
      expect(err.jsonRpcError.data).toEqual({ taskId: 'task_1' });
    });

    it('can be thrown and caught', () => {
      expect(() => {
        throw new A2AError(methodNotFound('bad'));
      }).toThrow(A2AError);
    });
  });
});
