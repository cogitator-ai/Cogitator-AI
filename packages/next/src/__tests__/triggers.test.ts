import { describe, expect, it } from 'vitest';
import {
  ConformanceTriggers,
  TRIGGER_CONFORMANCE_CASES,
  checkTriggerConformanceCase,
  conformanceCaller,
  type TriggerConformanceCase,
} from '@cogitator-ai/server-shared';
import { createInboxHandler, createTriggerHandler } from '../handlers/triggers.js';

/**
 * Next serves triggers and the inbox through route handlers: `/triggers/<id>/<route>` is the
 * trigger handler with its `params`, `/inbox` the inbox `GET` and `/inbox/<id>` its `PATCH`.
 * Without triggers an app exports no such handler, so the route is Next's own `404`
 */
async function answer(testCase: TriggerConformanceCase, host: ConformanceTriggers) {
  const url = `http://localhost/api${testCase.path}`;
  const init: RequestInit = {
    method: testCase.method,
    ...(testCase.headers && { headers: testCase.headers }),
    ...(testCase.body !== undefined && { body: testCase.body }),
  };
  const path = testCase.path.replace(/\?.*$/, '');
  const trigger = /^\/triggers\/([^/]+)\/([^/]+)$/.exec(path);
  const item = /^\/inbox\/([^/]+)$/.exec(path);
  const inbox = createInboxHandler(host, {
    auth: (req) => conformanceCaller((name) => req.headers.get(name)),
    ...(testCase.server?.anonymous && { anonymous: testCase.server.anonymous }),
  });

  let response: Response;
  if (testCase.server?.triggers === false) {
    response = new Response(null, { status: 404 });
  } else if (trigger?.[1] && trigger[2] && testCase.method === 'POST') {
    response = await createTriggerHandler(host)(new Request(url, init), {
      params: Promise.resolve({ id: trigger[1], route: trigger[2] }),
    });
  } else if (path === '/inbox' && testCase.method === 'GET') {
    response = await inbox.GET(new Request(url, init));
  } else if (item?.[1] && testCase.method === 'PATCH') {
    response = await inbox.PATCH(new Request(url, init), { params: { id: item[1] } });
  } else {
    throw new Error(`No handler serves ${testCase.method} ${testCase.path}`);
  }
  return { status: response.status, body: await response.text() };
}

describe('trigger and inbox handlers', () => {
  it.each(TRIGGER_CONFORMANCE_CASES.map((testCase) => [testCase.name, testCase] as const))(
    '%s',
    async (_name, testCase) => {
      const host = new ConformanceTriggers();
      const response = await answer(testCase, host);
      expect(checkTriggerConformanceCase(testCase, response, host)).toEqual([]);
    }
  );

  it('answers a route other than fire and webhook with 404', async () => {
    const host = new ConformanceTriggers();
    const response = await createTriggerHandler(host)(
      new Request('http://localhost/api/triggers/daily.api/run', { method: 'POST', body: '{}' }),
      { params: { id: 'daily.api', route: 'run' } }
    );
    expect(response.status).toBe(404);
    expect(host.requests).toEqual([]);
  });

  it.each([
    ['declared', true],
    ['streamed', false],
  ])('refuses a trigger body over the limit with 413, %s', async (_name, declared) => {
    const host = new ConformanceTriggers();
    const bytes = new Uint8Array(10 * 1024 * 1024 + 1);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const init: RequestInit & { duplex?: 'half' } = declared
      ? { method: 'POST', body: bytes, headers: { 'content-length': String(bytes.byteLength) } }
      : { method: 'POST', body: stream, duplex: 'half' };
    const request = new Request('http://localhost/api/triggers/daily.webhook/webhook', init);
    const response = await createTriggerHandler(host)(request, {
      params: { id: 'daily.webhook', route: 'webhook' },
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Payload too large' },
    });
    expect(host.requests).toEqual([]);
  });

  it('turns away an anonymous caller from the inbox under anonymous deny', async () => {
    const inbox = createInboxHandler(new ConformanceTriggers(), {
      auth: (req) => conformanceCaller((name) => req.headers.get(name)),
      anonymous: 'deny',
    });
    const response = await inbox.GET(new Request('http://localhost/api/inbox'));
    expect(response.status).toBe(401);
  });
});
