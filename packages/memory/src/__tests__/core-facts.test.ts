import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CoreFactsStore } from '../core-facts';

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
});
