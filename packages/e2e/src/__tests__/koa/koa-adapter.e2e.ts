import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Koa from 'koa';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { Cogitator } from '@cogitator-ai/core';
import { cogitatorApp, setupWebSocket, type CogitatorAppOptions } from '@cogitator-ai/koa';
import {
  createCalculatorAgent,
  createChatAgent,
  createFailingWorkflow,
  createOfflineCogitator,
  createPipelineWorkflow,
  createSlowWorkflow,
  parseSSEData,
  resolveTestLLM,
  type TestLLM,
} from '../../helpers/server-adapter-fixtures';

interface RunningServer {
  baseUrl: string;
  server: Server;
  close(): Promise<void>;
}

async function startKoa(
  options: CogitatorAppOptions,
  configure?: (server: Server) => Promise<void>
): Promise<RunningServer> {
  const app = new Koa();
  const router = cogitatorApp(options);
  router.prefix('/api');
  app.use(router.routes());
  app.use(router.allowedMethods());

  const server = createServer(app.callback());
  await configure?.(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/api`,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function postJson(
  url: string,
  body: unknown,
  { headers, ...init }: { headers?: Record<string, string>; signal?: AbortSignal } = {}
): Promise<Response> {
  return fetch(url, {
    ...init,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('Koa adapter: HTTP contract', () => {
  let cogitator: Cogitator;
  let running: RunningServer;
  let secondStepRuns = 0;

  beforeAll(async () => {
    cogitator = createOfflineCogitator();
    running = await startKoa({
      cogitator,
      agents: { calculator: createCalculatorAgent('ollama/unused') },
      workflows: {
        pipeline: createPipelineWorkflow(),
        failing: createFailingWorkflow(),
        slow: createSlowWorkflow(() => {
          secondStepRuns++;
        }),
      },
      bodyLimit: 4096,
      auth: (ctx) => {
        if (ctx.get('authorization') !== 'Bearer e2e') throw new Error('invalid token');
        return { userId: 'e2e' };
      },
    });
  });

  afterAll(async () => {
    await running?.close();
    await cogitator?.close();
  });

  const auth = { authorization: 'Bearer e2e' };

  it('rejects requests without valid credentials', async () => {
    const res = await fetch(`${running.baseUrl}/agents`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { message: 'Unauthorized', code: 'UNAUTHORIZED' } });
  });

  it('lists agents with their public description and never their instructions', async () => {
    const res = await fetch(`${running.baseUrl}/agents`, { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents).toEqual([
      { name: 'calculator', description: 'Multiplies numbers with a tool', tools: ['multiply'] },
    ]);
    expect(JSON.stringify(body)).not.toContain('Always call the multiply tool');
  });

  it('exposes real tools as JSON Schema', async () => {
    const res = await fetch(`${running.baseUrl}/tools`, { headers: auth });
    const body = await res.json();
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toMatchObject({
      name: 'multiply',
      parameters: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
    });
  });

  it('does not resolve prototype members as registered resources', async () => {
    for (const path of ['/agents/constructor/run', '/workflows/toString/run']) {
      const res = await postJson(`${running.baseUrl}${path}`, { input: 'x' }, { headers: auth });
      expect(res.status).toBe(404);
    }
  });

  it('validates request bodies before touching the runtime', async () => {
    const res = await postJson(
      `${running.baseUrl}/agents/calculator/run`,
      { input: ['not', 'a', 'string'] },
      { headers: auth }
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toEqual({
      message: 'Field "input" must be a string',
      code: 'INVALID_INPUT',
    });
  });

  it('enforces the configured body limit with 413', async () => {
    const res = await postJson(
      `${running.baseUrl}/agents/calculator/run`,
      { input: 'x'.repeat(10_000) },
      { headers: auth }
    );
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('runs a real workflow and returns serialized node results', async () => {
    const res = await postJson(
      `${running.baseUrl}/workflows/pipeline/run`,
      { input: { text: 'hello' } },
      { headers: auth }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toMatchObject({ text: 'HELLO!', steps: ['upper', 'exclaim'] });
    expect(body.nodeResults.upper.output).toBe('HELLO');
    expect(body.nodeResults.exclaim.output).toBe('HELLO!');
  });

  it('reports a failing workflow as an error without leaking internals', async () => {
    const res = await postJson(`${running.baseUrl}/workflows/failing/run`, {}, { headers: auth });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('hunter2');
    expect(JSON.parse(text).error.code).toBe('INTERNAL_ERROR');
  });

  it('streams workflow node events over SSE', async () => {
    const res = await postJson(
      `${running.baseUrl}/workflows/pipeline/stream`,
      { input: { text: 'sse' } },
      { headers: auth }
    );
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const raw = await res.text();
    const events = parseSSEData(raw);
    const started = events
      .filter((e) => e.type === 'workflow' && e.event === 'node_started')
      .map((e) => (e.data as { nodeName: string }).nodeName);
    expect(started).toEqual(['upper', 'exclaim']);
    expect(events.some((e) => e.event === 'workflow_completed')).toBe(true);
    expect(raw.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('stops a streaming workflow when the client disconnects', async () => {
    const controller = new AbortController();
    const res = await postJson(
      `${running.baseUrl}/workflows/slow/stream`,
      {},
      { headers: auth, signal: controller.signal }
    );
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();

    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(secondStepRuns).toBe(0);
  });

  it('stores and returns thread messages through the memory adapter', async () => {
    const threadUrl = `${running.baseUrl}/threads/e2e-thread`;
    const added = await postJson(
      `${threadUrl}/messages`,
      { role: 'user', content: 'remember the number 42', metadata: { source: 'e2e' } },
      { headers: auth }
    );
    expect(added.status).toBe(201);

    const thread = await (await fetch(threadUrl, { headers: auth })).json();
    expect(thread.messages).toEqual([{ role: 'user', content: 'remember the number 42' }]);
    expect(thread.createdAt).toBeLessThanOrEqual(thread.updatedAt);

    const deleted = await fetch(threadUrl, { method: 'DELETE', headers: auth });
    expect(deleted.status).toBe(204);
    const empty = await (await fetch(threadUrl, { headers: auth })).json();
    expect(empty.messages).toEqual([]);
  });
});

const describeWebSocket = typeof globalThis.WebSocket === 'function' ? describe : describe.skip;

describeWebSocket('Koa adapter: WebSocket', () => {
  let cogitator: Cogitator;
  let running: RunningServer;
  let wsUrl: string;

  beforeAll(async () => {
    cogitator = createOfflineCogitator();
    const options: CogitatorAppOptions = {
      cogitator,
      workflows: { pipeline: createPipelineWorkflow() },
    };
    running = await startKoa(options, async (server) => {
      await setupWebSocket(
        server,
        { runtime: cogitator, agents: {}, workflows: options.workflows ?? {}, swarms: {} },
        {
          path: '/ws',
          auth: (req) => {
            const token = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');
            if (token !== 'e2e') throw new Error('invalid token');
            return { userId: 'e2e' };
          },
        }
      );
    });
    wsUrl = running.baseUrl.replace('http://', 'ws://').replace('/api', '/ws');
  });

  afterAll(async () => {
    await running?.close();
    await cogitator?.close();
  });

  function open(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(ws), { once: true });
      ws.addEventListener('error', () => reject(new Error('connection failed')), { once: true });
    });
  }

  function request(ws: WebSocket, message: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      ws.addEventListener(
        'message',
        (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>),
        { once: true }
      );
      ws.send(JSON.stringify(message));
    });
  }

  it('refuses connections that fail authentication', async () => {
    await expect(open(`${wsUrl}?token=wrong`)).rejects.toThrow('connection failed');
  });

  it('runs a workflow over an authenticated connection', async () => {
    const ws = await open(`${wsUrl}?token=e2e`);
    try {
      expect(await request(ws, { type: 'ping', id: 'p' })).toEqual({ type: 'pong', id: 'p' });

      const response = await request(ws, {
        type: 'run',
        id: 'wf',
        payload: { type: 'workflow', name: 'pipeline', input: 'ignored' },
      });
      expect(response).toMatchObject({
        type: 'event',
        id: 'wf',
        payload: { type: 'complete', result: { workflowName: 'text-pipeline' } },
      });
      const result = (response.payload as { result: { nodeResults: Record<string, unknown> } })
        .result;
      expect(Object.keys(result.nodeResults)).toEqual(['upper', 'exclaim']);
    } finally {
      ws.close();
    }
  });
});

describe('Koa adapter: live LLM', () => {
  let llm: TestLLM | null = null;
  let cogitator: Cogitator | undefined;
  let running: RunningServer | undefined;

  beforeAll(async () => {
    llm = await resolveTestLLM();
    if (!llm) return;
    cogitator = llm.createCogitator();
    running = await startKoa({
      cogitator,
      agents: {
        chat: createChatAgent(llm.model),
        calculator: createCalculatorAgent(llm.model),
      },
    });
  });

  afterAll(async () => {
    await running?.close();
    await cogitator?.close();
  });

  it('runs an agent and persists the conversation to the thread', async (ctx) => {
    if (!running) return ctx.skip();

    const res = await postJson(`${running.baseUrl}/agents/chat/run`, {
      input: 'What is the capital of France?',
      threadId: 'koa-live-thread',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.output).toBe('string');
    expect(body.output.length).toBeGreaterThan(0);
    expect(body.threadId).toBe('koa-live-thread');
    expect(body.usage.totalTokens).toBeGreaterThan(0);

    const thread = await (await fetch(`${running.baseUrl}/threads/koa-live-thread`)).json();
    const roles = thread.messages.map((m: { role: string }) => m.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
  });

  it('streams agent text over SSE', async (ctx) => {
    if (!running) return ctx.skip();

    const res = await postJson(`${running.baseUrl}/agents/chat/stream`, { input: 'Say hello' });
    const raw = await res.text();
    const events = parseSSEData(raw);
    expect(events[0].type).toBe('start');
    expect(events.some((e) => e.type === 'text-delta')).toBe(true);
    expect(events.at(-1)?.type).toBe('finish');
    expect(raw.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('correlates streamed tool calls with their results', async (ctx) => {
    if (!running || llm?.provider !== 'google') return ctx.skip();

    const res = await postJson(`${running.baseUrl}/agents/calculator/stream`, {
      input: 'Use the multiply tool to compute 12 times 34.',
    });
    const events = parseSSEData(await res.text());
    const calls = events.filter((e) => e.type === 'tool-call-start');
    const results = events.filter((e) => e.type === 'tool-result');
    expect(calls.length).toBeGreaterThan(0);
    expect(results.map((r) => r.toolCallId)).toEqual(calls.map((c) => c.id));
    expect(JSON.stringify(results)).toContain('408');
  });
});
