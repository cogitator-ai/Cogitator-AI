import { describe, it, expect } from 'vitest';
import { InMemoryAdapter } from '../adapters/memory';
import { SessionManager } from '../session-manager';

const params = (userId: string, channelType = 'telegram') => ({
  userId,
  channelType,
  channelId: `chat-${userId}`,
  agentId: 'bot',
});

describe('SessionManager listing', () => {
  it('finds every session on the store without keeping an index thread', async () => {
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    await new SessionManager(adapter).getOrCreate(params('alice'));
    await new SessionManager(adapter).getOrCreate(params('bob', 'slack'));

    const restarted = new SessionManager(adapter);
    expect((await restarted.list()).map((s) => s.userId).sort()).toEqual(['alice', 'bob']);
    const all = await adapter.listThreads({ limit: 500 });
    expect(all.success && all.data.threads.map((t) => t.id).sort()).toEqual([
      'session_slack_bob',
      'session_telegram_alice',
    ]);
  });

  it('lists sessions written by earlier versions and leaves other threads out', async () => {
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    await adapter.createThread(
      'bot',
      {
        _session: true,
        userId: 'carol',
        channelType: 'discord',
        channelId: 'c',
        status: 'active',
        messageCount: 3,
        lastActiveAt: new Date().toISOString(),
      },
      'session_discord_carol'
    );
    await adapter.createThread('system', { _sessionIndex: true, sessions: [] }, 'index');
    await adapter.createThread('bot', { userId: 'carol' }, 'plain-thread');

    const listed = await new SessionManager(adapter).list({ userId: 'carol' });
    expect(listed.map((s) => s.id)).toEqual(['session_discord_carol']);
  });

  it('filters by user, channel, agent, status and activity, and pages past one listing page', async () => {
    const adapter = new InMemoryAdapter({ provider: 'memory' });
    const sessions = new SessionManager(adapter);
    for (let i = 0; i < 230; i++) await sessions.getOrCreate(params(`user-${i}`));
    await sessions.getOrCreate(params('dave', 'slack'));
    await sessions.archive('session_telegram_user-0');

    expect(await sessions.list()).toHaveLength(231);
    expect((await sessions.list({ channelType: 'slack' })).map((s) => s.userId)).toEqual(['dave']);
    expect((await sessions.list({ status: 'archived' })).map((s) => s.userId)).toEqual(['user-0']);
    expect(await sessions.list({ agentId: 'someone-else' })).toEqual([]);
    const page = await sessions.list({ limit: 10, offset: 5 });
    expect(page).toHaveLength(10);
    expect((await sessions.list({ activeSince: new Date(Date.now() + 60_000) })).length).toBe(0);
  });
});
