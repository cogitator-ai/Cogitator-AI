import { describe, it, expect } from 'vitest';
import express from 'express';
import Fastify from 'fastify';
import Koa from 'koa';
import { A2AServer } from '../server';
import { A2AClient } from '../client';
import { a2aExpress } from '../adapters/express';
import { a2aFastify } from '../adapters/fastify';
import { a2aHono } from '../adapters/hono';
import { a2aKoa } from '../adapters/koa';
import { a2aNext } from '../adapters/next';
import { A2A_BODY_LIMIT } from '../adapters/body';
import { echoCogitator, listen, mockAgent, v1UserMessage } from './v1-helpers';

function newServer(): A2AServer {
  return new A2AServer({ agents: { helper: mockAgent('helper') }, cogitator: echoCogitator() });
}

const listTasks = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/list', params: {} });
const sendV1 = JSON.stringify({ message: v1UserMessage('hello') });
const tooLarge = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tasks/list',
  params: { pad: 'x'.repeat(A2A_BODY_LIMIT) },
});

describe('koa adapter bodies', () => {
  it('reads the body itself after async middleware, without a body parser', async () => {
    const app = new Koa();
    app.use(async (_ctx, next) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await next();
    });
    app.use(a2aKoa(newServer()));
    const { url, close } = await listen(app.callback());
    try {
      const response = await fetch(`${url}/a2a`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: listTasks,
      });
      expect(await response.json()).toMatchObject({ result: { tasks: [] } });
    } finally {
      await close();
    }
  });

  it('reads a body a parser skipped, leaving {} without rawBody', async () => {
    const app = new Koa();
    app.use(async (ctx, next) => {
      Reflect.set(ctx.request, 'body', {});
      await next();
    });
    app.use(a2aKoa(newServer()));
    const { url, close } = await listen(app.callback());
    try {
      const response = await fetch(`${url}/a2a/rest/message:send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/a2a+json', 'A2A-Version': '1.0' },
        body: sendV1,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        task: { status: { state: 'TASK_STATE_COMPLETED' } },
      });
    } finally {
      await close();
    }
  });

  it('refuses a body over the limit with 413', async () => {
    const app = new Koa();
    app.use(a2aKoa(newServer()));
    const { url, close } = await listen(app.callback());
    try {
      const response = await fetch(`${url}/a2a`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: tooLarge,
      });
      expect(response.status).toBe(413);
    } finally {
      await close();
    }
  });
});

describe('express adapter bodies', () => {
  it('parses an a2a+json body Express 4 parsers left as {} without _body', async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.body = {};
      next();
    });
    app.use(a2aExpress(newServer()));
    const { url, close } = await listen(app);
    try {
      const response = await fetch(`${url}/a2a/rest/message:send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/a2a+json', 'A2A-Version': '1.0' },
        body: sendV1,
      });
      expect(response.status).toBe(200);
    } finally {
      await close();
    }
  });

  it('takes the body a parser read upstream', async () => {
    const app = express();
    app.use(express.json());
    app.use(a2aExpress(newServer()));
    const { url, close } = await listen(app);
    try {
      const response = await fetch(`${url}/a2a`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: listTasks,
      });
      expect(await response.json()).toMatchObject({ result: { tasks: [] } });
    } finally {
      await close();
    }
  });

  it('refuses a body over the limit with 413', async () => {
    const app = express();
    app.use(a2aExpress(newServer()));
    const { url, close } = await listen(app);
    try {
      const response = await fetch(`${url}/a2a`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: tooLarge,
      });
      expect(response.status).toBe(413);
    } finally {
      await close();
    }
  });
});

describe('an empty JSON-RPC body is invalid JSON', () => {
  const expected = {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32700, message: 'Parse error: Invalid JSON body' },
  };
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '' };

  it('on fastify', async () => {
    const app = Fastify();
    await app.register(a2aFastify(newServer()));
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/a2a',
        headers: { 'content-type': 'application/json' },
        payload: '',
      });
      expect(response.json()).toEqual(expected);
    } finally {
      await app.close();
    }
  });

  it('on hono', async () => {
    const response = await a2aHono(newServer()).request('/a2a', init);
    expect(await response.json()).toEqual(expected);
  });

  it('on next', async () => {
    const { POST } = a2aNext(newServer());
    const response = await POST(new Request('http://agents.test/a2a', init));
    expect(await response.json()).toEqual(expected);
  });
});

describe('an agent named tasks', () => {
  it('lists its tasks with listTasksPage over HTTP+JSON', async () => {
    const server = new A2AServer({
      agents: { helper: mockAgent('helper'), tasks: mockAgent('tasks') },
      cogitator: echoCogitator(),
    });
    const app = express();
    app.use(a2aExpress(server));
    const { url, close } = await listen(app);
    try {
      const client = new A2AClient(url, { agentName: 'tasks', transport: 'HTTP+JSON' });
      await client.sendMessage({ role: 'user', parts: [{ kind: 'text', text: 'hi' }] });
      const page = await client.listTasksPage();
      expect(page.tasks).toHaveLength(1);
      expect(page.totalSize).toBe(1);
    } finally {
      await close();
    }
  });
});
