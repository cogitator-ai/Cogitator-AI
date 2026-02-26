import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import request from 'supertest';
import { CogitatorServer } from '../server.js';
import type { CogitatorServerConfig } from '../types.js';

function createMockCogitator() {
  return {
    run: vi.fn().mockResolvedValue({
      output: 'mocked output',
      threadId: 'thread-1',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      toolCalls: [],
    }),
    memory: null,
  } as unknown as CogitatorServerConfig['cogitator'];
}

function createMockAgent() {
  return {
    name: 'test-agent',
    config: {
      instructions: 'You are helpful',
      tools: [
        {
          name: 'calculator',
          description: 'does math',
          parameters: { type: 'object', properties: {} },
        },
      ],
    },
  } as unknown as NonNullable<CogitatorServerConfig['agents']>[string];
}

describe('Route handlers', () => {
  let app: ReturnType<typeof express>;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    app = express();
    const cogitator = createMockCogitator();
    const agent = createMockAgent();

    const srv = new CogitatorServer({
      app,
      cogitator,
      agents: { 'test-agent': agent },
      config: { basePath: '/api', enableSwagger: false },
    });
    await srv.init();

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });

    const addr = server.address() as { port: number };
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('GET /api/health', () => {
    it('returns 200 with status ok', async () => {
      const res = await request(baseUrl).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(typeof res.body.uptime).toBe('number');
      expect(typeof res.body.timestamp).toBe('number');
    });
  });

  describe('GET /api/ready', () => {
    it('returns 200', async () => {
      const res = await request(baseUrl).get('/api/ready');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  describe('GET /api/agents', () => {
    it('lists available agents', async () => {
      const res = await request(baseUrl).get('/api/agents');
      expect(res.status).toBe(200);
      expect(res.body.agents).toHaveLength(1);
      expect(res.body.agents[0].name).toBe('test-agent');
      expect(res.body.agents[0].tools).toContain('calculator');
    });
  });

  describe('POST /api/agents/:name/run', () => {
    it('returns 404 for unknown agent', async () => {
      const res = await request(baseUrl).post('/api/agents/unknown/run').send({ input: 'hello' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('returns 400 when input is missing', async () => {
      const res = await request(baseUrl).post('/api/agents/test-agent/run').send({});
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_INPUT');
    });

    it('returns 200 with run result', async () => {
      const res = await request(baseUrl)
        .post('/api/agents/test-agent/run')
        .send({ input: 'hello' });
      expect(res.status).toBe(200);
      expect(res.body.output).toBe('mocked output');
      expect(res.body.usage.totalTokens).toBe(30);
    });
  });

  describe('GET /api/tools', () => {
    it('lists unique tools from all agents', async () => {
      const res = await request(baseUrl).get('/api/tools');
      expect(res.status).toBe(200);
      expect(res.body.tools).toHaveLength(1);
      expect(res.body.tools[0].name).toBe('calculator');
    });
  });

  describe('GET /api/workflows', () => {
    it('returns empty workflow list', async () => {
      const res = await request(baseUrl).get('/api/workflows');
      expect(res.status).toBe(200);
      expect(res.body.workflows).toHaveLength(0);
    });
  });

  describe('GET /api/swarms', () => {
    it('returns empty swarm list', async () => {
      const res = await request(baseUrl).get('/api/swarms');
      expect(res.status).toBe(200);
      expect(res.body.swarms).toHaveLength(0);
    });
  });

  describe('Threads without memory', () => {
    it('returns 503 when memory not configured', async () => {
      const res = await request(baseUrl).get('/api/threads/thread-123');
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('UNAVAILABLE');
    });
  });

  describe('404 handler', () => {
    it('returns 404 for unknown routes', async () => {
      const res = await request(baseUrl).get('/api/unknown-endpoint');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });
});

describe('CogitatorServer', () => {
  it('init() guard prevents double initialization', async () => {
    const app = express();
    const cogitator = createMockCogitator();
    const srv = new CogitatorServer({
      app,
      cogitator,
      config: { basePath: '/test', enableSwagger: false },
    });

    expect(srv.isInitialized).toBe(false);
    await srv.init();
    expect(srv.isInitialized).toBe(true);

    const useSpy = vi.spyOn(app, 'use');
    await srv.init();
    expect(useSpy).not.toHaveBeenCalled();
  });
});
