import { describe, expect, test } from 'bun:test';
import { createApp, group } from '@tetsujs/core';
import type { BaseCtx } from '@tetsujs/core';
import { serve } from '@tetsujs/core/testing';
import { openapi } from '@tetsujs/openapi';
import { assertDescribed } from '@tetsujs/openapi/testing';
import {
  ConformanceTriggers,
  TRIGGER_CONFORMANCE_CASES,
  checkTriggerConformanceCase,
  conformanceCaller,
  type TriggerConformanceCase,
} from '@cogitator-ai/server-shared';
import { cogitatorController } from '../index.js';
import type { CogitatorDeps } from '../index.js';

const cogitator = {} as CogitatorDeps['cogitator'];
const info = { title: 'Cogitator', version: '1.0.0' };

function appOf(options: Omit<CogitatorDeps, 'cogitator'>) {
  return createApp({
    routes: group('/api', { children: [cogitatorController({ cogitator, ...options })] }),
    reportError: () => undefined,
  });
}

/**
 * The case as a Tetsu application answers it: the inbox schemas refuse a query or body that
 * breaks them with the validation envelope, `422 VALIDATION_FAILED`, as every Tetsu schema does.
 * The trigger routes validate nothing and answer as every adapter does
 */
function tetsuCase(testCase: TriggerConformanceCase): TriggerConformanceCase {
  if (!testCase.path.startsWith('/inbox') || testCase.expect.status !== 400) return testCase;
  return { ...testCase, expect: { ...testCase.expect, status: 422, code: 'VALIDATION_FAILED' } };
}

/** A body in the Tetsu envelope `{ status, message, error }` in the shared one the cases read */
function sharedEnvelope(body: string): string {
  try {
    const json: unknown = JSON.parse(body);
    if (typeof json === 'object' && json !== null && 'error' in json) {
      const { error, message } = json as { error: unknown; message?: unknown };
      if (typeof error === 'string') return JSON.stringify({ error: { code: error, message } });
    }
  } catch {
    return body;
  }
  return body;
}

/** The operation of the document a case's path is served by */
function operationOf(testCase: TriggerConformanceCase): string {
  const path = testCase.path
    .replace(/\?.*$/, '')
    .replace(/^\/triggers\/[^/]+\//, '/triggers/{id}/')
    .replace(/^\/inbox\/[^/]+$/, '/inbox/{id}');
  return `${testCase.method} /api${path}`;
}

/**
 * Whether the document describes the answer: every answer but a trigger's success, whose body
 * is whatever the fake trigger manager of the cases makes up, not a real firing
 */
function describable(testCase: TriggerConformanceCase, response: { status: number }): boolean {
  return testCase.path.startsWith('/inbox') || response.status >= 400;
}

async function answer(testCase: TriggerConformanceCase, host: ConformanceTriggers) {
  const app = appOf({
    ...(testCase.server?.triggers !== false && { triggers: host }),
    auth: (ctx: BaseCtx) => conformanceCaller((name) => ctx.req.headers.get(name)),
    ...(testCase.server?.anonymous && { anonymous: testCase.server.anonymous }),
  });
  const response = await serve(app)(`/api${testCase.path}`, {
    method: testCase.method,
    headers: testCase.headers,
    ...(testCase.body !== undefined && { body: testCase.body }),
  });
  const body = await response.text();
  if (testCase.server?.triggers !== false && describable(testCase, response)) {
    const described = new Response(body, { status: response.status, headers: response.headers });
    await assertDescribed(openapi(app, { info }).document, operationOf(testCase), described);
  }
  return { status: response.status, body: sharedEnvelope(body) };
}

describe('trigger and inbox routes', () => {
  for (const testCase of TRIGGER_CONFORMANCE_CASES) {
    test(testCase.name, async () => {
      const host = new ConformanceTriggers();
      const response = await answer(testCase, host);
      expect(checkTriggerConformanceCase(tetsuCase(testCase), response, host)).toEqual([]);
    });
  }

  test('answers the trigger routes in the shared envelope, not the Tetsu one', async () => {
    const request = serve(appOf({ triggers: new ConformanceTriggers() }));
    const response = await request('/api/triggers/missing.api/fire', { method: 'POST' });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'No trigger missing.api' },
    });
  });

  test('refuses a trigger body over the limit with 413', async () => {
    const host = new ConformanceTriggers();
    const request = serve(appOf({ triggers: host }));
    const response = await request('/api/triggers/daily.webhook/webhook', {
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

  test('reads a trigger body past the default body limit, up to its own', async () => {
    const host = new ConformanceTriggers();
    const request = serve(appOf({ triggers: host }));
    const response = await request('/api/triggers/daily.webhook/webhook', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x'.repeat(2 * 1024 * 1024),
    });
    expect(response.status).toBe(401);
    expect(host.requests).toHaveLength(1);
  });

  test('documents the routes only when given triggers', () => {
    const withTriggers = openapi(appOf({ triggers: new ConformanceTriggers() }), { info });
    expect(withTriggers.warnings).toEqual([]);
    expect(Object.keys(withTriggers.document.paths ?? {})).toEqual(
      expect.arrayContaining([
        '/api/triggers/{id}/fire',
        '/api/triggers/{id}/webhook',
        '/api/inbox',
        '/api/inbox/{id}',
      ])
    );

    const without = Object.keys(openapi(appOf({}), { info }).document.paths ?? {});
    expect(without).not.toContain('/api/triggers/{id}/fire');
    expect(without).not.toContain('/api/inbox');
  });
});
