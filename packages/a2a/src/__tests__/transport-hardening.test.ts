import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Agent, AgentConfig } from '@cogitator-ai/types';

const dnsOverrides = vi.hoisted(() => new Map<string, string>());

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  const lookup = ((
    hostname: string,
    options: import('node:dns').LookupAllOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      addresses: import('node:dns').LookupAddress[]
    ) => void
  ) => {
    const override = dnsOverrides.get(hostname);
    if (override) {
      callback(null, [{ address: override, family: override.includes(':') ? 6 : 4 }]);
      return;
    }
    actual.lookup(hostname, options, callback);
  }) as typeof actual.lookup;
  return { ...actual, lookup, default: { ...actual, lookup } };
});

const { A2AServer } = await import('../server');
const { A2AClient } = await import('../client');
const { A2AError } = await import('../errors');
const { a2aExpress } = await import('../adapters/express');
const { a2aHono } = await import('../adapters/hono');
const {
  InMemoryPushNotificationStore,
  PushNotificationSender,
  isPrivateAddress,
  validateWebhookUrl,
} = await import('../push-notifications');
type AgentRunResult = import('../types').AgentRunResult;
type A2AStreamEvent = import('../types').A2AStreamEvent;
type A2ATask = import('../types').A2ATask;
const { userMessage } = await import('./helpers');
type CogitatorLike = import('../types').CogitatorLike;

function mockAgent(name = 'helper'): Agent {
  const config: AgentConfig = { name, model: 'test', instructions: 'test', description: name };
  return {
    id: `agent_${name}`,
    name,
    config,
    model: config.model,
    instructions: config.instructions,
    tools: [],
    clone: vi.fn() as Agent['clone'],
    serialize: vi.fn() as Agent['serialize'],
  };
}

function runResult(output: string, extra?: Partial<AgentRunResult>): AgentRunResult {
  return {
    output,
    runId: 'run',
    agentId: 'agent',
    threadId: 'thread',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: 0, duration: 1 },
    toolCalls: [],
    ...extra,
  };
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('SSRF protection', () => {
  it.each([
    '127.0.0.2',
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '169.254.169.254',
    '172.31.255.255',
    '192.168.1.1',
    '224.0.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::7f00:1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
  ])('classifies %s as private', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'classifies %s as public',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    }
  );

  it.each([
    'http://127.0.0.2/hook',
    'http://127.1/hook',
    'http://2130706433/hook',
    'http://[::ffff:127.0.0.1]/hook',
    'http://[fd00::1]/hook',
    'http://100.64.10.10/hook',
    'http://api.localhost/hook',
    'http://metadata.internal/hook',
  ])('rejects webhook URL %s', (url) => {
    expect(() => validateWebhookUrl(url)).toThrow(/private\/internal/);
  });

  it.each(['https://hooks.example.com/a', 'http://8.8.8.8/hook', 'https://[2606:4700::1111]/x'])(
    'accepts webhook URL %s',
    (url) => {
      expect(() => validateWebhookUrl(url)).not.toThrow();
    }
  );

  describe('delivery', () => {
    let webhook: http.Server;
    let port: number;
    let received: number;
    let lastAuthorization: string | undefined;

    beforeAll(async () => {
      received = 0;
      webhook = http.createServer((req, res) => {
        received++;
        lastAuthorization = req.headers.authorization;
        if (req.url === '/redirect') {
          res.writeHead(302, { Location: '/target' });
          res.end();
          return;
        }
        req.resume();
        res.writeHead(200);
        res.end();
      });
      const url = await listen(webhook);
      port = Number(new URL(url).port);
    });

    afterAll(async () => {
      await close(webhook);
    });

    const event: A2ATask = {
      kind: 'task',
      id: 't1',
      contextId: 'c1',
      status: { state: 'completed', timestamp: new Date().toISOString() },
    };

    it('refuses hostnames that resolve to private addresses at connect time', async () => {
      dnsOverrides.set('rebind.example.com', '127.0.0.1');
      const store = new InMemoryPushNotificationStore();
      await store.create('t1', { url: `http://rebind.example.com:${port}/hook` });
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      received = 0;

      await new PushNotificationSender(store, false).notify(event);

      expect(received).toBe(0);
      expect(stderr.mock.calls.some(([line]) => String(line).includes('private/internal'))).toBe(
        true
      );
      stderr.mockRestore();
    });

    it('does not follow redirects', async () => {
      const store = new InMemoryPushNotificationStore();
      await store.create('t1', { url: `http://127.0.0.1:${port}/redirect` });
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      received = 0;

      await new PushNotificationSender(store, true).notify(event);

      expect(received).toBe(1);
      expect(stderr.mock.calls.some(([line]) => String(line).includes('HTTP 302'))).toBe(true);
      stderr.mockRestore();
    });

    it('sends bearer credentials from the authentication info', async () => {
      const store = new InMemoryPushNotificationStore();
      await store.create('t1', {
        url: `http://127.0.0.1:${port}/hook`,
        authentication: { schemes: ['OAuth2', 'Bearer'], credentials: 'at-123' },
      });

      await new PushNotificationSender(store, true).notify(event);

      expect(lastAuthorization).toBe('Bearer at-123');
    });
  });
});

