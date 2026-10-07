import { afterEach, describe, it, expect, vi } from 'vitest';
import { InMemoryAdapter } from '../adapters/memory';
import { SessionManager } from '../session-manager';

const INDEX_THREAD = '__cogitator_session_index__';

const params = (userId: string) => ({
  userId,
  channelType: 'telegram',
  channelId: `chat-${userId}`,
  agentId: 'bot',
});

describe('SessionManager index', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists active sessions again after the index expired', async () => {
    vi.useFakeTimers();
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    const sessions = new SessionManager(adapter);
    await sessions.getOrCreate(params('alice'));
    await sessions.getOrCreate(params('bob'));

    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    await adapter.deleteThread(INDEX_THREAD);
    await sessions.getOrCreate(params('alice'));
    await sessions.getOrCreate(params('bob'));

    const listed = await sessions.list();
    expect(listed.map((s) => s.userId).sort()).toEqual(['alice', 'bob']);
  });

  it('refreshes the index while sessions are active, so a TTL store keeps it', async () => {
    vi.useFakeTimers();
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    const sessions = new SessionManager(adapter, { indexRefreshInterval: 60_000 });
    await sessions.getOrCreate(params('alice'));
    const updateThread = vi.spyOn(adapter, 'updateThread');

    await sessions.getOrCreate(params('alice'));
    const indexWrites = () =>
      updateThread.mock.calls.filter(([threadId]) => threadId === INDEX_THREAD).length;
    expect(indexWrites()).toBe(0);

    vi.advanceTimersByTime(61_000);
    await sessions.getOrCreate(params('alice'));
    expect(indexWrites()).toBe(1);
  });

  it('a second manager on the same store adds the sessions it touches', async () => {
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    await new SessionManager(adapter).getOrCreate(params('alice'));
    await adapter.deleteThread(INDEX_THREAD);

    const restarted = new SessionManager(adapter);
    await restarted.getOrCreate(params('alice'));

    expect((await restarted.list()).map((s) => s.userId)).toEqual(['alice']);
  });
});
