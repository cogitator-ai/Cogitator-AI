import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { A2AClient } from '@cogitator-ai/a2a';
import { createTestCogitator, createTestAgent, isOllamaRunning } from '../../helpers/setup';
import { expectValidTimestamp } from '../../helpers/assertions';
import { startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';
import type { Cogitator } from '@cogitator-ai/core';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('A2A: Task Lifecycle', () => {
  let cogitator: Cogitator;
  let testServer: TestA2AServer;
  let client: A2AClient;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();

    const agent = createTestAgent({ name: 'lifecycle-agent' });
    testServer = await startTestA2AServer({
      agents: { 'lifecycle-agent': agent },
      cogitator,
    });
    client = new A2AClient(testServer.url);
  });

  afterAll(async () => {
    await testServer?.close();
    await cogitator?.close();
  });

  it('task is retrievable by ID after creation', async () => {
    const task = await client.sendMessage({
      role: 'user',
      parts: [{ type: 'text', text: 'Hello' }],
    });

    const retrieved = await client.getTask(task.id);
    expect(retrieved.id).toBe(task.id);
    expect(retrieved.status.state).toBe(task.status.state);
  });

  it('task has correct timestamps', async () => {
    const task = await client.sendMessage({
      role: 'user',
      parts: [{ type: 'text', text: 'Hello' }],
    });

    expect(task.status.timestamp).toBeDefined();
    expectValidTimestamp(task.status.timestamp);
  });

  it('cancel returns error for completed task', async () => {
    const task = await client.sendMessage({
      role: 'user',
      parts: [{ type: 'text', text: 'Hello' }],
    });
    expect(task.status.state).toBe('completed');

    await expect(client.cancelTask(task.id)).rejects.toThrow();
  });

  it('returns error for unknown task ID', async () => {
    await expect(client.getTask('nonexistent_task_id_xyz')).rejects.toThrow();
  });
});
