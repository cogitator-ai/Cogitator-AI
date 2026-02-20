import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { A2AClient, type A2AStreamEvent, type CogitatorLike } from '@cogitator-ai/a2a';
import type { AgentRunResult } from '@cogitator-ai/a2a';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import { startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';

const TOKENS = ['Hello', ' ', 'world', '!'];

function createMockAgent(name: string): Agent {
  const config: AgentConfig = {
    name,
    model: 'mock',
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
    clone: (() => {}) as Agent['clone'],
    serialize: (() => {}) as Agent['serialize'],
  };
}

function createMockRunResult(output: string): AgentRunResult {
  return {
    output,
    runId: 'run_1',
    agentId: 'agent_1',
    threadId: 'thread_1',
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, cost: 0, duration: 50 },
    toolCalls: [],
  };
}

function createStreamingCogitator(tokens: string[] = TOKENS): CogitatorLike {
  return {
    run: async (_agent, options) => {
      const output = tokens.join('');
      if (options.onToken) {
        for (const token of tokens) {
          options.onToken(token);
          await new Promise((r) => setTimeout(r, 5));
        }
      }
      return createMockRunResult(output);
    },
  };
}

describe('A2A v2: Token Streaming', () => {
  let testServer: TestA2AServer;
  let client: A2AClient;

  beforeAll(async () => {
    testServer = await startTestA2AServer({
      agents: { 'stream-agent': createMockAgent('stream-agent') },
      cogitator: createStreamingCogitator(),
    });
    client = new A2AClient(testServer.url);
  });

  afterAll(async () => {
    await testServer?.close();
  });

  it('token events appear in stream', async () => {
    const events: A2AStreamEvent[] = [];

    for await (const event of client.sendMessageStream({
      role: 'user',
      parts: [{ type: 'text', text: 'Say hello world' }],
    })) {
      events.push(event);
    }

    const tokenEvents = events.filter((e) => e.type === 'token');
    expect(tokenEvents.length).toBe(TOKENS.length);

    const receivedTokens = tokenEvents.map((e) => {
      if (e.type === 'token') return e.token;
      return '';
    });
    expect(receivedTokens).toEqual(TOKENS);
  });

  it('status transitions from working to completed', async () => {
    const events: A2AStreamEvent[] = [];

    for await (const event of client.sendMessageStream({
      role: 'user',
      parts: [{ type: 'text', text: 'Check status transitions' }],
    })) {
      events.push(event);
    }

    const statusEvents = events.filter((e) => e.type === 'status-update');
    expect(statusEvents.length).toBeGreaterThanOrEqual(2);

    const first = statusEvents[0];
    if (first.type === 'status-update') {
      expect(first.status.state).toBe('working');
    }

    const last = statusEvents[statusEvents.length - 1];
    if (last.type === 'status-update') {
      expect(last.status.state).toBe('completed');
    }
  });

  it('completed task has artifacts with final output', async () => {
    let taskId = '';

    for await (const event of client.sendMessageStream({
      role: 'user',
      parts: [{ type: 'text', text: 'Produce artifact' }],
    })) {
      if (event.type === 'status-update') {
        taskId = event.taskId;
      }
    }

    expect(taskId).toBeTruthy();
    const task = await client.getTask(taskId);
    expect(task.status.state).toBe('completed');
    expect(task.artifacts.length).toBeGreaterThanOrEqual(1);

    const textPart = task.artifacts[0].parts.find((p) => p.type === 'text');
    expect(textPart).toBeDefined();
    if (textPart?.type === 'text') {
      expect(textPart.text).toBe(TOKENS.join(''));
    }
  });

  it('stream terminates after completion', async () => {
    const events: A2AStreamEvent[] = [];
    let streamEnded = false;

    for await (const event of client.sendMessageStream({
      role: 'user',
      parts: [{ type: 'text', text: 'Should terminate' }],
    })) {
      events.push(event);
    }
    streamEnded = true;

    expect(streamEnded).toBe(true);
    expect(events.length).toBeGreaterThan(0);

    const lastEvent = events[events.length - 1];
    expect(['status-update', 'artifact-update']).toContain(lastEvent.type);

    const terminalStatus = events
      .filter((e) => e.type === 'status-update')
      .find((e) => e.type === 'status-update' && ['completed', 'failed'].includes(e.status.state));
    expect(terminalStatus).toBeDefined();
  });

  it('concurrent streams do not interfere', async () => {
    const tokensA = ['Alpha', '-', 'one'];
    const tokensB = ['Beta', '-', 'two'];

    const serverA = await startTestA2AServer({
      agents: { 'agent-a': createMockAgent('agent-a') },
      cogitator: createStreamingCogitator(tokensA),
    });
    const serverB = await startTestA2AServer({
      agents: { 'agent-b': createMockAgent('agent-b') },
      cogitator: createStreamingCogitator(tokensB),
    });

    try {
      const clientA = new A2AClient(serverA.url);
      const clientB = new A2AClient(serverB.url);

      const collectStream = async (
        stream: AsyncGenerator<A2AStreamEvent>
      ): Promise<A2AStreamEvent[]> => {
        const events: A2AStreamEvent[] = [];
        for await (const event of stream) {
          events.push(event);
        }
        return events;
      };

      const [eventsA, eventsB] = await Promise.all([
        collectStream(
          clientA.sendMessageStream({
            role: 'user',
            parts: [{ type: 'text', text: 'Stream A' }],
          })
        ),
        collectStream(
          clientB.sendMessageStream({
            role: 'user',
            parts: [{ type: 'text', text: 'Stream B' }],
          })
        ),
      ]);

      const tokA = eventsA
        .filter((e) => e.type === 'token')
        .map((e) => (e.type === 'token' ? e.token : ''));
      const tokB = eventsB
        .filter((e) => e.type === 'token')
        .map((e) => (e.type === 'token' ? e.token : ''));

      expect(tokA).toEqual(tokensA);
      expect(tokB).toEqual(tokensB);

      const taskIdsA = new Set(
        eventsA
          .filter((e) => 'taskId' in e && e.taskId)
          .map((e) => (e as { taskId: string }).taskId)
      );
      const taskIdsB = new Set(
        eventsB
          .filter((e) => 'taskId' in e && e.taskId)
          .map((e) => (e as { taskId: string }).taskId)
      );

      for (const id of taskIdsA) {
        expect(taskIdsB.has(id)).toBe(false);
      }
    } finally {
      await serverA.close();
      await serverB.close();
    }
  });
});