describe('A2AClient transport', () => {
  let server: http.Server;
  let baseUrl: string;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  beforeAll(async () => {
    server = http.createServer((req, res) => handler(req, res));
    baseUrl = await listen(server);
  });

  afterAll(async () => {
    await close(server);
  });

  const status = (state: string) =>
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        kind: 'status-update',
        taskId: 't1',
        contextId: 'c1',
        status: { state, timestamp: '2026-01-01T00:00:00Z' },
        final: state === 'completed',
      },
    });
  const chunk = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: {
      kind: 'artifact-update',
      taskId: 't1',
      contextId: 'c1',
      artifact: { artifactId: 'a1', parts: [{ kind: 'text', text: 'x' }] },
      append: true,
    },
  });
  const client = (config: ConstructorParameters<typeof A2AClient>[1] = {}) =>
    new A2AClient(baseUrl, { rpcPath: '/a2a', ...config });

  it('parses CRLF-delimited SSE frames split across chunks', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${status('working')}\r`);
      setTimeout(() => {
        res.write(`\n\r\ndata: ${status('completed')}\r\n\r\n`);
        res.end();
      }, 20);
    };

    const events: A2AStreamEvent[] = [];
    for await (const event of client().sendMessageStream({ role: 'user', parts: [] })) {
      events.push(event);
    }

    expect(events.map((e) => (e.kind === 'status-update' ? e.status.state : e.kind))).toEqual([
      'working',
      'completed',
    ]);
  });

  it('applies the timeout to idle time, not total stream duration', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      let sent = 0;
      const interval = setInterval(() => {
        sent++;
        if (sent < 6) {
          res.write(`data: ${chunk}\n\n`);
          return;
        }
        clearInterval(interval);
        res.end(`data: ${status('completed')}\n\n`);
      }, 60);
    };

    const events: A2AStreamEvent[] = [];
    for await (const event of client({ timeout: 200 }).sendMessageStream({
      role: 'user',
      parts: [],
    })) {
      events.push(event);
    }

    expect(events.at(-1)?.kind).toBe('status-update');
    expect(events.filter((e) => e.kind === 'artifact-update')).toHaveLength(5);
  });

  it('fails when the stream stays idle longer than the timeout', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${status('working')}\n\n`);
    };

    const consume = async () => {
      for await (const _event of client({ timeout: 150 }).sendMessageStream({
        role: 'user',
        parts: [],
      })) {
        void _event;
      }
    };

    await expect(consume()).rejects.toThrow(/idle/);
  });

  it('surfaces JSON-RPC errors sent with a non-2xx status', async () => {
    handler = (_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Unauthorized' } })
      );
    };

    const error = await client()
      .getTask('t1')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(A2AError);
    expect((error as InstanceType<typeof A2AError>).code).toBe(-32000);
  });

  it('asTool reports input-required with the question and task id', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            kind: 'task',
            id: 'task_9',
            contextId: 'c',
            status: { state: 'input-required', timestamp: '' },
            history: [
              {
                kind: 'message',
                messageId: 'm1',
                role: 'user',
                parts: [{ kind: 'text', text: 'Book a flight' }],
              },
              {
                kind: 'message',
                messageId: 'm2',
                role: 'agent',
                parts: [{ kind: 'text', text: 'Which date?' }],
              },
            ],
            artifacts: [],
          },
        })
      );
    };

    const tool = client().asTool();
    const result = await tool.execute(
      { task: 'Book a flight' },
      { agentId: 'a', runId: 'r', signal: new AbortController().signal }
    );

    expect(result).toMatchObject({
      success: false,
      output: 'Which date?',
      taskId: 'task_9',
      state: 'input-required',
    });
  });

  it('asTool returns the latest answer of a multi-turn task', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            kind: 'task',
            id: 'task_9',
            contextId: 'c',
            status: { state: 'completed', timestamp: '' },
            history: [
              {
                kind: 'message',
                messageId: 'm1',
                role: 'agent',
                parts: [{ kind: 'text', text: 'old answer' }],
              },
              {
                kind: 'message',
                messageId: 'm2',
                role: 'agent',
                parts: [{ kind: 'text', text: 'new answer' }],
              },
            ],
            artifacts: [
              { artifactId: 'a1', parts: [{ kind: 'text', text: 'old answer' }] },
              { artifactId: 'a2', parts: [{ kind: 'text', text: 'new answer' }] },
            ],
          },
        })
      );
    };

    const tool = client().asTool();
    const result = await tool.execute(
      { task: 'x' },
      { agentId: 'a', runId: 'r', signal: new AbortController().signal }
    );
    expect(result).toEqual({ output: 'new answer', success: true, state: 'completed' });
  });

  it('asTool cancels the request when the run is aborted', async () => {
    handler = () => {};
    const controller = new AbortController();
    const tool = client({ timeout: 10_000 }).asTool();

    const pending = tool.execute(
      { task: 'x' },
      { agentId: 'a', runId: 'r', signal: controller.signal }
    );
    controller.abort();
    const result = await pending;

    expect(result.success).toBe(false);
  });
});

