import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { CoreFactsStore } from '../core-facts';
import { sqliteMemoryItems } from '../adapters/sqlite-memory-items';

const tableNames = (db: BetterSqlite3.Database) =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[])
    .map((row) => row.name)
    .sort();

describe('CoreFactsStore', () => {
  let store: CoreFactsStore;

  beforeEach(async () => {
    store = new CoreFactsStore({ path: ':memory:' });
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
  });

  it('sets and gets a fact', async () => {
    await store.set('name', 'El');
    expect(await store.get('name')).toBe('El');
  });

  it('returns null for missing key', async () => {
    expect(await store.get('nonexistent')).toBeNull();
  });

  it('updates existing fact', async () => {
    await store.set('city', 'Moscow');
    await store.set('city', 'Saint Petersburg');
    expect(await store.get('city')).toBe('Saint Petersburg');
  });

  it('returns all facts', async () => {
    await store.set('name', 'El');
    await store.set('lang', 'Russian');
    const all = await store.getAll();
    expect(all).toEqual({ name: 'El', lang: 'Russian' });
  });

  it('deletes a fact', async () => {
    await store.set('temp', 'value');
    await store.delete('temp');
    expect(await store.get('temp')).toBeNull();
  });

  it('formats facts for system prompt', async () => {
    await store.set('name', 'El');
    await store.set('timezone', 'Europe/Moscow');
    const text = await store.formatForPrompt();
    expect(text).toContain('name: El');
    expect(text).toContain('timezone: Europe/Moscow');
  });

  it('returns empty string for prompt when no facts', async () => {
    const text = await store.formatForPrompt();
    expect(text).toBe('');
  });

  it('returns history for a key', async () => {
    await store.set('city', 'Moscow');
    await store.set('city', 'Saint Petersburg');
    const history = await store.getHistory('city');
    expect(history.length).toBe(2);
    expect(history[0].value).toBe('Moscow');
    expect(history[1].value).toBe('Saint Petersburg');
  });

  it('returns empty history for unknown key', async () => {
    const history = await store.getHistory('nope');
    expect(history).toEqual([]);
  });

  it('history entries have timestamps', async () => {
    await store.set('key', 'val');
    const history = await store.getHistory('key');
    expect(history[0].setAt).toBeInstanceOf(Date);
  });

  it('accepts shared database instance', async () => {
    const betterSqlite = await import('better-sqlite3');
    const DatabaseCtor = betterSqlite.default as unknown as new (
      path: string
    ) => InstanceType<typeof betterSqlite.default>;
    const sharedDb = new DatabaseCtor(':memory:');

    const store2 = new CoreFactsStore({ db: sharedDb });
    await store2.initialize();

    await store2.set('shared', 'yes');
    expect(await store2.get('shared')).toBe('yes');

    sharedDb.close();
  });

  it('keeps every value of a key as history, oldest first, the last one current', async () => {
    await store.set('city', 'Moscow');
    await store.set('city', 'Saint Petersburg');
    await store.set('city', 'Lisbon');

    expect(await store.get('city')).toBe('Lisbon');
    expect(await store.getAll()).toEqual({ city: 'Lisbon' });
    const history = await store.getHistory('city');
    expect(history.map((entry) => entry.value)).toEqual(['Moscow', 'Saint Petersburg', 'Lisbon']);
    for (let i = 1; i < history.length; i++) {
      expect(history[i].setAt.getTime()).toBeGreaterThanOrEqual(history[i - 1].setAt.getTime());
    }
  });

  it('supersedes a value set in the same millisecond', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-05-01T10:00:00Z') });
    try {
      await store.set('city', 'Moscow');
      await store.set('city', 'Porto');
      await store.set('city', 'Lisbon');

      expect(await store.get('city')).toBe('Lisbon');
      const history = await store.getHistory('city');
      expect(history.map((entry) => entry.value)).toEqual(['Moscow', 'Porto', 'Lisbon']);
      expect(history.every((entry) => entry.setAt.getTime() === Date.now())).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not record the same value twice', async () => {
    await store.set('lang', 'Russian');
    await store.set('lang', 'Russian');
    expect((await store.getHistory('lang')).map((entry) => entry.value)).toEqual(['Russian']);
  });

  it('takes a value that differs only in case as a new one', async () => {
    await store.set('city', 'moscow');
    await store.set('city', 'Moscow');
    expect(await store.get('city')).toBe('Moscow');
    expect((await store.getHistory('city')).map((entry) => entry.value)).toEqual([
      'moscow',
      'Moscow',
    ]);
  });

  it('keeps the history of a deleted key and starts it again on a new set', async () => {
    await store.set('city', 'Moscow');
    await store.set('city', 'Lisbon');
    await store.delete('city');

    expect(await store.get('city')).toBeNull();
    expect(await store.getAll()).toEqual({});
    expect((await store.getHistory('city')).map((entry) => entry.value)).toEqual([
      'Moscow',
      'Lisbon',
    ]);

    await store.set('city', 'Lisbon');
    expect(await store.get('city')).toBe('Lisbon');
    expect((await store.getHistory('city')).map((entry) => entry.value)).toEqual([
      'Moscow',
      'Lisbon',
      'Lisbon',
    ]);
  });

  it('serializes concurrent sets of a key', async () => {
    await Promise.all(['a', 'b', 'c', 'd'].map((value) => store.set('letter', value)));
    expect(await store.get('letter')).toBe('d');
    expect((await store.getHistory('letter')).map((entry) => entry.value)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });
});

describe('CoreFactsStore over memory items', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = new BetterSqlite3(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('stores each key as system facts of its slot in the store scope', async () => {
    const store = new CoreFactsStore({ db });
    await store.initialize();
    await store.set('city', 'Moscow');
    await store.set('city', 'Lisbon');

    const items = await sqliteMemoryItems(db).findItems({ agentId: 'core', slots: ['core:city'] });
    expect(items.success && items.data).toMatchObject([
      {
        kind: 'fact',
        attribute: 'city',
        value: 'Moscow',
        content: 'city: Moscow',
        trust: 'system',
        confidence: 1,
        status: 'superseded',
        scope: { agentId: 'core' },
        evidence: [],
      },
      { value: 'Lisbon', content: 'city: Lisbon', status: 'active' },
    ]);
  });

  it('keeps facts of different scopes apart', async () => {
    const shared = new CoreFactsStore({ db });
    const ana = new CoreFactsStore({ db, scope: { agentId: 'assistant', userId: 'ana' } });
    const bob = new CoreFactsStore({ db, scope: { agentId: 'assistant', userId: 'bob' } });
    for (const store of [shared, ana, bob]) await store.initialize();

    await shared.set('city', 'Porto');
    await ana.set('city', 'Lisbon');
    await bob.set('city', 'Moscow');
    await bob.set('lang', 'Russian');

    expect(await shared.getAll()).toEqual({ city: 'Porto' });
    expect(await ana.getAll()).toEqual({ city: 'Lisbon' });
    expect(await bob.getAll()).toEqual({ city: 'Moscow', lang: 'Russian' });
    expect((await ana.getHistory('city')).map((entry) => entry.value)).toEqual(['Lisbon']);

    const items = await sqliteMemoryItems(db).findItems({ agentId: 'assistant' });
    expect(items.success && items.data.map((item) => item.scope.userId).sort()).toEqual([
      'ana',
      'bob',
      'bob',
    ]);
  });

  it('migrates the tables of an earlier version once, history kept', async () => {
    db.exec(`
      CREATE TABLE core_facts (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE core_facts_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        set_at TEXT NOT NULL
      );
    `);
    const at = (day: number) => new Date(Date.UTC(2026, 0, day)).toISOString();
    const history = db.prepare(
      'INSERT INTO core_facts_history (key, value, set_at) VALUES (?, ?, ?)'
    );
    history.run('city', 'Moscow', at(1));
    history.run('name', 'El', at(1));
    history.run('city', 'Saint Petersburg', at(2));
    history.run('name', 'El', at(3));
    history.run('temp', 'gone', at(4));
    const facts = db.prepare('INSERT INTO core_facts (key, value, updated_at) VALUES (?, ?, ?)');
    facts.run('city', 'Saint Petersburg', at(2));
    facts.run('name', 'El', at(3));
    facts.run('lang', 'Russian', at(5));

    const store = new CoreFactsStore({ db });
    await store.initialize();

    expect(await store.getAll()).toEqual({
      city: 'Saint Petersburg',
      lang: 'Russian',
      name: 'El',
    });
    expect(await store.get('temp')).toBeNull();
    expect(await store.getHistory('city')).toEqual([
      { value: 'Moscow', setAt: new Date(at(1)) },
      { value: 'Saint Petersburg', setAt: new Date(at(2)) },
    ]);
    expect(await store.getHistory('name')).toEqual([{ value: 'El', setAt: new Date(at(1)) }]);
    expect(await store.getHistory('temp')).toEqual([{ value: 'gone', setAt: new Date(at(4)) }]);
    expect(await store.getHistory('lang')).toEqual([{ value: 'Russian', setAt: new Date(at(5)) }]);

    const tables = tableNames(db);
    expect(tables).toContain('core_facts_legacy');
    expect(tables).toContain('core_facts_history_legacy');
    expect(tables).not.toContain('core_facts');
    expect(tables).not.toContain('core_facts_history');
    expect(db.prepare('SELECT COUNT(*) AS n FROM core_facts_history_legacy').get()).toEqual({
      n: 5,
    });

    await store.set('city', 'Lisbon');
    const again = new CoreFactsStore({ db });
    await again.initialize();
    expect((await again.getHistory('city')).map((entry) => entry.value)).toEqual([
      'Moscow',
      'Saint Petersburg',
      'Lisbon',
    ]);
  });

  it('leaves the old tables alone when the scope has facts already', async () => {
    const store = new CoreFactsStore({ db });
    await store.initialize();
    await store.set('city', 'Lisbon');
    db.exec(`
      CREATE TABLE core_facts (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO core_facts VALUES ('city', 'Moscow', '2026-01-01T00:00:00.000Z');
    `);

    const again = new CoreFactsStore({ db });
    await again.initialize();
    expect(await again.get('city')).toBe('Lisbon');
    expect(tableNames(db)).toContain('core_facts');
  });
});
