import { describe, it, expect, vi } from 'vitest';
import { A2AServer } from '../server';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import type { A2AMessage, A2AStreamEvent, TokenStreamEvent } from '../types';
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

function createMockRunResult(output: string): AgentRunResult {
  return {
    output,
    runId: 'run_1',
    agentId: 'agent_1',
    threadId: 'thread_1',
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, cost: 0.001, duration: 100 },
    toolCalls: [],
  };
}

function createStreamingCogitator(tokens: string[], finalOutput: string): CogitatorLike {
  return {
    run: vi.fn().mockImplementation(async (_agent, options) => {
      if (options.onToken) {
        for (const token of tokens) {
          options.onToken(token);
        }
      }
      return createMockRunResult(finalOutput);
    }),
  };
}

function userMessage(text: string): A2AMessage {
  return { role: 'user', parts: [{ type: 'text', text }] };
}

describe('Token-level Streaming', () => {
  let server: A2AServer;

  describe('handleJsonRpcStream with token events', () => {
    it('should yield token events from onToken callback', async () => {
      const tokens = ['Hello', ' ', 'world', '!'];
      const cogitator = createStreamingCogitator(tokens, 'Hello world!');
      server = new A2AServer({
        agents: { streamer: createMockAgent('streamer') },
        cogitator,
      });

      const events: A2AStreamEvent[] = [];
      for await (const event of server.handleJsonRpcStream({
        jsonrpc: '2.0',
        method: 'message/stream',
        params: { message: userMessage('Stream tokens') },
        id: 1,
      })) {
        events.push(event);
      }

      const tokenEvents = events.filter((e): e is TokenStreamEvent => e.type === 'token');
      expect(tokenEvents).toHaveLength(4);
      expect(tokenEvents.map((e) => e.token)).toEqual(['Hello', ' ', 'world', '!']);
    });

    it('should include correct taskId on token events', async () => {
      const cogitator = createStreamingCogitator(['tok'], 'tok');
      server = new A2AServer({
        agents: { streamer: createMockAgent('streamer') },
        cogitator,
      });

      const events: A2AStreamEvent[] = [];
      for await (const event of server.handleJsonRpcStream({
        jsonrpc: '2.0',
        method: 'message/stream',
        params: { message: userMessage('Get taskId') },
        id: 1,
      })) {
        events.push(event);
      }

      const initialStatus = events.find((e) => e.type === 'status-update');
      const tokenEvent = events.find((e): e is TokenStreamEvent => e.type === 'token');
      expect(tokenEvent).toBeDefined();
      expect(tokenEvent!.taskId).toBe(initialStatus!.taskId);
    });

    it('should have timestamps on token events', async () => {
      const cogitator = createStreamingCogitator(['a', 'b'], 'ab');
      server = new A2AServer({
        agents: { streamer: createMockAgent('streamer') },
        cogitator,
      });

      const events: A2AStreamEvent[] = [];
      for await (const event of server.handleJsonRpcStream({
        jsonrpc: '2.0',
        method: 'message/stream',
        params: { message: userMessage('Timestamps') },
        id: 1,
      })) {
        events.push(event);
      }

      const tokenEvents = events.filter((e): e is TokenStreamEvent => e.type === 'token');
      for (const te of tokenEvents) {
        expect(te.timestamp).toBeDefined();
        expect(new Date(te.timestamp).getTime()).not.toBeNaN();
      }
    });

    it('should yield token events before completion event', async () => {
      const tokens = ['first', 'second', 'third'];
      const cogitator = createStreamingCogitator(tokens, 'first second third');
      server = new A2AServer({
        agents: { streamer: createMockAgent('streamer') },
        cogitator,
      });

      const events: A2AStreamEvent[] = [];
      for await (const event of server.handleJsonRpcStream({
        jsonrpc: '2.0',
        method: 'message/stream',
        params: { message: userMessage('Order check') },
        id: 1,
      })) {
        events.push(event);
      }

      const lastStatusIdx = events.findLastIndex(
        (e) => e.type === 'status-update' && e.status.state === 'completed'
      );
      const firstTokenIdx = events.findIndex((e) => e.type === 'token');

      expect(firstTokenIdx).toBeGreaterThan(-1);
      expect(lastStatusIdx).toBeGreaterThan(-1);
      expect(firstTokenIdx).toBeLessThan(lastStatusIdx);
    });

    it('should call cogitator.run with stream=true and onToken', async () => {
      const cogitator = createStreamingCogitator(['x'], 'x');
      server = new A2AServer({
        agents: { streamer: createMockAgent('streamer') },
        cogitator,
      });

      const events: A2AStreamEvent[] = [];
      for await (const event of server.handleJsonRpcStream({
        jsonrpc: '2.0',
        method: 'message/stream',
        params: { message: userMessage('Check run args') },
        id: 1,
      })) {
        events.push(event);
      }

      expect(cogitator.run).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          stream: true,
          onToken: expect.any(Function),
        })
      );
    });

    it('should still yield status and artifact events alongside tokens', async () => {
      const tokens = ['Hello', ' world'];
      const cogitator = createStreamingCogitator(tokens, 'Hello world');
      server = new A2AServer({
        agents: { streamer: createMockAgent('streamer') },
        cogitator,
      });

      const events: A2AStreamEvent[] = [];
      for await (const event of server.handleJsonRpcStream({
        jsonrpc: '2.0',
        method: 'message/stream',
        params: { message: userMessage('Mixed events') },
        id: 1,
      })) {
        events.push(event);
      }

      const types = new Set(events.map((e) => e.type));
      expect(types.has('token')).toBe(true);
      expect(types.has('status-update')).toBe(true);
    });

    it('should handle zero tokens gracefully', async () => {
      const cogitator = createStreamingCogitator([], 'no tokens');
      server = new A2AServer({
        agents: { streamer: createMockAgent('streamer') },
        cogitator,
      });

      const events: A2AStreamEvent[] = [];
      for await (const event of server.handleJsonRpcStream({
        jsonrpc: '2.0',
        method: 'message/stream',
        params: { message: userMessage('No tokens') },
        id: 1,
      })) {
        events.push(event);
      }

      const tokenEvents = events.filter((e) => e.type === 'token');
      expect(tokenEvents).toHaveLength(0);

      const lastStatus = [...events].reverse().find((e) => e.type === 'status-update');
      expect(lastStatus).toBeDefined();
      if (lastStatus?.type === 'status-update') {
        expect(lastStatus.status.state).toBe('completed');
      }
    });
  });
});