describe('framework adapters', () => {
  const bearerConfig = (cogitator: CogitatorLike) => ({
    agents: { helper: mockAgent() },
    cogitator,
    auth: { type: 'bearer' as const, validate: async (token: string) => token === 'secret' },
  });

  it('hono adapter enforces auth from the Authorization header', async () => {
    const app = a2aHono(new A2AServer(bearerConfig({ run: async () => runResult('hi') })));
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'tasks/list', params: {}, id: 1 });

    const denied = await app.request('/a2a', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const allowed = await app.request('/a2a', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
      body,
    });

    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toMatch(/^Bearer/);
    expect(((await denied.json()) as { error?: { code: number } }).error?.code).toBe(-32000);
    expect(((await allowed.json()) as { error?: unknown }).error).toBeUndefined();
  });

  it('hono adapter writes heartbeats while a streamed run is silent', async () => {
    const app = a2aHono(
      new A2AServer({
        agents: { helper: mockAgent() },
        cogitator: {
          run: () => new Promise((resolve) => setTimeout(() => resolve(runResult('late')), 120)),
        },
        sseHeartbeatMs: 20,
      })
    );
    const response = await app.request('/a2a', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'message/stream',
        params: { message: userMessage('hi') },
        id: 1,
      }),
    });
    const text = await response.text();

    expect(text.match(/^: keep-alive$/gm)?.length).toBeGreaterThanOrEqual(3);
    expect(text).not.toContain('[DONE]');
    expect(text.trimEnd().split('\n').at(-1)).toContain('"final":true');
  });

  it('hono adapter answers notifications with 204', async () => {
    const app = a2aHono(
      new A2AServer({
        agents: { helper: mockAgent() },
        cogitator: { run: async () => runResult('x') },
      })
    );
    const response = await app.request('/a2a', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tasks/list', params: {} }),
    });
    expect(response.status).toBe(204);
  });

  it('hono adapter keeps message/send as JSON even when SSE is accepted', async () => {
    const app = a2aHono(
      new A2AServer({
        agents: { helper: mockAgent() },
        cogitator: { run: async () => runResult('x') },
      })
    );
    const response = await app.request('/a2a', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'message/send',
        params: { message: userMessage('hi') },
        id: 1,
      }),
    });

    expect(response.headers.get('content-type')).toContain('application/json');
    expect(
      ((await response.json()) as { result: { status: { state: string } } }).result.status.state
    ).toBe('completed');
  });

  it('express adapter authenticates streams and aborts the run when the client disconnects', async () => {
    let runSignal: AbortSignal | undefined;
    const started = vi.fn();
    const server = new A2AServer(
      bearerConfig({
        run: (_agent, options) =>
          new Promise<AgentRunResult>((_resolve, reject) => {
            runSignal = options.signal;
            started();
            options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      })
    );
    const app = express();
    app.use(a2aExpress(server));
    const httpServer = http.createServer(app);
    const url = await listen(httpServer);

    try {
      const unauthorized = new A2AClient(url);
      const denied = async () => {
        for await (const _event of unauthorized.sendMessageStream({
          role: 'user',
          parts: [{ kind: 'text', text: 'hi' }],
        })) {
          void _event;
        }
      };
      await expect(denied()).rejects.toThrow('Unauthorized');

      const client = new A2AClient(url, { headers: { Authorization: 'Bearer secret' } });
      const controller = new AbortController();
      const stream = client.sendMessageStream(
        { role: 'user', parts: [{ kind: 'text', text: 'slow' }] },
        undefined,
        { signal: controller.signal }
      );
      const first = await stream.next();
      expect(first.value?.kind).toBe('task');
      await vi.waitFor(() => expect(started).toHaveBeenCalled());

      controller.abort();
      await stream.return(undefined);

      await vi.waitFor(() => expect(runSignal?.aborted).toBe(true));
    } finally {
      await close(httpServer);
    }
  });
});
