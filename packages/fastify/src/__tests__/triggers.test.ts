import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  ConformanceTriggers,
  TRIGGER_CONFORMANCE_CASES,
  checkTriggerConformanceCase,
  conformanceCaller,
  type TriggerConformanceCase,
} from '@cogitator-ai/server-shared';
import { cogitatorPlugin } from '../plugin.js';
import type { CogitatorPluginOptions } from '../types.js';

const cogitator = {} as CogitatorPluginOptions['cogitator'];

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(options: Omit<CogitatorPluginOptions, 'cogitator'>): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  app = instance;
  await instance.register(cogitatorPlugin, { cogitator, prefix: '/api', ...options });
  return instance;
}

async function start(options: Omit<CogitatorPluginOptions, 'cogitator'>): Promise<string> {
  return (await build(options)).listen({ port: 0, host: '127.0.0.1' });
}

async function answer(testCase: TriggerConformanceCase, host: ConformanceTriggers) {
  const address = await start({
    ...(testCase.server?.triggers !== false && { triggers: host }),
    auth: (request) => conformanceCaller((name) => request.headers[name]?.toString()),
    ...(testCase.server?.anonymous && { anonymous: testCase.server.anonymous }),
  });
  const response = await fetch(`${address}/api${testCase.path}`, {
    method: testCase.method,
    headers: testCase.headers,
    ...(testCase.body !== undefined && { body: testCase.body }),
  });
  return { status: response.status, body: await response.text() };
}

interface Document {
  paths: Record<string, Record<string, { tags?: string[]; security?: unknown[] }>>;
  components?: { schemas?: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
}

async function document(triggers: ConformanceTriggers | undefined): Promise<Document> {
  app = Fastify({ logger: false });
  await app.register(cogitatorPlugin, {
    cogitator,
    prefix: '/api',
    enableSwagger: true,
    ...(triggers && { triggers }),
  });
  await app.ready();
  const response = await app.inject({ method: 'GET', url: '/api/docs/json' });
  expect(response.statusCode).toBe(200);
  return response.json<Document>();
}

describe('trigger and inbox routes', () => {
  it.each(TRIGGER_CONFORMANCE_CASES.map((testCase) => [testCase.name, testCase] as const))(
    '%s',
    async (_name, testCase) => {
      const host = new ConformanceTriggers();
      const response = await answer(testCase, host);
      expect(checkTriggerConformanceCase(testCase, response, host)).toEqual([]);
    }
  );

  it('refuses a trigger body over the limit with 413', async () => {
    const host = new ConformanceTriggers();
    const instance = await build({ triggers: host });
    const response = await instance.inject({
      method: 'POST',
      url: '/api/triggers/daily.webhook/webhook',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(10 * 1024 * 1024 + 1),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Payload too large' },
    });
    expect(host.requests).toEqual([]);
  });

  it('reads a trigger body past the default body limit, up to its own', async () => {
    const host = new ConformanceTriggers();
    const address = await start({ triggers: host });
    const response = await fetch(`${address}/api/triggers/daily.webhook/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x'.repeat(2 * 1024 * 1024),
    });
    expect(response.status).toBe(401);
    expect(host.requests).toHaveLength(1);
  });

  it.each([
    ['without a content type', undefined],
    ['as multipart', 'multipart/form-data; boundary=x'],
  ])('hands the trigger a body sent %s as it came', async (_name, contentType) => {
    const host = new ConformanceTriggers();
    const instance = await build({ triggers: host });
    const body = '--x\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--x--\r\n';
    const response = await instance.inject({
      method: 'POST',
      url: '/api/triggers/daily.webhook/webhook',
      headers: contentType === undefined ? {} : { 'content-type': contentType },
      payload: Buffer.from(body),
    });
    expect(response.statusCode).toBe(401);
    const received = host.requests[0]?.request.rawBody;
    expect(received && Buffer.from(received).toString()).toBe(body);
  });

  it('documents the routes only when given triggers', async () => {
    const withTriggers = await document(new ConformanceTriggers());
    expect(Object.keys(withTriggers.paths)).toEqual(
      expect.arrayContaining([
        '/api/triggers/{id}/fire',
        '/api/triggers/{id}/webhook',
        '/api/inbox',
        '/api/inbox/{id}',
      ])
    );
    expect(withTriggers.paths['/api/inbox']?.get?.tags).toEqual(['triggers']);
    expect(withTriggers.components?.schemas).toHaveProperty('InboxItem');
    expect(withTriggers.components?.securitySchemes).toHaveProperty('triggerToken');

    const without = await document(undefined);
    expect(Object.keys(without.paths)).not.toContain('/api/triggers/{id}/fire');
    expect(Object.keys(without.paths)).not.toContain('/api/inbox');
  });
});
