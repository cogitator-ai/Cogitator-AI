import { describe, it, expect, vi, beforeEach } from 'vitest';
import { A2AServer } from '../server';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import type { A2AMessage, A2AStreamEvent } from '../types';
import type { CogitatorLike, AgentRunResult } from '../task-manager';

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

function userMessage(text: string): A2AMessage {
  return { role: 'user', parts: [{ type: 'text', text }] };
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
      const response = await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'message/send',
        params: { message: userMessage('Hello') },
        id: 1,
      });
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
      const response = await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'message/send',
        params: {},
        id: 1,
      });
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
      const response = await s.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'message/send',
        params: { message: userMessage('Crash') },
        id: 1,
      });
      const task = response.result as Record<string, unknown>;
      expect((task.status as Record<string, unknown>).state).toBe('failed');
    });
  });

  describe('handleJsonRpc — tasks/get', () => {
    it('should get a previously created task', async () => {
      const sendResponse = await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'message/send',
        params: { message: userMessage('Hello') },
        id: 1,
      });
      const taskId = (sendResponse.result as Record<string, unknown>).id;

      const getResponse = await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'tasks/get',
        params: { id: taskId },
        id: 2,
      });
      expect(getResponse.error).toBeUndefined();
      expect((getResponse.result as Record<string, unknown>).id).toBe(taskId);
    });

    it('should return error for unknown task', async () => {
      const response = await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'tasks/get',
        params: { id: 'nonexistent' },
        id: 1,
      });
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32001);
    });
  });

  describe('handleJsonRpc — tasks/cancel', () => {
    it('should return error for unknown task', async () => {
      const response = await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'tasks/cancel',
        params: { id: 'nonexistent' },
        id: 1,
      });
      expect(response.error).toBeDefined();
    });
  });

  describe('handleJsonRpc — errors', () => {
    it('should return methodNotFound for unknown method', async () => {
      const response = await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'unknown/method',
        params: {},
        id: 1,
      });
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32601);
    });

    it('should return parseError for invalid JSON-RPC', async () => {
      const response = await server.handleJsonRpc('not an object');
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32700);
    });

    it('should return parseError for null body', async () => {
      const response = await server.handleJsonRpc(null);
      expect(response.error).toBeDefined();
    });
  });

  describe('handleJsonRpcStream', () => {
    it('should yield status events for streaming', async () => {
      const events: A2AStreamEvent[] = [];
      const stream = server.handleJsonRpcStream({
        jsonrpc: '2.0',
        method: 'message/stream',
        params: { message: userMessage('Stream me') },
        id: 1,
      });

      for await (const event of stream) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
      const statusEvents = events.filter((e) => e.type === 'status-update');
      expect(statusEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('should complete with terminal state', async () => {
      const events: A2AStreamEvent[] = [];
      for await (const event of server.handleJsonRpcStream({
        jsonrpc: '2.0',
        method: 'message/stream',
        params: { message: userMessage('Quick task') },
        id: 1,
      })) {
        events.push(event);
      }

      const lastStatus = [...events].reverse().find((e) => e.type === 'status-update');
      expect(lastStatus).toBeDefined();
      if (lastStatus && lastStatus.type === 'status-update') {
        expect(['completed', 'failed']).toContain(lastStatus.status.state);
      }
    });

    it('should yield failed event for non-stream methods', async () => {
      const events: A2AStreamEvent[] = [];
      for await (const event of server.handleJsonRpcStream({
        jsonrpc: '2.0',
        method: 'message/send',
        params: { message: userMessage('Not streaming') },
        id: 1,
      })) {
        events.push(event);
      }
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('status-update');
      if (events[0].type === 'status-update') {
        expect(events[0].status.state).toBe('failed');
      }
    });

    it('should yield failed event for malformed JSON-RPC request', async () => {
      const events: A2AStreamEvent[] = [];
      for await (const event of server.handleJsonRpcStream('not valid json-rpc')) {
        events.push(event);
      }
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('status-update');
      if (events[0].type === 'status-update') {
        expect(events[0].status.state).toBe('failed');
      }
    });

    it('should yield failed event for missing message params', async () => {
      const events: A2AStreamEvent[] = [];
      for await (const event of server.handleJsonRpcStream({
        jsonrpc: '2.0',
        method: 'message/stream',
        params: {},
        id: 1,
      })) {
        events.push(event);
      }
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('status-update');
      if (events[0].type === 'status-update') {
        expect(events[0].status.state).toBe('failed');
        expect(events[0].status.message).toContain('message');
      }
    });

    it('should yield failed event for batch requests', async () => {
      const events: A2AStreamEvent[] = [];
      for await (const event of server.handleJsonRpcStream([
        { jsonrpc: '2.0', method: 'message/stream', params: { message: userMessage('a') }, id: 1 },
        { jsonrpc: '2.0', method: 'message/stream', params: { message: userMessage('b') }, id: 2 },
      ])) {
        events.push(event);
      }
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('status-update');
      if (events[0].type === 'status-update') {
        expect(events[0].status.state).toBe('failed');
        expect(events[0].status.message).toContain('Batch');
      }
    });
  });

  describe('handleJsonRpc — batch rejection', () => {
    it('should reject batch requests with error', async () => {
      const response = await server.handleJsonRpc([
        { jsonrpc: '2.0', method: 'message/send', params: { message: userMessage('a') }, id: 1 },
        { jsonrpc: '2.0', method: 'message/send', params: { message: userMessage('b') }, id: 2 },
      ]);
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32600);
      expect(response.error!.message).toContain('Batch');
    });
  });
});
