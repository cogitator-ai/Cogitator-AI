import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { A2AClient, type AgentCard, type V1AgentCard, type V1Task } from '@cogitator-ai/a2a';
import type { Cogitator } from '@cogitator-ai/core';
import { createTestCogitator, createTestAgent, ollamaSkipReason } from '../../helpers/setup';
import { asTask, startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';

const describeE2E = describe.skipIf((await ollamaSkipReason()) !== null);

describeE2E('A2A 1.0 and 0.3 on one server', () => {
  let cogitator: Cogitator;
  let testServer: TestA2AServer;

  beforeAll(async () => {
    cogitator = createTestCogitator();
    testServer = await startTestA2AServer({
      agents: {
        helper: createTestAgent({
          name: 'helper',
          instructions: 'Answer in one short sentence.',
          maxTokens: 64,
        }),
      },
      cogitator,
    });
  });

  afterAll(async () => {
    await testServer?.close();
    await cogitator?.close();
  });

  it('serves the hybrid card without a version and the pure 1.0 card with one', async () => {
    const hybrid = (await (
      await fetch(`${testServer.url}/.well-known/agent-card.json`)
    ).json()) as AgentCard;
    expect(hybrid.protocolVersion).toBe('0.3.0');
    expect(hybrid.supportedInterfaces?.map((entry) => entry.protocolVersion)).toEqual([
      '1.0',
      '1.0',
      '0.3',
    ]);

    const v1Response = await fetch(`${testServer.url}/.well-known/agent-card.json`, {
      headers: { 'A2A-Version': '1.0' },
    });
    expect(v1Response.headers.get('vary')).toBe('A2A-Version');
    const v1 = (await v1Response.json()) as V1AgentCard & Record<string, unknown>;
    expect(v1).not.toHaveProperty('protocolVersion');
    expect(v1.skills.length).toBeGreaterThan(0);
  });

  it('shares tasks between a 0.3 client and a 1.0 client', async () => {
    const legacy = new A2AClient(testServer.url, { protocolVersion: '0.3' });
    const modern = new A2AClient(testServer.url);
    expect((await modern.endpoint()).protocolVersion).toBe('1.0');

    const task = asTask(
      await legacy.sendMessage({ role: 'user', parts: [{ kind: 'text', text: 'Say hi.' }] })
    );
    expect(task.status.state).toBe('completed');
    const seen = await modern.getTask(task.id);
    expect(seen.status.state).toBe('completed');
    expect(seen.artifacts?.[0].parts[0]).toMatchObject({ kind: 'text' });
  });

  it('answers the same request in each version form on one endpoint', async () => {
    const message = { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'Hello.' }] };
    const v1 = await fetch(`${testServer.url}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message } }),
    });
    const v1Task = ((await v1.json()) as { result: { task: V1Task } }).result.task;
    expect(v1Task.status.state).toBe('TASK_STATE_COMPLETED');

    const legacy = await fetch(`${testServer.url}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/get',
        params: { id: v1Task.id },
      }),
    });
    const legacyTask = (
      (await legacy.json()) as { result: { kind: string; status: { state: string } } }
    ).result;
    expect(legacyTask).toMatchObject({ kind: 'task', status: { state: 'completed' } });

    const wrong = await fetch(`${testServer.url}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'A2A-Version': '2.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'GetTask', params: { id: v1Task.id } }),
    });
    expect(((await wrong.json()) as { error: { code: number } }).error.code).toBe(-32009);
  });
});
