import { describe, expect, it } from 'vitest';
import Koa from 'koa';
import type { AddressInfo } from 'node:net';
import {
  ConformanceTriggers,
  TRIGGER_CONFORMANCE_CASES,
  checkTriggerConformanceCase,
  conformanceCaller,
  type TriggerConformanceCase,
} from '@cogitator-ai/server-shared';
import { cogitatorApp } from '../app.js';
import type { CogitatorAppOptions, CogitatorState } from '../types.js';
import { serve } from './local-server';

const cogitator = {} as CogitatorAppOptions['cogitator'];

async function listen(options: Omit<CogitatorAppOptions, 'cogitator'>): Promise<string> {
  const app = new Koa<CogitatorState>();
  const router = cogitatorApp({ cogitator, ...options });
  app.use(router.routes());
  app.use(router.allowedMethods());
  const { port } = (await serve(app)).address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function answer(testCase: TriggerConformanceCase, host: ConformanceTriggers) {
  const origin = await listen({
    ...(testCase.server?.triggers !== false && { triggers: host }),
    auth: (ctx) => conformanceCaller((name) => ctx.get(name) || undefined),
    ...(testCase.server?.anonymous && { anonymous: testCase.server.anonymous }),
  });
  const response = await fetch(`${origin}${testCase.path}`, {
    method: testCase.method,
    headers: testCase.headers,
    ...(testCase.body !== undefined && { body: testCase.body }),
  });
  return { status: response.status, body: await response.text() };
}

async function documentedPaths(triggers: ConformanceTriggers | undefined): Promise<string[]> {
  const origin = await listen({ enableSwagger: true, ...(triggers && { triggers }) });
  const spec = (await (await fetch(`${origin}/openapi.json`)).json()) as {
    paths: Record<string, unknown>;
  };
  return Object.keys(spec.paths);
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
    const origin = await listen({ triggers: host, bodyLimit: 1024 });
    const response = await fetch(`${origin}/triggers/daily.webhook/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(10 * 1024 * 1024 + 1),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Payload too large' },
    });
    expect(host.requests).toEqual([]);
  });

  it('reads a trigger body past the router body limit, up to its own', async () => {
    const host = new ConformanceTriggers();
    const origin = await listen({ triggers: host, bodyLimit: 1024 });
    const response = await fetch(`${origin}/triggers/daily.webhook/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(4096) }),
    });
    expect(response.status).toBe(401);
    expect(host.requests).toHaveLength(1);
  });

  it('documents the routes only when given triggers', async () => {
    const withTriggers = await documentedPaths(new ConformanceTriggers());
    expect(withTriggers).toEqual(
      expect.arrayContaining(['/triggers/{id}/fire', '/triggers/{id}/webhook', '/inbox'])
    );
    const without = await documentedPaths(undefined);
    expect(without).not.toContain('/triggers/{id}/fire');
    expect(without).not.toContain('/inbox');
  });
});
