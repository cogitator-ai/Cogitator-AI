import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { V1StreamResponse, V1Task } from '@cogitator-ai/a2a';
import type { Cogitator } from '@cogitator-ai/core';
import { createTestCogitator, createTestAgent, ollamaSkipReason } from '../../helpers/setup';
import { startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';

const describeE2E = describe.skipIf((await ollamaSkipReason()) !== null);

interface RpcBody {
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

async function rpc(url: string, method: string, params: unknown): Promise<RpcBody> {
  const response = await fetch(`${url}/a2a`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
  });
  return (await response.json()) as RpcBody;
}

function userMessage(text: string, extra: Record<string, unknown> = {}) {
  return { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }], ...extra };
}

describeE2E('A2A 1.0: JSON-RPC methods on a real model', () => {
  let cogitator: Cogitator;
  let testServer: TestA2AServer;

  beforeAll(async () => {
    cogitator = createTestCogitator();
    testServer = await startTestA2AServer({
      agents: {
        greeter: createTestAgent({
          name: 'greeter',
          instructions: 'You greet people in one short sentence.',
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

  it('SendMessage completes a task with an answer in ProtoJSON form', async () => {
    const reply = await rpc(testServer.url, 'SendMessage', {
      message: userMessage('Say hello to Ada.'),
    });
    expect(reply.error).toBeUndefined();
    const task = (reply.result as { task: V1Task }).task;
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    const text = task.artifacts?.[0].parts
      .map((part) => ('text' in part ? part.text : ''))
      .join('');
    expect(text?.trim().length).toBeGreaterThan(0);
    expect(task.history?.[0].role).toBe('ROLE_USER');
    expect(JSON.stringify(task)).not.toMatch(/"kind"/);
  });

  it('GetTask and ListTasks read it back, history omitted for historyLength 0', async () => {
    const sent = await rpc(testServer.url, 'SendMessage', { message: userMessage('Hi.') });
    const task = (sent.result as { task: V1Task }).task;
    const fetched = await rpc(testServer.url, 'GetTask', { id: task.id, historyLength: 0 });
    expect(fetched.result).toMatchObject({
      id: task.id,
      status: { state: 'TASK_STATE_COMPLETED' },
    });
    expect(fetched.result).not.toHaveProperty('history');

    const listed = await rpc(testServer.url, 'ListTasks', { pageSize: 1 });
    const page = listed.result as { tasks: V1Task[]; nextPageToken: string; totalSize: number };
    expect(page.tasks).toHaveLength(1);
    expect(page.totalSize).toBeGreaterThanOrEqual(2);
    expect(page.nextPageToken).not.toBe('');
  });

  it('streams with SendStreamingMessage until the task completes', async () => {
    const response = await fetch(`${testServer.url}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'stream-1',
        method: 'SendStreamingMessage',
        params: { message: userMessage('Greet Grace.') },
      }),
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const frames = (await response.text())
      .split('\n\n')
      .filter((frame) => frame.startsWith('data:'))
      .map((frame) => JSON.parse(frame.slice(5)) as { result: V1StreamResponse });
    expect(Object.keys(frames[0].result)).toEqual(['task']);
    expect(frames.some((frame) => 'artifactUpdate' in frame.result)).toBe(true);
    const last = frames.at(-1)!.result;
    expect('statusUpdate' in last && last.statusUpdate.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('refuses SubscribeToTask and SendMessage on a task that ended with -32004', async () => {
    const sent = await rpc(testServer.url, 'SendMessage', { message: userMessage('Bye.') });
    const task = (sent.result as { task: V1Task }).task;
    const subscribe = await rpc(testServer.url, 'SubscribeToTask', { id: task.id });
    expect(subscribe.error?.code).toBe(-32004);
    const again = await rpc(testServer.url, 'SendMessage', {
      message: userMessage('Again.', { taskId: task.id }),
    });
    expect(again.error?.code).toBe(-32004);
    expect(again.error?.data).toContainEqual(
      expect.objectContaining({ reason: 'UNSUPPORTED_OPERATION', domain: 'a2a-protocol.org' })
    );
  });

  it('reports a missing task with a google.rpc ErrorInfo', async () => {
    const reply = await rpc(testServer.url, 'GetTask', { id: 'task_missing' });
    expect(reply.error?.code).toBe(-32001);
    expect(reply.error?.data).toEqual([
      {
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
        reason: 'TASK_NOT_FOUND',
        domain: 'a2a-protocol.org',
        metadata: { taskId: 'task_missing' },
      },
    ]);
  });
});
