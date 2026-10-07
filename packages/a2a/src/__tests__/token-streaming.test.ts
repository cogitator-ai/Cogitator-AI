import { describe, it, expect, vi } from 'vitest';
import { A2AServer } from '../server';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import type {
  A2AStreamEvent,
  TaskArtifactUpdateEvent,
  CogitatorLike,
  AgentRunResult,
} from '../types';
import { collectEvents, userMessage } from './helpers';

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

async function streamWith(cogitator: CogitatorLike, text: string): Promise<A2AStreamEvent[]> {
  const server = new A2AServer({
    agents: { streamer: createMockAgent('streamer') },
    cogitator,
  });
  return collectEvents(
    server.handleJsonRpcStream({
      jsonrpc: '2.0',
      method: 'message/stream',
      params: { message: userMessage(text) },
      id: 1,
    })
  );
}

function chunks(events: A2AStreamEvent[]): TaskArtifactUpdateEvent[] {
  return events.filter((e): e is TaskArtifactUpdateEvent => e.kind === 'artifact-update');
}

function chunkText(event: TaskArtifactUpdateEvent): string {
  return event.artifact.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('');
}

describe('Token-level Streaming', () => {
  it('streams the tokens as chunks of one artifact, appended in order', async () => {
    const events = await streamWith(
      createStreamingCogitator(['Hello', ' ', 'world', '!'], 'Hello world!'),
      'Stream tokens'
    );

    const reply = chunks(events);
    expect(reply.map(chunkText)).toEqual(['Hello', ' ', 'world', '!']);
    expect(new Set(reply.map((c) => c.artifact.artifactId)).size).toBe(1);
    expect(reply[0].append).toBeUndefined();
    expect(reply.slice(1).every((c) => c.append === true)).toBe(true);
    expect(reply.map((c) => c.lastChunk)).toEqual([false, false, false, true]);
  });

  it('puts the task and context ids on every chunk', async () => {
    const events = await streamWith(createStreamingCogitator(['a', 'b'], 'ab'), 'ids');
    const task = events[0];
    expect(task.kind).toBe('task');
    if (task.kind !== 'task') return;
    for (const chunk of chunks(events)) {
      expect(chunk.taskId).toBe(task.id);
      expect(chunk.contextId).toBe(task.contextId);
    }
  });

  it('streams the chunks before the final status update', async () => {
    const events = await streamWith(
      createStreamingCogitator(['first', ' second', ' third'], 'first second third'),
      'Order check'
    );
    const finalIndex = events.findIndex((e) => e.kind === 'status-update' && e.final);
    const firstChunk = events.findIndex((e) => e.kind === 'artifact-update');
    expect(firstChunk).toBeGreaterThan(-1);
    expect(finalIndex).toBe(events.length - 1);
    expect(firstChunk).toBeLessThan(finalIndex);
  });

  it('runs the agent with stream=true and onToken', async () => {
    const cogitator = createStreamingCogitator(['x'], 'x');
    await streamWith(cogitator, 'Check run args');
    expect(cogitator.run).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ stream: true, onToken: expect.any(Function) })
    );
  });

  it('keeps the streamed artifact id in the stored task', async () => {
    const server = new A2AServer({
      agents: { streamer: createMockAgent('streamer') },
      cogitator: createStreamingCogitator(['Hel', 'lo'], 'Hello'),
    });
    const events = await collectEvents(
      server.handleJsonRpcStream({
        jsonrpc: '2.0',
        method: 'message/stream',
        params: { message: userMessage('store') },
        id: 1,
      })
    );
    const streamedId = chunks(events)[0].artifact.artifactId;
    const response = await server.handleJsonRpc({
      jsonrpc: '2.0',
      method: 'tasks/get',
      params: { id: chunks(events)[0].taskId },
      id: 2,
    });
    const task = response?.result as { artifacts: { artifactId: string; parts: unknown[] }[] };
    expect(task.artifacts).toEqual([
      { artifactId: streamedId, parts: [{ kind: 'text', text: 'Hello' }] },
    ]);
  });

  it('replaces the streamed text when the final reply differs from it', async () => {
    const events = await streamWith(
      createStreamingCogitator(['Let me check. ', 'Done: 42'], 'Done: 42'),
      'Replace'
    );
    const reply = chunks(events);
    const last = reply.at(-1)!;
    expect(last.append).toBe(false);
    expect(last.lastChunk).toBe(true);
    expect(chunkText(last)).toBe('Done: 42');
    expect(last.artifact.artifactId).toBe(reply[0].artifact.artifactId);
  });

  it('sends the whole reply as one artifact when no token was streamed', async () => {
    const events = await streamWith(createStreamingCogitator([], 'no tokens'), 'No tokens');
    const reply = chunks(events);
    expect(reply).toHaveLength(1);
    expect(chunkText(reply[0])).toBe('no tokens');
    expect(reply[0].lastChunk).toBe(true);

    const last = events.at(-1);
    expect(last?.kind === 'status-update' && last.status.state).toBe('completed');
  });
});
