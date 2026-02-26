import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Cogitator } from '@cogitator-ai/core';
import { OpenAIAdapter } from '../client/openai-adapter';
import { registerAssistantRoutes } from '../server/routes/assistants';
import { registerThreadRoutes } from '../server/routes/threads';
import { registerFileRoutes } from '../server/routes/files';
import { createAuthMiddleware } from '../server/middleware/auth';
import { errorHandler, notFoundHandler } from '../server/middleware/error-handler';

const mockCogitator = {
  run: vi.fn(),
  tools: { getSchemas: vi.fn().mockReturnValue([]) },
} as unknown as Cogitator;

describe('OpenAI API Server', () => {
  let fastify: FastifyInstance;
  let adapter: OpenAIAdapter;

  beforeEach(async () => {
    fastify = Fastify();
    adapter = new OpenAIAdapter(mockCogitator);

    fastify.setErrorHandler(errorHandler);
    fastify.setNotFoundHandler(notFoundHandler);

    registerAssistantRoutes(fastify, adapter);
    registerThreadRoutes(fastify, adapter);
    registerFileRoutes(fastify, adapter);

    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
  });

  describe('Assistants Routes', () => {
    describe('POST /v1/assistants', () => {
      it('creates an assistant', async () => {
        const response = await fastify.inject({
          method: 'POST',
          url: '/v1/assistants',
          payload: {
            model: 'gpt-4',
            name: 'Test Assistant',
            instructions: 'You are helpful.',
          },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body.id).toMatch(/^asst_/);
        expect(body.object).toBe('assistant');
        expect(body.name).toBe('Test Assistant');
        expect(body.model).toBe('gpt-4');
      });

      it('creates an assistant with tools', async () => {
        const response = await fastify.inject({
          method: 'POST',
          url: '/v1/assistants',
          payload: {
            model: 'gpt-4',
            name: 'Tool Assistant',
            tools: [{ type: 'code_interpreter' }],
          },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body.tools).toContainEqual({ type: 'code_interpreter' });
      });
    });

    describe('GET /v1/assistants', () => {
      it('lists all assistants', async () => {
        await adapter.createAssistant({ model: 'gpt-4', name: 'First' });
        await adapter.createAssistant({ model: 'gpt-4', name: 'Second' });

        const response = await fastify.inject({
          method: 'GET',
          url: '/v1/assistants',
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.object).toBe('list');
        expect(body.data).toHaveLength(2);
      });

      it('supports pagination with limit', async () => {
        await adapter.createAssistant({ model: 'gpt-4', name: 'One' });
        await adapter.createAssistant({ model: 'gpt-4', name: 'Two' });
        await adapter.createAssistant({ model: 'gpt-4', name: 'Three' });

        const response = await fastify.inject({
          method: 'GET',
          url: '/v1/assistants?limit=2',
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.data).toHaveLength(2);
        expect(body.has_more).toBe(true);
      });

      it('returns empty list when no assistants', async () => {
        const response = await fastify.inject({
          method: 'GET',
          url: '/v1/assistants',
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.data).toHaveLength(0);
      });
    });

    describe('GET /v1/assistants/:assistant_id', () => {
      it('gets an assistant by id', async () => {
        const created = await adapter.createAssistant({
          model: 'gpt-4',
          name: 'Test',
        });

        const response = await fastify.inject({
          method: 'GET',
          url: `/v1/assistants/${created.id}`,
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.id).toBe(created.id);
        expect(body.name).toBe('Test');
      });

      it('returns 404 for non-existent assistant', async () => {
        const response = await fastify.inject({
          method: 'GET',
          url: '/v1/assistants/asst_nonexistent',
        });

        expect(response.statusCode).toBe(404);
        const body = response.json();
        expect(body.error.code).toBe('not_found');
      });
    });

    describe('POST /v1/assistants/:assistant_id', () => {
      it('updates an assistant', async () => {
        const created = await adapter.createAssistant({
          model: 'gpt-4',
          name: 'Original',
        });

        const response = await fastify.inject({
          method: 'POST',
          url: `/v1/assistants/${created.id}`,
          payload: {
            name: 'Updated',
            instructions: 'New instructions',
          },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.name).toBe('Updated');
        expect(body.instructions).toBe('New instructions');
      });

      it('returns 404 when updating non-existent assistant', async () => {
        const response = await fastify.inject({
          method: 'POST',
          url: '/v1/assistants/asst_nonexistent',
          payload: { name: 'Updated' },
        });

        expect(response.statusCode).toBe(404);
      });
    });

    describe('DELETE /v1/assistants/:assistant_id', () => {
      it('deletes an assistant', async () => {
        const created = await adapter.createAssistant({
          model: 'gpt-4',
          name: 'Test',
        });

        const response = await fastify.inject({
          method: 'DELETE',
          url: `/v1/assistants/${created.id}`,
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.deleted).toBe(true);
        expect(body.object).toBe('assistant.deleted');
      });

      it('returns 404 when deleting non-existent assistant', async () => {
        const response = await fastify.inject({
          method: 'DELETE',
          url: '/v1/assistants/asst_nonexistent',
        });

        expect(response.statusCode).toBe(404);
      });
    });
  });

  describe('Threads Routes', () => {
    describe('POST /v1/threads', () => {
      it('creates a thread', async () => {
        const response = await fastify.inject({
          method: 'POST',
          url: '/v1/threads',
          payload: {},
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body.id).toMatch(/^thread_/);
        expect(body.object).toBe('thread');
      });

      it('creates a thread with metadata', async () => {
        const response = await fastify.inject({
          method: 'POST',
          url: '/v1/threads',
          payload: { metadata: { key: 'value' } },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body.metadata).toEqual({ key: 'value' });
      });
    });

    describe('GET /v1/threads/:thread_id', () => {
      it('gets a thread by id', async () => {
        const thread = await adapter.createThread();

        const response = await fastify.inject({
          method: 'GET',
          url: `/v1/threads/${thread.id}`,
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.id).toBe(thread.id);
      });

      it('returns 404 for non-existent thread', async () => {
        const response = await fastify.inject({
          method: 'GET',
          url: '/v1/threads/thread_nonexistent',
        });

        expect(response.statusCode).toBe(404);
      });
    });

    describe('DELETE /v1/threads/:thread_id', () => {
      it('deletes a thread', async () => {
        const thread = await adapter.createThread();

        const response = await fastify.inject({
          method: 'DELETE',
          url: `/v1/threads/${thread.id}`,
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.deleted).toBe(true);
      });
    });

    describe('POST /v1/threads/:thread_id/messages', () => {
      it('adds a message to a thread', async () => {
        const thread = await adapter.createThread();

        const response = await fastify.inject({
          method: 'POST',
          url: `/v1/threads/${thread.id}/messages`,
          payload: {
            role: 'user',
            content: 'Hello!',
          },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body.id).toMatch(/^msg_/);
        expect(body.role).toBe('user');
        expect(body.thread_id).toBe(thread.id);
      });
    });

    describe('GET /v1/threads/:thread_id/messages', () => {
      it('lists messages in a thread', async () => {
        const thread = await adapter.createThread();
        await adapter.addMessage(thread.id, { role: 'user', content: 'First' });
        await adapter.addMessage(thread.id, { role: 'user', content: 'Second' });

        const response = await fastify.inject({
          method: 'GET',
          url: `/v1/threads/${thread.id}/messages`,
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.object).toBe('list');
        expect(body.data).toHaveLength(2);
      });
    });

    describe('GET /v1/threads/:thread_id/messages/:message_id', () => {
      it('gets a specific message', async () => {
        const thread = await adapter.createThread();
        const message = await adapter.addMessage(thread.id, {
          role: 'user',
          content: 'Test',
        });

        const response = await fastify.inject({
          method: 'GET',
          url: `/v1/threads/${thread.id}/messages/${message!.id}`,
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.id).toBe(message!.id);
      });
    });
  });
});

describe('Auth Middleware', () => {
  let fastify: FastifyInstance;

  beforeEach(async () => {
    fastify = Fastify();
  });

  afterEach(async () => {
    await fastify.close();
  });

  it('allows requests with valid API key', async () => {
    const authMiddleware = createAuthMiddleware({
      apiKeys: ['sk-test-key'],
      required: true,
    });

    fastify.addHook('preHandler', authMiddleware);
    fastify.get('/test', async () => ({ status: 'ok' }));
    await fastify.ready();

    const response = await fastify.inject({
      method: 'GET',
      url: '/test',
      headers: {
        authorization: 'Bearer sk-test-key',
      },
    });

    expect(response.statusCode).toBe(200);
  });

  it('rejects requests without API key', async () => {
    const authMiddleware = createAuthMiddleware({
      apiKeys: ['sk-test-key'],
      required: true,
    });

    fastify.addHook('preHandler', authMiddleware);
    fastify.get('/test', async () => ({ status: 'ok' }));
    await fastify.ready();

    const response = await fastify.inject({
      method: 'GET',
      url: '/test',
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects requests with invalid API key', async () => {
    const authMiddleware = createAuthMiddleware({
      apiKeys: ['sk-test-key'],
      required: true,
    });

    fastify.addHook('preHandler', authMiddleware);
    fastify.get('/test', async () => ({ status: 'ok' }));
    await fastify.ready();

    const response = await fastify.inject({
      method: 'GET',
      url: '/test',
      headers: {
        authorization: 'Bearer sk-wrong-key',
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('allows all requests when auth is not required', async () => {
    const authMiddleware = createAuthMiddleware({
      apiKeys: [],
      required: false,
    });

    fastify.addHook('preHandler', authMiddleware);
    fastify.get('/test', async () => ({ status: 'ok' }));
    await fastify.ready();

    const response = await fastify.inject({
      method: 'GET',
      url: '/test',
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('Error Handler', () => {
  let fastify: FastifyInstance;

  beforeEach(async () => {
    fastify = Fastify();
    fastify.setErrorHandler(errorHandler);
    fastify.setNotFoundHandler(notFoundHandler);
  });

  afterEach(async () => {
    await fastify.close();
  });

  it('handles thrown errors', async () => {
    fastify.get('/error', async () => {
      throw new Error('Test error');
    });
    await fastify.ready();

    const response = await fastify.inject({
      method: 'GET',
      url: '/error',
    });

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error).toBeDefined();
    expect(body.error.message).toContain('Test error');
  });

  it('handles 404 not found', async () => {
    await fastify.ready();

    const response = await fastify.inject({
      method: 'GET',
      url: '/nonexistent',
    });

    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error.type).toBe('invalid_request_error');
  });
});
