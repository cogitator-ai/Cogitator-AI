import { describe, expect, it, vi } from 'vitest';
import type { InboxItem } from '@cogitator-ai/types';
import {
  ConformanceTriggers,
  MAX_TRIGGER_BODY_BYTES,
  handleTriggerRoute,
  listInboxRoute,
  patchInboxRoute,
  triggerRequestOf,
  type TriggersHost,
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
    expect(
      (await patchInboxRoute(host, 'i-anon', { status: 'read' }, undefined, 'allow')).status
    ).toBe(200);
    expect(
      (await patchInboxRoute(host, 'i-anon', { status: 'read', extra: 1 }, undefined, 'allow'))
        .status
    ).toBe(400);
  });

  it('closes the inbox to callers without a user id unless anonymous is allowed explicitly', async () => {
    const host = new ConformanceTriggers();
    for (const anonymous of [undefined, 'deny'] as const) {
      expect(await listInboxRoute(host, {}, undefined, anonymous)).toMatchObject({
        status: 401,
        body: { error: { code: 'UNAUTHORIZED' } },
      });
      expect(
        (await patchInboxRoute(host, 'i-anon', { status: 'read' }, undefined, anonymous)).status
      ).toBe(401);
    }
    expect(await listInboxRoute(host, {}, undefined, 'allow')).toMatchObject({ status: 200 });
    expect((await listInboxRoute(host, {}, 'alice')).status).toBe(200);
  });

  it('pages by the time and id of the last item, so items of one millisecond are all shown', async () => {
    const items: InboxItem[] = ['a', 'b', 'c'].map((id) => ({
      id,
      kind: 'result',
      title: id,
      summary: '',
      status: 'unread',
      createdAt: 5,
      userId: 'u',
    }));
    const host: TriggersHost = {
      handle: async () => ({ status: 404, body: {} }),
      inbox: {
        list: async (filter) =>
          items
            .filter(
              (item) =>
                filter?.before === undefined ||
                item.createdAt < filter.before ||
                (filter.beforeId !== undefined &&
                  item.createdAt === filter.before &&
                  item.id < filter.beforeId)
            )
            .sort((a, b) => (a.id < b.id ? 1 : -1))
            .slice(0, filter?.limit ?? 50),
        get: async () => null,
        update: async () => null,
      },
    };
    const seen: string[] = [];
    let query: Record<string, string> = { limit: '1' };
    for (let page = 0; page < 5; page++) {
      const answer = await listInboxRoute(host, query, 'u');
      const body = answer.body as {
        items: InboxItem[];
        nextBefore?: number;
        nextBeforeId?: string;
      };
      seen.push(...body.items.map((item) => item.id));
      if (body.nextBefore === undefined || body.nextBeforeId === undefined) break;
      query = { limit: '1', before: String(body.nextBefore), beforeId: body.nextBeforeId };
    }
    expect(seen).toEqual(['c', 'b', 'a']);
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
