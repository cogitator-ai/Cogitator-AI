import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'net';
import { createOpenAIServer, type OpenAIServer } from '@cogitator-ai/openai-compat';
import { createTestCogitator, isOllamaRunning, getTestModel } from '../../helpers/setup';
import type { Cogitator } from '@cogitator-ai/core';

function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Failed to get port')));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function pollRunUntilDone(
  url: string,
  threadId: string,
  runId: string,
  timeoutMs = 60_000,
  intervalMs = 500
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await fetch(`${url}/v1/threads/${threadId}/runs/${runId}`);
    const run = (await res.json()) as Record<string, unknown>;
    const status = run.status as string;

    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      return run;
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(`Run ${runId} did not complete within ${timeoutMs}ms`);
}

describe('OpenAI-Compatible Server', () => {
  let cogitator: Cogitator;
  let server: OpenAIServer;
  let url: string;

  beforeAll(async () => {
    cogitator = createTestCogitator();
    const port = await getRandomPort();
    server = createOpenAIServer(cogitator, { port, host: '127.0.0.1', logging: false });
    await new Promise((r) => setTimeout(r, 500));
    await server.start();
    url = server.getUrl();
  });

  afterAll(async () => {
    await server?.stop();
    await cogitator?.close();
  });

  it('health endpoint returns ok', async () => {
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('lists available models', async () => {
    const res = await fetch(`${url}/v1/models`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { data: { id: string }[] };
    expect(Array.isArray(body.data)).toBe(true);

    const cogitatorModel = body.data.find((m) => m.id === 'cogitator');
    expect(cogitatorModel).toBeDefined();
  });

  it('creates assistant, thread, and adds message', async () => {
    const assistantRes = await fetch(`${url}/v1/assistants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'cogitator', name: 'Test', instructions: 'Be helpful' }),
    });
    expect(assistantRes.status).toBe(201);
    const assistant = (await assistantRes.json()) as { id: string };
    expect(typeof assistant.id).toBe('string');

    const threadRes = await fetch(`${url}/v1/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(threadRes.status).toBe(201);
    const thread = (await threadRes.json()) as { id: string };
    expect(typeof thread.id).toBe('string');

    const messageRes = await fetch(`${url}/v1/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: 'Hello' }),
    });
    expect(messageRes.status).toBe(201);
    const message = (await messageRes.json()) as { id: string };
    expect(typeof message.id).toBe('string');
  });

  it('returns error for unknown assistant', async () => {
    const res = await fetch(`${url}/v1/assistants/nonexistent`);
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: { code: string } };
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('not_found');
  });
});

const describeOllama = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeOllama('OpenAI-Compatible Server (with Ollama)', () => {
  let cogitator: Cogitator;
  let server: OpenAIServer;
  let url: string;

  let assistantId: string;
  let threadId: string;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');

    cogitator = createTestCogitator();
    const port = await getRandomPort();
    server = createOpenAIServer(cogitator, { port, host: '127.0.0.1', logging: false });
    await new Promise((r) => setTimeout(r, 500));
    await server.start();
    url = server.getUrl();

    const assistantRes = await fetch(`${url}/v1/assistants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `ollama/${getTestModel()}`,
        name: 'E2E Assistant',
        instructions: 'You are a helpful assistant. Keep responses brief.',
      }),
    });
    assistantId = ((await assistantRes.json()) as { id: string }).id;

    const threadRes = await fetch(`${url}/v1/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    threadId = ((await threadRes.json()) as { id: string }).id;

    await fetch(`${url}/v1/threads/${threadId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: 'What is 2 + 2? Reply with just the number.' }),
    });
  });

  afterAll(async () => {
    await server?.stop();
    await cogitator?.close();
  });

  it('creates run and completes', async () => {
    const runRes = await fetch(`${url}/v1/threads/${threadId}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assistant_id: assistantId }),
    });
    expect(runRes.status).toBe(201);

    const run = (await runRes.json()) as { id: string; status: string };
    expect(typeof run.id).toBe('string');

    const completed = await pollRunUntilDone(url, threadId, run.id);
    expect(completed.status).toBe('completed');
  });

  it('lists messages after completed run', async () => {
    const messagesRes = await fetch(`${url}/v1/threads/${threadId}/messages`);
    expect(messagesRes.status).toBe(200);

    const body = (await messagesRes.json()) as { data: { role: string }[] };
    expect(Array.isArray(body.data)).toBe(true);

    const assistantMessage = body.data.find((m) => m.role === 'assistant');
    expect(assistantMessage).toBeDefined();
  });
});
