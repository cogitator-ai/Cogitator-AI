import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { A2AClient, type A2AStreamEvent } from '@cogitator-ai/a2a';
import {
  createTestCogitator,
  createTestAgent,
  createTestTools,
  createTestJudge,
  isOllamaRunning,
} from '../../helpers/setup';
import { expectJudge, setJudge } from '../../helpers/assertions';
import { asTask, startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';
import type { Cogitator } from '@cogitator-ai/core';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('Cross-Package: Cogitator via A2A', () => {
  let cogitator: Cogitator;
  let testServer: TestA2AServer;
  let client: A2AClient;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
    setJudge(createTestJudge());

    const tools = createTestTools();
    const agent = createTestAgent({
      name: 'full-stack-agent',
      instructions: 'You are a math assistant. Use the multiply tool for multiplication.',
      tools: [tools.multiply],
    });

    testServer = await startTestA2AServer({
      agents: { 'full-stack-agent': agent },
      cogitator,
    });
    client = new A2AClient(testServer.url);
  });

  afterAll(async () => {
    await testServer?.close();
    await cogitator?.close();
  });

  it('executes agent task through full A2A stack', async () => {
    const task = asTask(
      await client.sendMessage({
        role: 'user',
        parts: [{ kind: 'text', text: 'What is 8 times 12? Use the multiply tool.' }],
      })
    );

    expect(task.status.state).toBe('completed');
    expect(task.artifacts).toBeDefined();

    const artifacts = task.artifacts ?? [];
    if (artifacts.length > 0) {
      const textPart = artifacts[0].parts.find((p) => p.kind === 'text');
      if (textPart?.kind === 'text') {
        await expectJudge(textPart.text, {
          question: 'What is 8 times 12?',
          criteria: 'Answer contains 96',
        });
      }
    }
  });

  it('streams agent execution through A2A', async () => {
    const events: A2AStreamEvent[] = [];

    for await (const event of client.sendMessageStream({
      role: 'user',
      parts: [{ kind: 'text', text: 'What is 3 times 5?' }],
    })) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].kind).toBe('task');

    const statusEvents = events.filter((e) => e.kind === 'status-update');
    expect(statusEvents.length).toBeGreaterThanOrEqual(1);

    const lastStatus = [...statusEvents].pop();
    if (lastStatus?.kind === 'status-update') {
      expect(['completed', 'failed']).toContain(lastStatus.status.state);
      expect(lastStatus.final).toBe(true);
    }
  });

  it('agent card accurately describes real agent', async () => {
    const card = await client.agentCard();
    expect(card.name).toBe('full-stack-agent');
    expect(card.skills.length).toBeGreaterThanOrEqual(1);
    expect(card.skills.some((s) => s.name === 'multiply')).toBe(true);
  });

  it('handles agent failure gracefully through A2A', async () => {
    const failCogitator = createTestCogitator();
    const failingAgent = createTestAgent({
      name: 'fail-agent',
      instructions: 'You must use the divide tool.',
      tools: [createTestTools().failing],
    });

    const failServer = await startTestA2AServer({
      agents: { 'fail-agent': failingAgent },
      cogitator: failCogitator,
    });
    const failClient = new A2AClient(failServer.url);

    try {
      const task = asTask(
        await failClient.sendMessage({
          role: 'user',
          parts: [{ kind: 'text', text: 'Divide 1 by 0 using the divide tool.' }],
        })
      );

      expect(['completed', 'failed']).toContain(task.status.state);

      const checkTask = asTask(
        await failClient.sendMessage({
          role: 'user',
          parts: [{ kind: 'text', text: 'Say hello.' }],
        })
      );
      expect(checkTask.status.state).toBe('completed');
    } finally {
      await failServer.close();
      await failCogitator.close();
    }
  });
});
