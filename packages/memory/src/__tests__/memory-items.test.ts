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

describe('MemoryItems timelines', () => {
  const city = (value: string, from: number, fields: Partial<NewMemoryItem> = {}) =>
    said({
      content: `Ana lives in ${value}`,
      subject: 'Ana',
      attribute: 'home city',
      value,
      sessionAt: day(from),
      ...fields,
    });
  const values = async (items: MemoryItems, asOf?: Date, knownAt?: Date) =>
    (
      await items.query({
        scope,
        ...(asOf && { asOf }),
        ...(knownAt && { knownAt }),
      })
    ).map((item) => item.value);

  it('says a value again after it changed as a new state, not the old one brought back', async () => {
    const { items } = memory();
    await items.write([city('Berlin', 1, { trust: 'model' })]);
    await items.write([city('Paris', 10)]);
    await items.write([city('Berlin', 20)]);

    expect(await values(items)).toEqual(['Berlin']);
    expect(await values(items, day(15))).toEqual(['Paris']);
  });

  it('keeps a state until a later one starts, even one set to start in the future', async () => {
    const { items } = memory(day(15));
    await items.write([city('Porto', 1), city('Lisbon', 20)]);

    expect(await values(items)).toEqual(['Porto']);
    expect(await values(items, day(25))).toEqual(['Lisbon']);
  });

  it('merges a value said again into the newest open one, not an older suggestion', async () => {
    const { items } = memory();
    await items.write([city('Paris', 1, { trust: 'model' })]);
    await items.write([city('Berlin', 2), city('Paris', 3)]);
    await items.write([city('Paris', 4)]);

    const history = await items.history(scope, (await items.query({ scope }))[0]!.slot!);
    expect(history.map((item) => item.value)).toEqual(['Berlin', 'Paris']);
  });

  it('keeps the later of two states written in one millisecond the current one', async () => {
    const { items } = memory(day(30));
    for (let at = 0; at < 5; at++) {
      await items.write([city(`City ${at}`, 1)]);
    }

    expect(await values(items)).toEqual(['City 4']);
  });

  it('fits a state told late between the ones around it', async () => {
    const { items } = memory();
    await items.write([city('Porto', 1), city('Lisbon', 10), city('Braga', 5)]);

    expect(await values(items, day(3))).toEqual(['Porto']);
    expect(await values(items, day(7))).toEqual(['Braga']);
    expect(await values(items, day(12))).toEqual(['Lisbon']);
  });

  it('does not let a correction recorded later change what memory knew before it', async () => {
    const { items } = memory(day(30));
    await items.write([city('Berlin', 1, { recordedAt: day(1) })]);
    await items.write([city('Paris', 3, { recordedAt: day(10) })]);

    expect(await values(items, undefined, day(5))).toEqual(['Berlin']);
    expect(await values(items, day(5))).toEqual(['Paris']);
    expect(await values(items, day(2))).toEqual(['Berlin']);
  });

  it('answers as known at a date with what held then by default', async () => {
    const { items } = memory(day(30));
    await items.write([
      city('Berlin', 1, { recordedAt: day(1) }),
      city('Paris', 10, { recordedAt: day(10) }),
    ]);

    expect(await values(items, undefined, day(5))).toEqual(['Berlin']);
  });

  it('takes a changed sign or spelling as a new value', async () => {
    const { items } = memory();
    const [five] = await items.write([
      said({ content: 'Offset is 5', subject: 'clock', attribute: 'offset', value: '5' }),
    ]);
    const [minus] = await items.write([
      said({
        content: 'Offset is -5',
        subject: 'clock',
        attribute: 'offset',
        value: '-5',
        sessionAt: day(2),
      }),
    ]);

    expect(minus?.id).not.toBe(five?.id);
    expect((await items.query({ scope })).map((item) => item.value)).toEqual(['-5']);
  });

  it('does not bring the state before back when the latest one is let go', async () => {
    const { items } = memory();
    const [, lisbon] = await items.write([city('Porto', 1), city('Lisbon', 10)]);
    await items.expire([lisbon!.id]);
    await items.write([city('Porto', 1, { content: 'Ana lived in Porto' })]);

    expect(await values(items)).toEqual([]);
  });

  it('settles two states a failed close left open into one timeline', async () => {
    const { adapter, items } = memory();
    const [porto] = await items.write([city('Porto', 1)]);
    await adapter.putItem({
      ...porto!,
      id: 'mem_stray',
      value: 'Lisbon',
      content: 'Ana lives in Lisbon',
      validFrom: day(10),
    });
    await items.write([city('Lisbon', 10, { evidence: [{ entryId: 'e9', quote: 'Lisbon' }] })]);

    expect(await values(items)).toEqual(['Lisbon']);
    expect((await items.get(porto!.id))?.status).toBe('superseded');
  });

  it('trusts what the better grounded source says when an item is said again', async () => {
    const { items } = memory();
    const [web] = await items.write([said({ content: 'Ana runs Acme', trust: 'web' })]);
    const [user] = await items.write([said({ content: 'Ana runs Acme', trust: 'user' })]);
    expect(user).toMatchObject({ id: web?.id, trust: 'user', status: 'active' });

    const [guess] = await items.write([
      said({ content: 'Ana is a pilot', trust: 'user', verified: false }),
    ]);
    const [page] = await items.write([said({ content: 'Ana is a pilot', trust: 'web' })]);
    expect(page).toMatchObject({
      id: guess?.id,
      trust: 'user',
      verified: false,
      status: 'suggested',
    });

    const [plan] = await items.write([
      said({ content: 'Plan is pro', trust: 'system', verified: false, evidence: [] }),
    ]);
    const [echo] = await items.write([said({ content: 'Plan is pro', trust: 'model' })]);
    expect(echo).toMatchObject({ id: plan?.id, trust: 'system', status: 'active' });
  });

  it('settles on one entity for a name when writers that do not share a queue race', async () => {
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    const views = Array.from(
      { length: 4 },
      () => new MemoryItems({ adapter: Object.create(adapter) as InMemoryAdapter })
    );

    const linked = await Promise.all(views.map((items) => items.link(scope, 'Ana')));

    expect(new Set(linked.map((entity) => entity.id)).size).toBe(1);
    const entities = await adapter.findEntities({ agentId: 'a' });
    expect(entities.success && entities.data).toHaveLength(1);
  });
});

describe('MemoryItems retrieval counts', () => {
  it('counts each item a run sent once, with when', async () => {
    const { items } = memory(day(30));
    const [kept] = await items.write([said({ content: 'Ana likes jazz' })]);

    await items.noteRetrieved([kept!.id, kept!.id, 'missing'], day(20));
    await items.noteRetrieved([kept!.id], day(21));

    expect(await items.get(kept!.id)).toMatchObject({
      timesRetrieved: 2,
      lastRetrievedAt: day(21),
    });
  });
});
