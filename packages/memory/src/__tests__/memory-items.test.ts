import { describe, it, expect } from 'vitest';
import type { MemoryItemScope, NewMemoryItem } from '@cogitator-ai/types';
import { InMemoryAdapter } from '../adapters/memory';
import { MemoryItems, normalizeName, visibleIn } from '../memory-items';

const day = (n: number) => new Date(Date.UTC(2026, 0, n));
const scope: MemoryItemScope = { agentId: 'a', userId: 'u1' };

function said(fields: Partial<NewMemoryItem> & Pick<NewMemoryItem, 'content'>): NewMemoryItem {
  return {
    kind: 'fact',
    trust: 'user',
    confidence: 0.9,
    scope,
    evidence: [{ entryId: 'e1', quote: fields.content }],
    verified: true,
    saidAt: day(1),
    sessionAt: day(1),
    ...fields,
  };
}

function memory(now = day(30)) {
  const adapter = new InMemoryAdapter({ provider: 'memory' });
  return { adapter, items: new MemoryItems({ adapter, now: () => now }) };
}

describe('MemoryItems', () => {
  it('activates only what the user said with quotes that hold, or the application wrote', async () => {
    const { items } = memory();
    const [user, unquoted, model, system, unsure] = await items.write([
      said({ content: 'Ana lives in Porto' }),
      said({ content: 'Ana likes jazz', verified: false }),
      said({ content: 'Ana is a teacher', trust: 'model' }),
      said({ content: 'Plan is pro', trust: 'system', verified: false, evidence: [] }),
      said({ content: 'Ana may move', confidence: 0.4 }),
    ]);

    expect([user, unquoted, model, system, unsure].map((item) => item?.status)).toEqual([
      'active',
      'suggested',
      'suggested',
      'active',
      'suggested',
    ]);
  });

  it('merges an item said again instead of keeping it twice', async () => {
    const { items } = memory();
    await items.write([said({ content: 'Ana lives in Porto' })]);
    await items.write([
      said({ content: 'ana lives in porto.', evidence: [{ entryId: 'e2', quote: 'in Porto' }] }),
    ]);

    const [only, ...rest] = await items.query({ scope });
    expect(rest).toHaveLength(0);
    expect(only?.evidence.map((piece) => piece.entryId)).toEqual(['e1', 'e2']);
  });

  it('closes the state a newer one follows, keeping it for questions as of earlier', async () => {
    const { items } = memory();
    const [porto] = await items.write([
      said({
        content: 'Ana lives in Porto',
        subject: 'Ana',
        attribute: 'home city',
        value: 'Porto',
      }),
    ]);
    const [lisbon] = await items.write([
      said({
        content: 'Ana moved to Lisbon',
        subject: 'ana',
        attribute: 'Home  city',
        value: 'Lisbon',
        sessionAt: day(10),
        saidAt: day(10),
      }),
    ]);

    expect(lisbon?.slot).toBe(porto?.slot);
    expect(lisbon?.supersedes).toEqual([porto?.id]);
    expect((await items.query({ scope })).map((item) => item.value)).toEqual(['Lisbon']);
    expect((await items.query({ scope, asOf: day(5) })).map((item) => item.value)).toEqual([
      'Porto',
    ]);
    const closed = await items.get(porto!.id);
    expect(closed).toMatchObject({
      status: 'superseded',
      supersededBy: lisbon?.id,
      validTo: day(10),
    });
    expect((await items.history(scope, porto!.slot!)).map((item) => item.value)).toEqual([
      'Porto',
      'Lisbon',
    ]);
  });

  it('answers as of a date with what held and what memory had then', async () => {
    const { items } = memory(day(30));
    await items.write([
      said({
        content: 'Ana lives in Porto',
        subject: 'Ana',
        attribute: 'home city',
        value: 'Porto',
        recordedAt: day(1),
      }),
      said({
        content: 'Ana moved to Lisbon',
        subject: 'Ana',
        attribute: 'home city',
        value: 'Lisbon',
        sessionAt: day(10),
        recordedAt: day(10),
      }),
    ]);

    expect((await items.query({ scope, asOf: day(5) })).map((item) => item.value)).toEqual([
      'Porto',
    ]);
    expect((await items.query({ scope, asOf: day(20) })).map((item) => item.value)).toEqual([
      'Lisbon',
    ]);
  });

  it('keeps a flashback as history without closing the current state', async () => {
    const { items } = memory();
    await items.write([
      said({
        content: 'Ana lives in Lisbon',
        subject: 'Ana',
        attribute: 'home city',
        value: 'Lisbon',
        sessionAt: day(10),
      }),
    ]);
    const [porto] = await items.write([
      said({
        content: 'Back in early January Ana lived in Porto',
        subject: 'Ana',
        attribute: 'home city',
        value: 'Porto',
        sessionAt: day(12),
        about: { text: 'early January', start: day(2), end: day(9), precision: 'approximate' },
      }),
    ]);

    expect(porto?.validTo).toEqual(day(10));
    expect((await items.query({ scope })).map((item) => item.value)).toEqual(['Lisbon']);
    expect((await items.query({ scope, asOf: day(5) })).map((item) => item.value)).toEqual([
      'Porto',
    ]);
  });

  it('lets a suggested state close nothing until it is activated', async () => {
    const { items } = memory();
    await items.write([said({ content: 'Ana lives in Porto', subject: 'Ana', attribute: 'city' })]);
    const [moved] = await items.write([
      said({
        content: 'Ana lives in Lisbon',
        subject: 'Ana',
        attribute: 'city',
        trust: 'web',
        sessionAt: day(5),
      }),
    ]);

    expect((await items.query({ scope })).map((item) => item.content)).toEqual([
      'Ana lives in Porto',
    ]);
    await items.activate(moved!.id);
    expect((await items.query({ scope })).map((item) => item.content)).toEqual([
      'Ana lives in Lisbon',
    ]);
  });

  it('strengthens an opinion said again and weakens one a weaker source contradicts', async () => {
    const { items } = memory();
    const opinion = (value: string, fields: Partial<NewMemoryItem> = {}) =>
      said({
        kind: 'opinion',
        content: `Ana thinks the film is ${value}`,
        subject: 'Ana',
        attribute: 'film opinion',
        value,
        confidence: 0.7,
        ...fields,
      });
    const [first] = await items.write([opinion('great')]);
    await items.write([opinion('great', { content: 'Ana really thinks the film is great' })]);
    expect((await items.get(first!.id))?.confidence).toBeCloseTo(0.8);

    await items.write([opinion('dull', { trust: 'model' })]);
    expect((await items.get(first!.id))?.confidence).toBeCloseTo(0.6);
    expect((await items.query({ scope })).map((item) => item.value)).toEqual(['great']);
  });

  it('shows an item only to its user, project and thread', async () => {
    const { items } = memory();
    await items.write([
      said({ content: 'agent-wide', scope: { agentId: 'a' } }),
      said({ content: 'for u1', scope: { agentId: 'a', userId: 'u1' } }),
      said({ content: 'for u2', scope: { agentId: 'a', userId: 'u2' } }),
      said({ content: 'in t1', scope: { agentId: 'a', userId: 'u1', threadId: 't1' } }),
      said({ content: 'other agent', scope: { agentId: 'b' } }),
    ]);

    const seen = async (asked: MemoryItemScope) =>
      (await items.query({ scope: asked })).map((item) => item.content).sort();
    expect(await seen({ agentId: 'a', userId: 'u1' })).toEqual(['agent-wide', 'for u1']);
    expect(await seen({ agentId: 'a', userId: 'u1', threadId: 't1' })).toEqual(
      ['agent-wide', 'for u1', 'in t1'].sort()
    );
    expect(await seen({ agentId: 'a' })).toEqual(['agent-wide']);
    expect(visibleIn({ scope: { agentId: 'a', projectId: 'p' } }, { agentId: 'a' })).toBe(false);
  });

  it('links every name of an entity to one entity and keeps the new ones as aliases', async () => {
    const { adapter, items } = memory();
    const [a] = await items.write([said({ content: 'Dr. Lima teaches', subject: 'Ana Lima' })]);
    const [b] = await items.write([said({ content: 'Ana Lima runs', subject: 'the  ana lima' })]);

    expect(a?.entityId).toBe(b?.entityId);
    const found = await adapter.findEntities({ agentId: 'a', ids: [a!.entityId!] });
    expect(found.success && found.data[0]?.name).toBe('Ana Lima');
    expect(normalizeName(' The  Eiffel Tower! ')).toBe('eiffel tower');
  });

  it('lets items go without deleting them, and purges them for good', async () => {
    const { items } = memory(day(30));
    const [gone, purged] = await items.write([
      said({ content: 'Ana has a cat', recordedAt: day(1) }),
      said({ content: 'Ana has a dog', recordedAt: day(1) }),
    ]);
    await items.expire([gone!.id], day(20));
    await items.purge([purged!.id]);

    expect(await items.query({ scope })).toEqual([]);
    expect((await items.query({ scope, knownAt: day(10) })).map((item) => item.content)).toEqual([
      'Ana has a cat',
    ]);
    expect(await items.get(purged!.id)).toBeNull();
  });

  it('finds items by the words they hold', async () => {
    const { items } = memory();
    await items.write([
      said({ content: 'Ana lives in Porto' }),
      said({ content: 'Ana likes jazz' }),
    ]);

    expect((await items.query({ scope, text: 'JAZZ' })).map((item) => item.content)).toEqual([
      'Ana likes jazz',
    ]);
  });
});

describe('MemoryItems at once', () => {
  it('keeps one current state of a slot and one entity when writes race', async () => {
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    const writers = Array.from({ length: 5 }, () => new MemoryItems({ adapter }));
    const cities = ['Porto', 'Lisbon', 'Braga', 'Faro', 'Evora'];

    await Promise.all(
      cities.map((city, at) =>
        writers[at]!.write([
          said({
            content: `Ana lives in ${city}`,
            subject: 'Ana',
            attribute: 'home city',
            value: city,
            sessionAt: day(at + 1),
          }),
        ])
      )
    );

    const current = await writers[0]!.query({ scope });
    expect(current.map((item) => item.value)).toEqual(['Evora']);
    const entities = await adapter.findEntities({ agentId: 'a' });
    expect(entities.success && entities.data).toHaveLength(1);
  });
});
