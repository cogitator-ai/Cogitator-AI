import { describe, expect, it, vi } from 'vitest';
import {
  ConformanceTriggers,
  MAX_TRIGGER_BODY_BYTES,
  handleTriggerRoute,
  listInboxRoute,
  patchInboxRoute,
  triggerRequestOf,
} from '../index.js';
import { generateOpenAPISpec } from '../openapi.js';

const request = (rawBody: string | Uint8Array) =>
  triggerRequestOf({ method: 'POST', headers: {}, rawBody, query: { token: ['a', 'b'] } });

describe('trigger routes', () => {
  it('reads the first value of a query parameter', () => {
    expect(request('').query).toEqual({ token: 'a' });
  });

  it('refuses a body over the limit before the trigger sees it', async () => {
    const host = new ConformanceTriggers();
    const answer = await handleTriggerRoute(
      host,
      'webhook',
      'daily.webhook',
      request(new Uint8Array(MAX_TRIGGER_BODY_BYTES + 1))
    );
    expect(answer.status).toBe(413);
    expect(host.requests).toHaveLength(0);
  });

  it('hides a failure of the manager', async () => {
    const host = new ConformanceTriggers();
    vi.spyOn(host, 'handle').mockRejectedValue(new Error('db password is hunter2'));
    const answer = await handleTriggerRoute(host, 'fire', 'daily.api', request('{}'));
    expect(answer).toEqual({
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
    });
  });

  it("lists and changes only the caller's items", async () => {
    const host = new ConformanceTriggers();
    const alice = await listInboxRoute(host, { kind: 'result', limit: '1' }, 'alice');
    expect(alice).toMatchObject({ status: 200, body: { nextBefore: 3 } });
    expect((await listInboxRoute(host, { kind: 'nonsense' }, 'alice')).status).toBe(400);
    expect((await listInboxRoute(host, { before: 'yesterday' }, 'alice')).status).toBe(400);
    expect((await patchInboxRoute(host, 'i-anon', { status: 'read' }, 'alice')).status).toBe(404);
    expect((await patchInboxRoute(host, 'i-anon', { status: 'read' }, undefined)).status).toBe(200);
    expect(
      (await patchInboxRoute(host, 'i-anon', { status: 'read', extra: 1 }, undefined)).status
    ).toBe(400);
  });

  it('documents the routes only for a server with triggers', () => {
    const ctx = { agents: {}, workflows: {}, swarms: {} };
    const without = generateOpenAPISpec(ctx, {});
    expect(without.paths['/inbox']).toBeUndefined();
    const spec = generateOpenAPISpec(ctx, { triggers: true });
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        '/triggers/{id}/fire',
        '/triggers/{id}/webhook',
        '/inbox',
        '/inbox/{id}',
      ])
    );
    expect(spec.components?.schemas?.InboxItem).toBeDefined();
  });
});
