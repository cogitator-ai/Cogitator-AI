import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { StreamEventSchema } from '@cogitator-ai/server-shared';
import { cogitatorPlugin } from '../plugin.js';
import type { CogitatorPluginOptions } from '../types.js';

type Options = CogitatorPluginOptions;

interface Operation {
  responses: Record<string, unknown>;
  requestBody?: {
    content: Record<string, { schema: { properties: Record<string, unknown> } }>;
  };
}

interface Document {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, { discriminator?: { mapping: Record<string, string> } }> };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function document(): Promise<Document> {
  app = Fastify({ logger: false });
  await app.register(cogitatorPlugin, {
    cogitator: {} as Options['cogitator'],
    agents: { bot: { name: 'bot', config: { tools: [] } } } as unknown as Options['agents'],
    prefix: '/api',
    enableSwagger: true,
  });
  await app.ready();
  const response = await app.inject({ method: 'GET', url: '/api/docs/json' });
  expect(response.statusCode).toBe(200);
  return response.json<Document>();
}

describe('swagger document', () => {
  it('documents the stream protocol: its components and the body of every stream route', async () => {
    const doc = await document();
    const events = StreamEventSchema.options.map((option) => option.shape.type.value);

    expect(Object.keys(doc.components.schemas.StreamEvent?.discriminator?.mapping ?? {})).toEqual(
      events
    );
    for (const path of ['/api/agents/{name}/stream', '/api/agents/{name}/resume/stream']) {
      expect(doc.paths[path]?.post?.responses['200'], path).toMatchObject({
        content: {
          'text/event-stream': { schema: { $ref: '#/components/schemas/StreamEvent' } },
        },
      });
    }
    expect(doc.paths['/api/agents/{name}/run']?.post?.responses['200']).not.toHaveProperty(
      'content.text/event-stream'
    );
  });

  it('documents the multitask strategy of runs and the answers of resumes', async () => {
    const doc = await document();
    const body = (path: string) =>
      doc.paths[path]?.post?.requestBody?.content['application/json']?.schema.properties;

    for (const path of ['/api/agents/{name}/run', '/api/agents/{name}/stream']) {
      expect(body(path)?.multitaskStrategy, path).toMatchObject({
        type: 'string',
        enum: ['enqueue', 'reject', 'interrupt', 'rollback'],
      });
    }
    for (const path of ['/api/agents/{name}/resume', '/api/agents/{name}/resume/stream']) {
      expect(body(path)?.responses, path).toMatchObject({ type: 'object' });
    }
  });
});
