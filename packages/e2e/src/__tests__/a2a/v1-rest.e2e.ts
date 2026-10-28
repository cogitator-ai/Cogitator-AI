import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { V1RestErrorBody, V1StreamResponse, V1Task } from '@cogitator-ai/a2a';
import type { Cogitator } from '@cogitator-ai/core';
import { createTestCogitator, createTestAgent, ollamaSkipReason } from '../../helpers/setup';
import { startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';

const describeE2E = describe.skipIf((await ollamaSkipReason()) !== null);

const HEADERS = { 'Content-Type': 'application/a2a+json', 'A2A-Version': '1.0' };

function body(text: string) {
  return JSON.stringify({
    message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }] },
  });
}

describeE2E('A2A 1.0: HTTP+JSON binding on a real model', () => {
  let cogitator: Cogitator;
  let testServer: TestA2AServer;
  let rest: string;

  beforeAll(async () => {
    cogitator = createTestCogitator();
    const agent = (name: string) =>
      createTestAgent({ name, instructions: 'Answer in one short sentence.', maxTokens: 64 });
    testServer = await startTestA2AServer({
      agents: { assistant: agent('assistant'), poet: agent('poet') },
      cogitator,
      allowPrivateUrls: true,
    });
    rest = `${testServer.url}/a2a/rest`;
  });

  afterAll(async () => {
    await testServer?.close();
    await cogitator?.close();
  });

  it('sends a message and reads the task back', async () => {
    const sent = await fetch(`${rest}/message:send`, {
      method: 'POST',
      headers: HEADERS,
      body: body('What is 2 + 2?'),
    });
    expect(sent.status).toBe(200);
    expect(sent.headers.get('content-type')).toContain('application/a2a+json');
    const { task } = (await sent.json()) as { task: V1Task };
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');

    const fetched = await fetch(`${rest}/tasks/${task.id}`, { headers: { 'A2A-Version': '1.0' } });
    expect(((await fetched.json()) as V1Task).id).toBe(task.id);
  });

  it('serves a second agent under its tenant and keeps its tasks there', async () => {
    const sent = await fetch(`${rest}/poet/message:send`, {
      method: 'POST',
      headers: HEADERS,
      body: body('One line about the sea.'),
    });
    const { task } = (await sent.json()) as { task: V1Task };
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    const own = await fetch(`${rest}/poet/tasks/${task.id}`, { headers: { 'A2A-Version': '1.0' } });
    expect(own.status).toBe(200);
    const other = await fetch(`${rest}/tasks/${task.id}`, { headers: { 'A2A-Version': '1.0' } });
    expect(other.status).toBe(404);
    const error = ((await other.json()) as V1RestErrorBody).error;
    expect(error).toMatchObject({ code: 404, status: 'NOT_FOUND' });
  });

  it('streams StreamResponse events as SSE', async () => {
    const response = await fetch(`${rest}/message:stream`, {
      method: 'POST',
      headers: HEADERS,
      body: body('Name a color.'),
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const events = (await response.text())
      .split('\n\n')
      .filter((frame) => frame.startsWith('data:'))
      .map((frame) => JSON.parse(frame.slice(5)) as V1StreamResponse);
    expect(Object.keys(events[0])).toEqual(['task']);
    const last = events.at(-1)!;
    expect('statusUpdate' in last && last.statusUpdate.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('creates and deletes a push config with 201 and 204', async () => {
    const sent = await fetch(`${rest}/message:send`, {
      method: 'POST',
      headers: HEADERS,
      body: body('Hello.'),
    });
    const { task } = (await sent.json()) as { task: V1Task };
    const base = `${rest}/tasks/${task.id}/pushNotificationConfigs`;
    const created = await fetch(base, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ url: 'https://hooks.example.com/a2a', token: 'tok' }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const deleted = await fetch(`${base}/${id}`, {
      method: 'DELETE',
      headers: { 'A2A-Version': '1.0' },
    });
    expect(deleted.status).toBe(204);
  });

  it('pages ListTasks with a cursor and refuses a forged one', async () => {
    const first = await fetch(`${rest}/tasks?pageSize=1`, { headers: { 'A2A-Version': '1.0' } });
    const page = (await first.json()) as { tasks: V1Task[]; nextPageToken: string };
    expect(page.tasks).toHaveLength(1);
    const next = await fetch(
      `${rest}/tasks?pageSize=1&pageToken=${encodeURIComponent(page.nextPageToken)}`,
      { headers: { 'A2A-Version': '1.0' } }
    );
    const second = (await next.json()) as { tasks: V1Task[] };
    expect(second.tasks[0]?.id).not.toBe(page.tasks[0].id);

    const forged = await fetch(`${rest}/tasks?pageToken=forged`, {
      headers: { 'A2A-Version': '1.0' },
    });
    expect(forged.status).toBe(400);
  });
});
