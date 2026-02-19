import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { A2AClient, type A2AStreamEvent } from '@cogitator-ai/a2a';
import {
  createTestCogitator,
  createTestAgent,
  createTestJudge,
  isOllamaRunning,
} from '../../helpers/setup';
import { expectJudge, setJudge } from '../../helpers/assertions';
import { startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';
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
      parts: [{ type: 'text', text: 'Count from 1 to 3.' }],
    })) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    const statusEvents = events.filter((e) => e.type === 'status-update');
    expect(statusEvents.length).toBeGreaterThanOrEqual(1);

    const lastStatus = [...statusEvents].pop();
    expect(lastStatus).toBeDefined();
    if (lastStatus?.type === 'status-update') {
      expect(['completed', 'failed']).toContain(lastStatus.status.state);
    }
  });

  it('streams artifacts via SSE', async () => {
    const events: A2AStreamEvent[] = [];

    for await (const event of client.sendMessageStream({
      role: 'user',
      parts: [{ type: 'text', text: 'What is the capital of France? Reply in one word.' }],
    })) {
      events.push(event);
    }

    const artifactEvents = events.filter((e) => e.type === 'artifact-update');
    if (artifactEvents.length > 0) {
      const art = artifactEvents[0];
      if (art.type === 'artifact-update') {
        const textPart = art.artifact.parts.find((p) => p.type === 'text');
        if (textPart?.type === 'text') {
          await expectJudge(textPart.text, {
            question: 'What is the capital of France?',
            criteria: 'Answer mentions Paris',
          });
        }
      }
    }
  });

  it('server stays responsive after client reads all events', async () => {
    const events: A2AStreamEvent[] = [];
    for await (const event of client.sendMessageStream({
      role: 'user',
      parts: [{ type: 'text', text: 'Say hello.' }],
    })) {
      events.push(event);
    }
    expect(events.length).toBeGreaterThan(0);

    const task = await client.sendMessage({
      role: 'user',
      parts: [{ type: 'text', text: 'Say goodbye.' }],
    });
    expect(task.status.state).toBe('completed');
  });
});
