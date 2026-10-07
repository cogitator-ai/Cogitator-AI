import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { A2AClient, artifactText, type A2AStreamEvent } from '@cogitator-ai/a2a';
import {
  createTestCogitator,
  createTestAgent,
  createTestJudge,
  isOllamaRunning,
} from '../../helpers/setup';
import { expectJudge, setJudge } from '../../helpers/assertions';
import { asTask, startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';
import type { Cogitator } from '@cogitator-ai/core';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('A2A: Streaming SSE', () => {
  let cogitator: Cogitator;
  let testServer: TestA2AServer;
  let client: A2AClient;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
    setJudge(createTestJudge());

    const agent = createTestAgent({ name: 'stream-agent' });
    testServer = await startTestA2AServer({
      agents: { 'stream-agent': agent },
      cogitator,
    });
    client = new A2AClient(testServer.url);
  });

  afterAll(async () => {
    await testServer?.close();
    await cogitator?.close();
  });

  it('streams status updates via SSE', async () => {
    const events: A2AStreamEvent[] = [];

    for await (const event of client.sendMessageStream({
      role: 'user',
      parts: [{ kind: 'text', text: 'Count from 1 to 3.' }],
    })) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].kind).toBe('task');
    const statusEvents = events.filter((e) => e.kind === 'status-update');
    expect(statusEvents.length).toBeGreaterThanOrEqual(1);

    const lastStatus = [...statusEvents].pop();
    expect(lastStatus).toBeDefined();
    if (lastStatus?.kind === 'status-update') {
      expect(['completed', 'failed']).toContain(lastStatus.status.state);
      expect(lastStatus.final).toBe(true);
    }
  });

  it('streams artifacts via SSE', async () => {
    const events: A2AStreamEvent[] = [];

    for await (const event of client.sendMessageStream({
      role: 'user',
      parts: [{ kind: 'text', text: 'What is the capital of France? Reply in one word.' }],
    })) {
      events.push(event);
    }

    const last = events.at(-1);
    expect(last?.kind).toBe('status-update');
    if (last?.kind !== 'status-update' || last.status.state !== 'completed') return;

    const chunks = events.filter((e) => e.kind === 'artifact-update');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.at(-1)?.lastChunk).toBe(true);

    let reply = '';
    for (const chunk of chunks) {
      const text = artifactText(chunk.artifact);
      reply = chunk.append ? reply + text : text;
    }
    expect(reply.length).toBeGreaterThan(0);
    await expectJudge(reply, {
      question: 'What is the capital of France?',
      criteria: 'Answer mentions Paris',
    });
  });

  it('server stays responsive after client reads all events', async () => {
    const events: A2AStreamEvent[] = [];
    for await (const event of client.sendMessageStream({
      role: 'user',
      parts: [{ kind: 'text', text: 'Say hello.' }],
    })) {
      events.push(event);
    }
    expect(events.length).toBeGreaterThan(0);

    const task = asTask(
      await client.sendMessage({
        role: 'user',
        parts: [{ kind: 'text', text: 'Say goodbye.' }],
      })
    );
    expect(task.status.state).toBe('completed');
  });
});
