import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AddressInfo } from 'net';
import { request as httpRequest } from 'http';
import { createRequire } from 'module';
import type { WebSocket as WebSocketClient } from 'ws';
import { WorkflowBuilder } from '@cogitator-ai/workflows';
import { CogitatorError, ErrorCode, type RunOptions } from '@cogitator-ai/types';
import { cogitatorPlugin } from '../plugin.js';
import type { CogitatorPluginOptions, WebSocketResponse } from '../types.js';

const requireFromWebsocketPlugin = createRequire(
  createRequire(import.meta.url).resolve('@fastify/websocket')
);
const { WebSocket } = requireFromWebsocketPlugin('ws') as typeof import('ws');

type Cogitator = CogitatorPluginOptions['cogitator'];
type Agent = NonNullable<CogitatorPluginOptions['agents']>[string];
type RunImpl = (options: RunOptions) => Promise<unknown>;

function runResult(output = 'done') {
  return {
    output,
    threadId: 'thread-1',
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    toolCalls: [],
    trace: { traceId: 't', spans: [] },
  };
}

const agent = {
  name: 'bot',
  config: { instructions: 'secret system prompt', tools: [] },
} as unknown as Agent;

let app: FastifyInstance | undefined;
const sockets: WebSocketClient[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await app?.close();
  app = undefined;
});

