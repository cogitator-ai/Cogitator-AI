import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  A2AClient,
  artifactText,
  type A2AStreamEvent,
  type CogitatorLike,
  type TaskArtifactUpdateEvent,
} from '@cogitator-ai/a2a';
import type { AgentRunResult } from '@cogitator-ai/a2a';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import { createStubAgent, startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';

const TOKENS = ['Hello', ' ', 'world', '!'];

function createMockAgent(name: string): Agent {
  const config: AgentConfig = {
    name,
    model: 'mock',
    instructions: 'test',
    description: `${name} agent`,
  };
  return createStubAgent(config);
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

function artifactChunks(events: A2AStreamEvent[]): TaskArtifactUpdateEvent[] {
  return events.filter((e): e is TaskArtifactUpdateEvent => e.kind === 'artifact-update');
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

  it('tokens stream as chunks of one artifact', async () => {
    const events: A2AStreamEvent[] = [];

    for await (const event of client.sendMessageStream({
      role: 'user',
      parts: [{ kind: 'text', text: 'Say hello world' }],
    })) {
      events.push(event);
    }

    const chunks = artifactChunks(events);
    expect(chunks.length).toBe(TOKENS.length);
    expect(chunks.map((chunk) => artifactText(chunk.artifact))).toEqual(TOKENS);

    expect(new Set(chunks.map((chunk) => chunk.artifact.artifactId)).size).toBe(1);
    expect(chunks[0].append).toBeFalsy();
    expect(chunks.slice(1).every((chunk) => chunk.append === true)).toBe(true);
    expect(chunks.slice(0, -1).every((chunk) => chunk.lastChunk === false)).toBe(true);
    expect(chunks.at(-1)?.lastChunk).toBe(true);
  });

  it('status transitions from submitted through working to completed', async () => {
    const events: A2AStreamEvent[] = [];

    for await (const event of client.sendMessageStream({
      role: 'user',
      parts: [{ kind: 'text', text: 'Check status transitions' }],
    })) {
      events.push(event);
    }

    const snapshot = events[0];
    expect(snapshot.kind).toBe('task');
    if (snapshot.kind === 'task') {
      expect(snapshot.status.state).toBe('submitted');
    }

    const statusEvents = events.filter((e) => e.kind === 'status-update');
    expect(statusEvents.length).toBeGreaterThanOrEqual(2);

    const first = statusEvents[0];
    if (first.kind === 'status-update') {
      expect(first.status.state).toBe('working');
      expect(first.final).toBe(false);
    }

    const last = statusEvents[statusEvents.length - 1];
    if (last.kind === 'status-update') {
      expect(last.status.state).toBe('completed');
      expect(last.final).toBe(true);
    }
  });

  it('completed task has artifacts with final output', async () => {
    let taskId = '';

    for await (const event of client.sendMessageStream({
      role: 'user',
      parts: [{ kind: 'text', text: 'Produce artifact' }],
    })) {
      if (event.kind === 'status-update') {
        taskId = event.taskId;
      }
    }

    expect(taskId).toBeTruthy();
    const task = await client.getTask(taskId);
    expect(task.status.state).toBe('completed');
    const artifacts = task.artifacts ?? [];
    expect(artifacts.length).toBeGreaterThanOrEqual(1);

    const textPart = artifacts[0].parts.find((p) => p.kind === 'text');
    expect(textPart).toBeDefined();
    if (textPart?.kind === 'text') {
      expect(textPart.text).toBe(TOKENS.join(''));
    }
  });

  it('stream terminates after completion', async () => {
    const events: A2AStreamEvent[] = [];

    for await (const event of client.sendMessageStream({
      role: 'user',
      parts: [{ kind: 'text', text: 'Should terminate' }],
    })) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);

    const lastEvent = events[events.length - 1];
    expect(lastEvent.kind).toBe('status-update');
    if (lastEvent.kind === 'status-update') {
      expect(lastEvent.final).toBe(true);
      expect(['completed', 'failed']).toContain(lastEvent.status.state);
    }
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
            parts: [{ kind: 'text', text: 'Stream A' }],
          })
        ),
        collectStream(
          clientB.sendMessageStream({
            role: 'user',
            parts: [{ kind: 'text', text: 'Stream B' }],
          })
        ),
      ]);

      const tokA = artifactChunks(eventsA).map((chunk) => artifactText(chunk.artifact));
      const tokB = artifactChunks(eventsB).map((chunk) => artifactText(chunk.artifact));

      expect(tokA).toEqual(tokensA);
      expect(tokB).toEqual(tokensB);

      const taskIdOf = (e: A2AStreamEvent): string | undefined =>
        e.kind === 'task' ? e.id : e.taskId;
      const taskIdsA = new Set(eventsA.map(taskIdOf).filter(Boolean));
      const taskIdsB = new Set(eventsB.map(taskIdOf).filter(Boolean));
      expect(taskIdsA.size).toBe(1);
      expect(taskIdsB.size).toBe(1);

      for (const id of taskIdsA) {
        expect(taskIdsB.has(id)).toBe(false);
      }
    } finally {
      await serverA.close();
      await serverB.close();
    }
  });
});
