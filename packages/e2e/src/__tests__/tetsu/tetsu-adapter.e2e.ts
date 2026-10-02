import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseSSEData } from '../../helpers/server-adapter-fixtures';

const TOKEN = 'e2e-token';
const SERVER = fileURLToPath(new URL('../../../fixtures/tetsu/server.ts', import.meta.url));
const hasBun = spawnSync('bun', ['--version']).status === 0;

interface RunningServer {
  baseUrl: string;
  provider: 'ollama' | 'google' | null;
  process: ChildProcess;
}

async function startServer(): Promise<RunningServer> {
  const child = spawn('bun', [SERVER], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout! });
  const first = await new Promise<string>((resolve, reject) => {
    lines.once('line', resolve);
    child.once('exit', (code) => reject(new Error(`Tetsu server exited with ${code}`)));
  });
  const { port, provider } = JSON.parse(first) as {
    port: number;
    provider: RunningServer['provider'];
  };
  return { baseUrl: `http://127.0.0.1:${port}/api`, provider, process: child };
}

async function stopServer(server: RunningServer | undefined): Promise<void> {
  const child = server?.process;
  if (child?.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}

function post(url: string, body: unknown, token: string | null = TOKEN): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

function get(url: string, token: string | null = TOKEN): Promise<Response> {
  return fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}

describe.skipIf(!hasBun)('Tetsu adapter on Bun', () => {
  let server: RunningServer | undefined;

  beforeAll(async () => {
    server = await startServer();
  });

  afterAll(async () => {
    await stopServer(server);
  });

  describe('HTTP contract', () => {
    it('answers health without credentials and refuses everything else', async () => {
      const health = await fetch(`${server!.baseUrl}/health`);
      expect(health.status).toBe(200);
      expect((await health.json()).status).toBe('ok');

      const refused = await get(`${server!.baseUrl}/agents`, null);
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual({
        status: 401,
        message: 'Unauthorized',
        error: 'UNAUTHORIZED',
      });
    });

    it('lists agents and the tools they carry', async () => {
      const agents = await (await get(`${server!.baseUrl}/agents`)).json();
      expect(agents.agents.map((agent: { name: string }) => agent.name)).toEqual([
        'chat',
        'calculator',
      ]);
      const tools = await (await get(`${server!.baseUrl}/tools`)).json();
      expect(tools.tools.map((tool: { name: string }) => tool.name)).toEqual(['multiply']);
    });

    it('validates bodies and refuses unknown agents in the Tetsu envelope', async () => {
      const invalid = await post(`${server!.baseUrl}/agents/chat/run`, { input: '' });
      expect(invalid.status).toBe(422);
      expect((await invalid.json()).error).toBe('VALIDATION_FAILED');

      const missing = await post(`${server!.baseUrl}/agents/ghost/run`, { input: 'hi' });
      expect(missing.status).toBe(404);
      expect((await missing.json()).error).toBe('AGENT_NOT_FOUND');
    });

    it("refuses another user's thread before calling the model", async () => {
      const res = await post(`${server!.baseUrl}/agents/chat/run`, {
        input: 'hi',
        threadId: 'someone-else-1',
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('THREAD_FORBIDDEN');
    });

    it('runs and streams a workflow', async () => {
      const run = await post(`${server!.baseUrl}/workflows/pipeline/run`, {
        input: { text: 'tetsu' },
      });
      expect(run.status).toBe(200);
      expect((await run.json()).state.text).toBe('TETSU!');

      const stream = await post(`${server!.baseUrl}/workflows/pipeline/stream`, {
        input: { text: 'bun' },
      });
      const raw = await stream.text();
      const events = parseSSEData(raw);
      expect(events.filter((event) => event.type === 'workflow').map((e) => e.event)).toEqual([
        'node_started',
        'node_completed',
        'node_started',
        'node_completed',
        'workflow_completed',
      ]);
      expect(raw.trim().endsWith('data: [DONE]')).toBe(true);
    });

    it('hides the detail of a failed workflow', async () => {
      const res = await post(`${server!.baseUrl}/workflows/failing/run`, {});
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).not.toContain('hunter2');
      expect(JSON.parse(text).error).toBe('INTERNAL_SERVER_ERROR');
    });
  });

  describe('live LLM', () => {
    const live = () => server?.provider ?? null;

    it('runs an agent and keeps the conversation in its thread', async (ctx) => {
      if (!live()) return ctx.skip();

      const res = await post(`${server!.baseUrl}/agents/chat/run`, {
        input: 'What is the capital of France? Answer with one word.',
        threadId: 'e2e-capital',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.output.toLowerCase()).toContain('paris');
      expect(body.threadId).toBe('e2e-capital');
      expect(body.usage.totalTokens).toBeGreaterThan(0);

      const thread = await (await get(`${server!.baseUrl}/threads/e2e-capital`)).json();
      const roles = thread.messages.map((message: { role: string }) => message.role);
      expect(roles).toContain('user');
      expect(roles).toContain('assistant');

      const deleted = await fetch(`${server!.baseUrl}/threads/e2e-capital`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(deleted.status).toBe(204);
    });

    it('streams the answer token by token over SSE', async (ctx) => {
      if (!live()) return ctx.skip();

      const res = await post(`${server!.baseUrl}/agents/chat/stream`, {
        input: 'Say hello in three words.',
      });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const raw = await res.text();
      const events = parseSSEData(raw);
      expect(events[0].type).toBe('start');
      expect(events.some((event) => event.type === 'text-delta')).toBe(true);
      expect(events.at(-1)?.type).toBe('finish');
      expect(raw.trim().endsWith('data: [DONE]')).toBe(true);
    });

    it('streams tool calls with their results', async (ctx) => {
      if (live() !== 'google') return ctx.skip();

      const res = await post(`${server!.baseUrl}/agents/calculator/stream`, {
        input: 'Use the multiply tool to compute 12 times 34.',
      });
      const events = parseSSEData(await res.text());
      const calls = events.filter((event) => event.type === 'tool-call-start');
      const results = events.filter((event) => event.type === 'tool-result');
      expect(calls.length).toBeGreaterThan(0);
      expect(results.map((result) => result.toolCallId)).toEqual(calls.map((call) => call.id));
      expect(JSON.stringify(results)).toContain('408');
    });

    it('runs an agent over the WebSocket', async (ctx) => {
      if (!live()) return ctx.skip();

      const url = new URL(`${server!.baseUrl}/ws`);
      url.protocol = 'ws:';
      url.searchParams.set('token', TOKEN);
      const socket = new WebSocket(url);
      const frames: Array<{
        type: string;
        payload?: { type: string; result?: { output: string } };
      }> = [];
      const complete = new Promise<void>((resolve, reject) => {
        socket.addEventListener('message', (event) => {
          const frame = JSON.parse(String(event.data));
          frames.push(frame);
          if (frame.type === 'error') reject(new Error(frame.error));
          if (frame.payload?.type === 'complete') resolve();
        });
        socket.addEventListener('error', () => reject(new Error('socket failed')));
      });
      await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));

      socket.send(
        JSON.stringify({
          type: 'run',
          id: 'ws-1',
          payload: { type: 'agent', name: 'chat', input: 'Reply with the word pong.' },
        })
      );
      await complete;
      socket.close();

      expect(frames.some((frame) => frame.payload?.type === 'token')).toBe(true);
      expect(frames.at(-1)?.payload?.result?.output.toLowerCase()).toContain('pong');
    });
  });
});
