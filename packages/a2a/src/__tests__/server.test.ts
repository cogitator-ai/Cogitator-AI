import { describe, it, expect, vi, beforeEach } from 'vitest';
import { A2AServer } from '../server';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import type { CogitatorLike, AgentRunResult } from '../types';
import { collect, collectEvents, expectResponse, userMessage } from './helpers';

function createMockAgent(name: string): Agent {
  const config: AgentConfig = {
    name,
    model: 'test-model',
    instructions: 'test',
    description: `${name} agent`,
  };
  return {
    id: `agent_${name}`,
    name,
    config,
    model: config.model,
    instructions: config.instructions,
    tools: [],
    clone: vi.fn() as Agent['clone'],
    serialize: vi.fn() as Agent['serialize'],
  };
}

function createMockCogitator(output: string = 'test output', structured?: unknown): CogitatorLike {
  const result: AgentRunResult = {
    output,
    structured,
    runId: 'run_1',
    agentId: 'agent_1',
    threadId: 'thread_1',
    usage: {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      cost: 0.001,
      duration: 100,
    },
    toolCalls: [],
  };
  return { run: vi.fn().mockResolvedValue(result) };
}

describe('A2AServer', () => {
  let server: A2AServer;
  let cogitator: CogitatorLike;

  beforeEach(() => {
    cogitator = createMockCogitator('Hello from agent');
    server = new A2AServer({
      agents: { researcher: createMockAgent('researcher') },
      cogitator,
    });
  });

  describe('constructor', () => {
    it('should throw if no agents provided', () => {
      expect(() => new A2AServer({ agents: {}, cogitator })).toThrow('at least one agent');
    });

    it('should accept multiple agents', () => {
      const s = new A2AServer({
        agents: {
          researcher: createMockAgent('researcher'),
          writer: createMockAgent('writer'),
        },
        cogitator,
      });
      expect(s.getAgentCards()).toHaveLength(2);
    });
  });

  describe('getAgentCard', () => {
    it('should return card for named agent', () => {
      const card = server.getAgentCard('researcher');
      expect(card.name).toBe('researcher');
    });

    it('should return default card when no name provided', () => {
      const card = server.getAgentCard();
      expect(card.name).toBe('researcher');
    });

    it('should throw for unknown agent', () => {
      expect(() => server.getAgentCard('unknown')).toThrow();
    });
  });

  describe('getAgentCards', () => {
    it('should return all cards', () => {
      const cards = server.getAgentCards();
      expect(cards).toHaveLength(1);
      expect(cards[0].name).toBe('researcher');
    });
  });

  describe('handleJsonRpc — message/send', () => {
    it('should handle message/send and return completed task', async () => {
      const response = expectResponse(
        await server.handleJsonRpc({
          jsonrpc: '2.0',
          method: 'message/send',
          params: { message: userMessage('Hello') },
          id: 1,
        })
      );
      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();
      const task = response.result as Record<string, unknown>;
      expect((task.status as Record<string, unknown>).state).toBe('completed');
      expect(task.id).toMatch(/^task_/);
    });

    it('should call cogitator.run with agent and input', async () => {
      await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'message/send',
        params: { message: userMessage('Research quantum computing') },
        id: 1,
      });
      expect(cogitator.run).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ input: 'Research quantum computing' })
      );
    });

    it('should handle missing message in params', async () => {
      const response = expectResponse(
        await server.handleJsonRpc({
          jsonrpc: '2.0',
          method: 'message/send',
          params: {},
          id: 1,
        })
      );
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32602);
    });

    it('should handle agent run failure', async () => {
      const failingCogitator: CogitatorLike = {
        run: vi.fn().mockRejectedValue(new Error('LLM crashed')),
      };
      const s = new A2AServer({
        agents: { test: createMockAgent('test') },
        cogitator: failingCogitator,
      });
      const response = expectResponse(
        await s.handleJsonRpc({
          jsonrpc: '2.0',
          method: 'message/send',
          params: { message: userMessage('Crash') },
          id: 1,
        })
      );
      const task = response.result as Record<string, unknown>;
      expect((task.status as Record<string, unknown>).state).toBe('failed');
    });
  });

  describe('handleJsonRpc — tasks/get', () => {
    it('should get a previously created task', async () => {
      const sendResponse = expectResponse(
        await server.handleJsonRpc({
          jsonrpc: '2.0',
          method: 'message/send',
          params: { message: userMessage('Hello') },
          id: 1,
        })
      );
      const taskId = (sendResponse.result as Record<string, unknown>).id;

      const getResponse = expectResponse(
        await server.handleJsonRpc({
          jsonrpc: '2.0',
          method: 'tasks/get',
          params: { id: taskId },
          id: 2,
        })
      );
      expect(getResponse.error).toBeUndefined();
      expect((getResponse.result as Record<string, unknown>).id).toBe(taskId);
    });

    it('should return error for unknown task', async () => {
      const response = expectResponse(
        await server.handleJsonRpc({
          jsonrpc: '2.0',
          method: 'tasks/get',
          params: { id: 'nonexistent' },
          id: 1,
        })
      );
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32001);
    });
  });

  describe('handleJsonRpc — tasks/cancel', () => {
    it('should return error for unknown task', async () => {
      const response = expectResponse(
        await server.handleJsonRpc({
          jsonrpc: '2.0',
          method: 'tasks/cancel',
          params: { id: 'nonexistent' },
          id: 1,
        })
      );
      expect(response.error).toBeDefined();
    });
  });

  describe('handleJsonRpc — errors', () => {
    it('should return methodNotFound for unknown method', async () => {
      const response = expectResponse(
        await server.handleJsonRpc({
          jsonrpc: '2.0',
          method: 'unknown/method',
          params: {},
          id: 1,
        })
      );
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32601);
    });

    it('should return invalidRequest for a body that is not a JSON-RPC object', async () => {
      const response = expectResponse(await server.handleJsonRpc('not an object'));
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32600);
    });

    it('should return invalidRequest for a malformed request object', async () => {
      const response = expectResponse(await server.handleJsonRpc({ jsonrpc: '1.0', method: 5 }));
      expect(response.error!.code).toBe(-32600);
    });

    it('should return parseError for null body', async () => {
      const response = expectResponse(await server.handleJsonRpc(null));
      expect(response.error).toBeDefined();
    });
  });

  describe('handleJsonRpcStream', () => {
    it('should yield the task, then status updates, each as a JSON-RPC response with the request id', async () => {
      const responses = await collect(
        server.handleJsonRpcStream({
          jsonrpc: '2.0',
          method: 'message/stream',
          params: { message: userMessage('Stream me') },
          id: 1,
        })
      );

      expect(responses.length).toBeGreaterThan(1);
      expect(responses.every((r) => r.jsonrpc === '2.0' && r.id === 1)).toBe(true);
      const events = responses.map((r) => r.result as { kind: string });
      expect(events[0].kind).toBe('task');
      expect(events.filter((e) => e.kind === 'status-update').length).toBeGreaterThanOrEqual(1);
    });

    it('should complete with a final terminal status update', async () => {
      const events = await collectEvents(
        server.handleJsonRpcStream({
          jsonrpc: '2.0',
          method: 'message/stream',
          params: { message: userMessage('Quick task') },
          id: 1,
        })
      );

      const last = events.at(-1);
      expect(last?.kind).toBe('status-update');
      if (last?.kind === 'status-update') {
        expect(last.final).toBe(true);
        expect(last.status.state).toBe('completed');
      }
    });

    it('should answer a method that does not stream with its single response', async () => {
      const responses = await collect(
        server.handleJsonRpcStream({
          jsonrpc: '2.0',
          method: 'message/send',
          params: { message: userMessage('Not streaming') },
          id: 1,
        })
      );
      expect(responses).toHaveLength(1);
      expect((responses[0].result as { kind: string }).kind).toBe('task');
    });

    it('should yield an error response for a malformed JSON-RPC request', async () => {
      const responses = await collect(server.handleJsonRpcStream('not valid json-rpc'));
      expect(responses).toHaveLength(1);
      expect(responses[0].error?.code).toBe(-32600);
    });

    it('should yield invalid params for a message without role', async () => {
      const responses = await collect(
        server.handleJsonRpcStream({
          jsonrpc: '2.0',
          method: 'message/stream',
          params: { message: { messageId: 'm', parts: [{ kind: 'text', text: 'no role' }] } },
          id: 1,
        })
      );
      expect(responses).toHaveLength(1);
      expect(responses[0].error?.code).toBe(-32602);
      expect(responses[0].error?.message).toContain('message');
    });

    it('should yield an error for an unknown agent name', async () => {
      const responses = await collect(
        server.handleJsonRpcStream({
          jsonrpc: '2.0',
          method: 'message/stream',
          params: { message: userMessage('Hello'), agentName: 'nonexistent' },
          id: 1,
        })
      );
      expect(responses).toHaveLength(1);
      expect(responses[0].error?.message).toContain('Agent not found');
    });

    it('should yield invalid params for missing message params', async () => {
      const responses = await collect(
        server.handleJsonRpcStream({
          jsonrpc: '2.0',
          method: 'message/stream',
          params: {},
          id: 1,
        })
      );
      expect(responses).toHaveLength(1);
      expect(responses[0].error?.code).toBe(-32602);
      expect(responses[0].error?.message).toContain('message');
    });

    it('should yield an error for batch requests', async () => {
      const responses = await collect(
        server.handleJsonRpcStream([
          {
            jsonrpc: '2.0',
            method: 'message/stream',
            params: { message: userMessage('a') },
            id: 1,
          },
          {
            jsonrpc: '2.0',
            method: 'message/stream',
            params: { message: userMessage('b') },
            id: 2,
          },
        ])
      );
      expect(responses).toHaveLength(1);
      expect(responses[0].error?.code).toBe(-32600);
      expect(responses[0].error?.message).toContain('Batch');
    });
  });

  describe('SSRF protection', () => {
    it('should reject private webhook URLs by default', async () => {
      const response = expectResponse(
        await server.handleJsonRpc({
          jsonrpc: '2.0',
          method: 'tasks/pushNotificationConfig/set',
          params: {
            taskId: 'task_1',
            pushNotificationConfig: { url: 'http://localhost:8080/hook' },
          },
          id: 1,
        })
      );
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32602);
      expect(response.error!.message).toContain('private/internal');
    });

    it('should allow private webhook URLs when allowPrivateUrls is true', async () => {
      const permissiveServer = new A2AServer({
        agents: { researcher: createMockAgent('researcher') },
        cogitator,
        allowPrivateUrls: true,
      });
      const sent = await permissiveServer.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'message/send',
        params: { message: userMessage('hi') },
        id: 0,
      });
      const taskId = (sent!.result as { id: string }).id;
      const response = expectResponse(
        await permissiveServer.handleJsonRpc({
          jsonrpc: '2.0',
          method: 'tasks/pushNotificationConfig/set',
          params: { taskId, pushNotificationConfig: { url: 'http://localhost:8080/hook' } },
          id: 1,
        })
      );
      expect(response!.error).toBeUndefined();
    });
  });

  describe('handleJsonRpc — batch rejection', () => {
    it('should reject batch requests with error', async () => {
      const response = expectResponse(
        await server.handleJsonRpc([
          { jsonrpc: '2.0', method: 'message/send', params: { message: userMessage('a') }, id: 1 },
          { jsonrpc: '2.0', method: 'message/send', params: { message: userMessage('b') }, id: 2 },
        ])
      );
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32600);
      expect(response.error!.message).toContain('Batch');
    });
  });
});