async function start(
  impl: RunImpl,
  overrides: Partial<CogitatorPluginOptions> = {},
  memory: unknown = null,
  setup?: (instance: FastifyInstance) => void
) {
  const run = vi.fn((_agent: Agent, options: RunOptions) => impl(options));
  app = Fastify({ logger: false });
  setup?.(app);
  await app.register(cogitatorPlugin, {
    cogitator: { run, memory } as unknown as Cogitator,
    agents: { bot: agent },
    prefix: '/api',
    ...overrides,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  return { run, base: `http://127.0.0.1:${port}/api`, ws: `ws://127.0.0.1:${port}/api/ws` };
}

interface Event {
  type: string;
  [key: string]: unknown;
}

function parseEvents(raw: string): Event[] {
  return raw
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Event);
}

function post(url: string, body: unknown) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe('plugin validation and errors', () => {
  it.each([
    ['missing input', {}],
    ['blank input', { input: '   ' }],
  ])('returns 400 for %s instead of 500', async (_name, body) => {
    const { base, run } = await start(async () => runResult());
    const res = await post(`${base}/agents/bot/run`, body);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_INPUT');
    expect(run).not.toHaveBeenCalled();
  });

  it('returns 400 for malformed JSON', async () => {
    const { base } = await start(async () => runResult());
    const res = await post(`${base}/agents/bot/run`, '{"input": ');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_INPUT');
  });

  it('maps CogitatorError codes to their HTTP status', async () => {
    const { base } = await start(async () => {
      throw new CogitatorError({ message: 'slow down', code: ErrorCode.LLM_RATE_LIMITED });
    });
    const res = await post(`${base}/agents/bot/run`, { input: 'q' });
    expect(res.status).toBe(429);
  });

  it('passes the authenticated user id and an abort signal to the run', async () => {
    const { base, run } = await start(async () => runResult(), {
      auth: () => ({ userId: 'user-7' }),
    });
    await post(`${base}/agents/bot/run`, { input: 'q' });
    expect(run.mock.calls[0][1].userId).toBe('user-7');
    expect(run.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('answers rate-limited requests with 429 instead of 500', async () => {
    const { base } = await start(async () => runResult(), {
      rateLimit: { max: 1, timeWindow: 60_000 },
    });
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const limited = await fetch(`${base}/health`);
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('does not expose agent instructions in the agent list', async () => {
    const { base } = await start(async () => runResult());
    const body = await (await fetch(`${base}/agents`)).json();
    expect(JSON.stringify(body)).not.toContain('secret system prompt');
  });

  it('rejects a non-positive swarm timeout', async () => {
    const swarms = {
      team: { name: 'team', strategy: 'round-robin', agents: [agent] },
    } as unknown as CogitatorPluginOptions['swarms'];
    const { base } = await start(async () => runResult(), { swarms });
    const res = await post(`${base}/swarms/team/run`, { input: 'go', timeout: 0 });
    expect(res.status).toBe(400);
  });

  it('stores thread message metadata on the memory entry', async () => {
    const memory = { addEntry: vi.fn(async () => ({ success: true, data: {} })) };
    const { base } = await start(async () => runResult(), {}, memory);
    const res = await post(`${base}/threads/t1/messages`, {
      role: 'user',
      content: 'hello',
      metadata: { source: 'import' },
    });
    expect(res.status).toBe(201);
    expect(memory.addEntry).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { source: 'import' } })
    );
  });
});

describe('plugin agent streaming', () => {
  it('delivers tokens produced after the request body was consumed', async () => {
    const { base } = await start(async (options) => {
      await tick();
      options.onToken?.('Hello');
      await tick();
      options.onToken?.(' world');
      return runResult('Hello world');
    });

    const raw = await (await post(`${base}/agents/bot/stream`, { input: 'hi' })).text();
    const events = parseEvents(raw);
    expect(events.filter((e) => e.type === 'text-delta').map((e) => e.delta)).toEqual([
      'Hello',
      ' world',
    ]);
    expect(events.at(-1)?.type).toBe('finish');
    expect(raw.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('correlates tool call ids and splits text blocks around tool calls', async () => {
    const { base } = await start(async (options) => {
      options.onToken?.('Checking.');
      options.onToolCall?.({ id: 'call_1', name: 'search', arguments: { q: 'x' } });
      await tick();
      options.onToolResult?.({ callId: 'call_1', name: 'search', result: 1 });
      options.onToken?.('Done.');
      return runResult('Checking.Done.');
    });

    const events = parseEvents(
      await (await post(`${base}/agents/bot/stream`, { input: 'q' })).text()
    );
    expect(events.map((e) => e.type)).toEqual([
      'start',
      'text-start',
      'text-delta',
      'text-end',
      'tool-call-start',
      'tool-call-delta',
      'tool-call-end',
      'tool-result',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ]);
    expect(events.find((e) => e.type === 'tool-call-start')?.id).toBe('call_1');
    expect(events.find((e) => e.type === 'tool-result')?.toolCallId).toBe('call_1');
  });

  it('sends the final output when no tokens were streamed', async () => {
    const { base } = await start(async () => runResult('complete answer'));
    const events = parseEvents(
      await (await post(`${base}/agents/bot/stream`, { input: 'q' })).text()
    );
    expect(events.filter((e) => e.type === 'text-delta').map((e) => e.delta)).toEqual([
      'complete answer',
    ]);
  });

  it('keeps headers set by hooks on the SSE response', async () => {
    const { base } = await start(
      async () => runResult('x'),
      {},
      null,
      (instance) => {
        instance.addHook('onRequest', async (_request, reply) => {
          reply.header('access-control-allow-origin', 'https://app.example');
        });
      }
    );
    const res = await post(`${base}/agents/bot/stream`, { input: 'q' });
    await res.text();
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(res.headers.get('content-type')).toBe('text/event-stream');
  });

  it('aborts the run when the client disconnects', async () => {
    let signal: AbortSignal | undefined;
    const { base } = await start(
      (options) =>
        new Promise((_resolve, reject) => {
          signal = options.signal;
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          options.onToken?.('tick');
        })
    );

    const req = httpRequest(new URL(`${base}/agents/bot/stream`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    req.on('response', (res) => res.once('data', () => req.destroy()));
    req.on('error', () => {});
    req.end(JSON.stringify({ input: 'hi' }));

    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  });
});

describe('plugin workflow routes', () => {
  const failing = new WorkflowBuilder('failing')
    .addNode('boom', async () => {
      throw new Error('node exploded');
    })
    .build();
  const workflows = { failing } as unknown as CogitatorPluginOptions['workflows'];

  it('returns 500 WORKFLOW_FAILED when the workflow fails', async () => {
    const { base } = await start(async () => runResult(), { workflows });
    const res = await post(`${base}/workflows/failing/run`, {});
    expect(res.status).toBe(500);
    expect((await res.json()).error).toEqual({
      message: 'Workflow failed: node exploded',
      code: 'WORKFLOW_FAILED',
    });
  });

  it('streams an error instead of workflow_completed on failure', async () => {
    const { base } = await start(async () => runResult(), { workflows });
    const events = parseEvents(await (await post(`${base}/workflows/failing/stream`, {})).text());
    expect(events.some((e) => e.type === 'workflow' && e.event === 'workflow_completed')).toBe(
      false
    );
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'WORKFLOW_FAILED' });
  });

  it('rejects invalid workflow options', async () => {
    const { base } = await start(async () => runResult(), { workflows });
    const res = await post(`${base}/workflows/failing/run`, { options: { maxConcurrency: 0 } });
    expect(res.status).toBe(400);
  });
});

interface Client {
  messages: WebSocketResponse[];
  send: (message: unknown) => void;
}

function connect(url: string, headers: Record<string, string> = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    sockets.push(socket);
    const messages: WebSocketResponse[] = [];
    socket.on('message', (data) => messages.push(JSON.parse(data.toString()) as WebSocketResponse));
    socket.on('open', () =>
      resolve({ messages, send: (message) => socket.send(JSON.stringify(message)) })
    );
    socket.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    socket.on('error', reject);
  });
}

const runMessage = (id: string) => ({
  type: 'run',
  id,
  payload: { type: 'agent', name: 'bot', input: 'hello' },
});

describe('plugin WebSocket', () => {
  it('stop aborts the running agent', async () => {
    let signal: AbortSignal | undefined;
    const { ws } = await start(
      (options) =>
        new Promise((_resolve, reject) => {
          signal = options.signal;
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      { enableWebSocket: true }
    );
    const client = await connect(ws);
    client.send(runMessage('r1'));
    await vi.waitFor(() => expect(signal).toBeDefined());

    client.send({ type: 'stop' });

    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    await vi.waitFor(() =>
      expect(client.messages.at(-1)).toMatchObject({ id: 'r1', payload: { type: 'cancelled' } })
    );
  });

  it('applies auth to the upgrade and forwards the user id', async () => {
    const { ws, run } = await start(async () => ({ output: 'ok' }), {
      enableWebSocket: true,
      auth: (request) => {
        if (request.headers.authorization !== 'Bearer good') throw new Error('nope');
        return { userId: 'u-1' };
      },
    });

    await expect(connect(ws)).rejects.toThrow('HTTP 401');

    const client = await connect(ws, { authorization: 'Bearer good' });
    client.send(runMessage('r1'));
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    expect(run.mock.calls[0][1].userId).toBe('u-1');
  });

  it('publishes run events to agent channel subscribers', async () => {
    const { ws } = await start(
      async (options) => {
        options.onToken?.('Hi');
        return { output: 'Hi' };
      },
      { enableWebSocket: true }
    );
    const observer = await connect(ws);
    observer.send({ type: 'subscribe', channel: 'agent:bot' });
    await vi.waitFor(() => expect(observer.messages[0]).toMatchObject({ type: 'subscribed' }));

    const runner = await connect(ws);
    runner.send(runMessage('r1'));

    await vi.waitFor(() =>
      expect(observer.messages.slice(1).map((m) => (m.payload as { type: string }).type)).toEqual([
        'token',
        'complete',
      ])
    );
    expect(observer.messages[1]).toMatchObject({ channel: 'agent:bot', id: 'r1' });
  });

  it('answers invalid messages and payloads with errors', async () => {
    const { ws, run } = await start(async () => ({ output: 'ok' }), { enableWebSocket: true });
    const client = await connect(ws);
    client.send(null);
    client.send({ type: 'run', id: 'r1', payload: { type: 'agent', name: 'bot', input: 5 } });

    await vi.waitFor(() =>
      expect(client.messages).toEqual([
        { type: 'error', error: 'Invalid message' },
        { type: 'error', id: 'r1', error: 'Invalid run payload' },
      ])
    );
    expect(run).not.toHaveBeenCalled();
  });
});
