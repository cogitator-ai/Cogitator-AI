import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import Fastify from 'fastify';
import Koa from 'koa';
import type { Agent, AgentConfig } from '@cogitator-ai/types';
import { A2AServer } from '../server';
import { A2AClient } from '../client';
import { a2aExpress } from '../adapters/express';
import { a2aFastify } from '../adapters/fastify';
import { a2aHono } from '../adapters/hono';
import { a2aKoa } from '../adapters/koa';
import { a2aNext } from '../adapters/next';
import type { A2AStreamEvent, AgentRunResult, CogitatorLike } from '../types';

function mockAgent(name: string): Agent {
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

function runResult(output: string): AgentRunResult {
  return {
    output,
    runId: 'run',
    agentId: 'agent',
    threadId: 'thread',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: 0, duration: 1 },
    toolCalls: [],
  };
}

const answeringAgent: CogitatorLike = {
  run: async (agent) => runResult(`answered by ${(agent as Agent).name}`),
};

const tasksList = JSON.stringify({ jsonrpc: '2.0', method: 'tasks/list', params: {}, id: 1 });

async function listen(
  handler: http.RequestListener
): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function post(url: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: tasksList,
  });
}

describe('basePath', () => {
  const server = new A2AServer({
    agents: { helper: mockAgent('helper') },
    cogitator: answeringAgent,
    basePath: '/rpc',
  });

  it('is where the cards point without cardUrl', () => {
    expect(server.basePath).toBe('/rpc');
    expect(server.getAgentCard().url).toBe('/rpc');
  });

  it('keeps /a2a as the default', () => {
    const fallback = new A2AServer({
      agents: { helper: mockAgent('helper') },
      cogitator: answeringAgent,
    });
    expect(fallback.basePath).toBe('/a2a');
    expect(fallback.getAgentCard().url).toBe('/a2a');
  });

  it('must be a path', () => {
    expect(
      () =>
        new A2AServer({
          agents: { helper: mockAgent('helper') },
          cogitator: answeringAgent,
          basePath: 'rpc',
        })
    ).toThrow(/basePath must be a path/);
  });

  it('is served by the hono adapter', async () => {
    const app = a2aHono(server);
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: tasksList,
    };

    const served = await app.request('/rpc', init);
    const old = await app.request('/a2a', init);

    expect(await served.json()).toMatchObject({ result: { tasks: [] } });
    expect(old.status).toBe(404);
  });

  it('is served by the express adapter', async () => {
    const app = express();
    app.use(a2aExpress(server));
    const { url, close } = await listen(app);
    try {
      expect(await (await post(`${url}/rpc`)).json()).toMatchObject({ result: { tasks: [] } });
      expect((await post(`${url}/a2a`)).status).toBe(404);
    } finally {
      await close();
    }
  });

  it('is served by the fastify adapter', async () => {
    const app = Fastify();
    await app.register(a2aFastify(server));
    try {
      const served = await app.inject({
        method: 'POST',
        url: '/rpc',
        headers: { 'content-type': 'application/json' },
        payload: tasksList,
      });
      const old = await app.inject({
        method: 'POST',
        url: '/a2a',
        headers: { 'content-type': 'application/json' },
        payload: tasksList,
      });
      expect(served.json()).toMatchObject({ result: { tasks: [] } });
      expect(old.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('is served by the koa adapter', async () => {
    const app = new Koa();
    app.use(async (ctx, next) => {
      Reflect.set(ctx.request, 'body', JSON.parse(tasksList));
      await next();
    });
    app.use(a2aKoa(server));
    const { url, close } = await listen(app.callback());
    try {
      expect(await (await post(`${url}/rpc`)).json()).toMatchObject({ result: { tasks: [] } });
      expect((await post(`${url}/a2a`)).status).toBe(404);
    } finally {
      await close();
    }
  });
});

describe('A2AClient agentName', () => {
  async function multiAgentServer() {
    const server: A2AServer = new A2AServer({
      agents: { researcher: mockAgent('researcher'), writer: mockAgent('writer') },
      cogitator: answeringAgent,
      extendedCardGenerator: (agentName) => ({
        ...server.getAgentCard(agentName),
        description: `extended ${agentName}`,
      }),
    });
    const app = express();
    app.use(a2aExpress(server));
    return listen(app);
  }

  it('reaches the named agent of a multi-agent server', async () => {
    const { url, close } = await multiAgentServer();
    try {
      const client = new A2AClient(url, { agentName: 'writer' });
      const message = { role: 'user' as const, parts: [{ kind: 'text' as const, text: 'hi' }] };

      const task = await client.sendMessage(message);
      const events: A2AStreamEvent[] = [];
      for await (const event of client.sendMessageStream(message)) events.push(event);
      const card = await client.agentCard();
      const extended = await client.extendedAgentCard();

      expect(task.kind === 'task' && task.history?.at(-1)?.parts[0]).toEqual({
        kind: 'text',
        text: 'answered by writer',
      });
      expect(JSON.stringify(events)).toContain('answered by writer');
      expect(card.name).toBe('writer');
      expect(extended.description).toBe('extended writer');
    } finally {
      await close();
    }
  });

  it('talks to the first agent without agentName', async () => {
    const { url, close } = await multiAgentServer();
    try {
      const client = new A2AClient(url);
      const task = await client.sendMessage({
        role: 'user',
        parts: [{ kind: 'text', text: 'hi' }],
      });

      expect(task.kind === 'task' && task.history?.at(-1)?.parts[0]).toEqual({
        kind: 'text',
        text: 'answered by researcher',
      });
      expect((await client.agentCard()).name).toBe('researcher');
    } finally {
      await close();
    }
  });

  it('rejects an agent the server does not advertise', async () => {
    const { url, close } = await multiAgentServer();
    try {
      await expect(new A2AClient(url, { agentName: 'editor' }).agentCard()).rejects.toThrow(
        'Agent not found: editor'
      );
    } finally {
      await close();
    }
  });
});

describe('per-agent endpoints and cards in every adapter', () => {
  const server = new A2AServer({
    agents: { researcher: mockAgent('researcher'), writer: mockAgent('writer') },
    cogitator: answeringAgent,
  });
  const send = JSON.stringify({
    jsonrpc: '2.0',
    method: 'message/send',
    params: {
      message: {
        kind: 'message',
        messageId: 'm1',
        role: 'user',
        parts: [{ kind: 'text', text: 'hi' }],
      },
    },
    id: 1,
  });
  const json = { 'content-type': 'application/json' };

  function answeredBy(body: unknown): string | undefined {
    const result = (body as { result?: { status?: { message?: { parts: { text?: string }[] } } } })
      .result;
    return result?.status?.message?.parts[0]?.text;
  }

  it('hono serves the cards with absolute urls and routes by agent path', async () => {
    const app = a2aHono(server);
    const card = await (
      await app.request('http://agents.test/a2a/writer/.well-known/agent-card.json')
    ).json();
    const root = await (await app.request('http://agents.test/.well-known/agent-card.json')).json();
    const sent = await app.request('/a2a/writer', { method: 'POST', headers: json, body: send });
    const unknown = await app.request('/a2a/editor', { method: 'POST', headers: json, body: send });

    expect(card).toMatchObject({ name: 'writer', url: 'http://agents.test/a2a/writer' });
    expect(root).toMatchObject({ name: 'researcher', url: 'http://agents.test/a2a' });
    expect(answeredBy(await sent.json())).toBe('answered by writer');
    expect(unknown.status).toBe(404);
  });

  it('fastify routes by agent path', async () => {
    const app = Fastify();
    await app.register(a2aFastify(server));
    try {
      const card = await app.inject({
        method: 'GET',
        url: '/a2a/writer/.well-known/agent-card.json',
      });
      const sent = await app.inject({
        method: 'POST',
        url: '/a2a/writer',
        headers: json,
        payload: send,
      });
      expect(card.json()).toMatchObject({ name: 'writer' });
      expect(String(card.json().url)).toMatch(/\/a2a\/writer$/);
      expect(answeredBy(sent.json())).toBe('answered by writer');
    } finally {
      await app.close();
    }
  });

  it('koa routes by agent path', async () => {
    const app = new Koa();
    app.use(async (ctx, next) => {
      if (ctx.method === 'POST') Reflect.set(ctx.request, 'body', JSON.parse(send));
      await next();
    });
    app.use(a2aKoa(server));
    const { url, close } = await listen(app.callback());
    try {
      const card = await (await fetch(`${url}/a2a/writer/.well-known/agent-card.json`)).json();
      const sent = await fetch(`${url}/a2a/writer`, { method: 'POST', headers: json, body: send });
      expect(card).toMatchObject({ name: 'writer', url: `${url}/a2a/writer` });
      expect(answeredBy(await sent.json())).toBe('answered by writer');
    } finally {
      await close();
    }
  });

  it('next serves the agent of a dynamic [agent] segment', async () => {
    const { GET, POST } = a2aNext(server);
    const params = Promise.resolve({ agent: 'writer' });
    const card = await (await GET(new Request('http://agents.test/x'), { params })).json();
    const sent = await POST(
      new Request('http://agents.test/a2a/writer', { method: 'POST', headers: json, body: send }),
      { params }
    );
    const shared = await POST(
      new Request('http://agents.test/a2a', { method: 'POST', headers: json, body: send })
    );

    expect(card).toMatchObject({ name: 'writer', url: 'http://agents.test/a2a/writer' });
    expect(answeredBy(await sent.json())).toBe('answered by writer');
    expect(answeredBy(await shared.json())).toBe('answered by researcher');
  });
});
