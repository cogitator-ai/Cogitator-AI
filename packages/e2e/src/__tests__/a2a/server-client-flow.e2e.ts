import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { A2AClient } from '@cogitator-ai/a2a';
import {
  createTestCogitator,
  createTestAgent,
  createTestTools,
  createTestJudge,
  isOllamaRunning,
} from '../../helpers/setup';
import { expectJudge, setJudge } from '../../helpers/assertions';
import { startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';
import type { Cogitator } from '@cogitator-ai/core';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('A2A: Server-Client Flow', () => {
  let cogitator: Cogitator;
  let testServer: TestA2AServer;
  let client: A2AClient;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
    setJudge(createTestJudge());

    const agent = createTestAgent({ name: 'e2e-agent' });
    testServer = await startTestA2AServer({
      agents: { 'e2e-agent': agent },
      cogitator,
    });
    client = new A2AClient(testServer.url);
  });

  afterAll(async () => {
    await testServer?.close();
    await cogitator?.close();
  });

  it('sends message and receives completed task', async () => {
    const task = await client.sendMessage({
      role: 'user',
      parts: [{ type: 'text', text: 'What is 2 + 2? Reply with just the number.' }],
    });

    expect(task.id).toBeDefined();
    expect(task.status.state).toBe('completed');
    expect(task.artifacts).toBeDefined();

    if (task.artifacts.length > 0) {
      const textPart = task.artifacts[0].parts.find((p) => p.type === 'text');
      if (textPart?.type === 'text') {
        await expectJudge(textPart.text, {
          question: 'What is 2 + 2?',
          criteria: 'Answer contains 4',
        });
      }
    }
  });

  it('sends message with tool-equipped agent', async () => {
    const tools = createTestTools();
    const toolAgent = createTestAgent({
      name: 'tool-agent',
      instructions: 'Use the multiply tool for multiplication.',
      tools: [tools.multiply],
    });

    const toolServer = await startTestA2AServer({
      agents: { 'tool-agent': toolAgent },
      cogitator,
    });
    const toolClient = new A2AClient(toolServer.url);

    try {
      const task = await toolClient.sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: 'What is 6 times 7? Use the multiply tool.' }],
      });

      expect(task.status.state).toBe('completed');

      const textPart = task.artifacts?.[0]?.parts.find((p) => p.type === 'text');
      if (textPart?.type === 'text') {
        await expectJudge(textPart.text, {
          question: 'What is 6 times 7?',
          criteria: 'Answer contains 42',
        });
      }
    } finally {
      await toolServer.close();
    }
  });

  it('returns task for empty message parts', async () => {
    const task = await client.sendMessage({
      role: 'user',
      parts: [],
    });

    expect(task.status.state).toBe('completed');
  });

  it('handles concurrent requests', async () => {
    const promises = Array.from({ length: 3 }, (_, i) =>
      client.sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: `Say the number ${i + 1}.` }],
      })
    );

    const tasks = await Promise.all(promises);
    expect(tasks).toHaveLength(3);

    const ids = new Set(tasks.map((t) => t.id));
    expect(ids.size).toBe(3);

    for (const task of tasks) {
      expect(task.status.state).toBe('completed');
    }
  });
});
