import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionManager } from '../session-manager';
import { InMemoryAdapter } from '../adapters/memory';

describe('SessionManager', () => {
  let adapter: InMemoryAdapter;
  let manager: SessionManager;

  beforeEach(async () => {
    adapter = new InMemoryAdapter({ provider: 'memory' });
    await adapter.connect();
    manager = new SessionManager(adapter);
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  describe('getOrCreate', () => {
    it('creates a new session', async () => {
      const session = await manager.getOrCreate({
        userId: 'user-1',
        channelType: 'telegram',
        channelId: 'chat-123',
        agentId: 'agent-1',
      });

      expect(session.id).toBe('session_telegram_user-1');
      expect(session.userId).toBe('user-1');
      expect(session.channelType).toBe('telegram');
      expect(session.channelId).toBe('chat-123');
      expect(session.agentId).toBe('agent-1');
      expect(session.status).toBe('active');
      expect(session.messageCount).toBe(0);
      expect(session.createdAt).toBeInstanceOf(Date);
      expect(session.lastActiveAt).toBeInstanceOf(Date);
    });

    it('returns existing session on second call', async () => {
      const first = await manager.getOrCreate({
        userId: 'user-1',
        channelType: 'telegram',
        channelId: 'chat-123',
        agentId: 'agent-1',
      });

      const second = await manager.getOrCreate({
        userId: 'user-1',
        channelType: 'telegram',
        channelId: 'chat-123',
        agentId: 'agent-1',
      });

      expect(first.id).toBe(second.id);
      expect(first.createdAt.getTime()).toBe(second.createdAt.getTime());
    });

    it('creates separate sessions for different channels', async () => {
      const tg = await manager.getOrCreate({
        userId: 'user-1',
        channelType: 'telegram',
        channelId: 'chat-123',
        agentId: 'agent-1',
      });

      const dc = await manager.getOrCreate({
        userId: 'user-1',
        channelType: 'discord',
        channelId: 'guild-456',
        agentId: 'agent-1',
      });

      expect(tg.id).not.toBe(dc.id);
      expect(tg.channelType).toBe('telegram');
      expect(dc.channelType).toBe('discord');
    });

    it('reactivates archived session', async () => {
      const session = await manager.getOrCreate({
        userId: 'user-1',
        channelType: 'telegram',
        channelId: 'chat-123',
        agentId: 'agent-1',
      });

      await manager.archive(session.id);
      const archived = await manager.get(session.id);
      expect(archived?.status).toBe('archived');

      const reactivated = await manager.getOrCreate({
        userId: 'user-1',
        channelType: 'telegram',
        channelId: 'chat-123',
        agentId: 'agent-1',
      });

      expect(reactivated.id).toBe(session.id);
      expect(reactivated.status).toBe('active');
    });
  });

  describe('get', () => {
    it('returns session by id', async () => {
      const created = await manager.getOrCreate({
        userId: 'user-1',
        channelType: 'telegram',
        channelId: 'chat-123',
        agentId: 'agent-1',
      });

      const fetched = await manager.get(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.userId).toBe('user-1');
    });

    it('returns null for non-existent session', async () => {
      const result = await manager.get('session_telegram_nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('update', () => {
    it('updates session status', async () => {
      const session = await manager.getOrCreate({
        userId: 'user-1',
        channelType: 'telegram',
        channelId: 'chat-123',
        agentId: 'agent-1',
      });

      const updated = await manager.update(session.id, { status: 'paused' });
      expect(updated.status).toBe('paused');
    });

    it('updates session config overrides', async () => {
      const session = await manager.getOrCreate({
        userId: 'user-1',
        channelType: 'telegram',
        channelId: 'chat-123',
        agentId: 'agent-1',
      });

      const updated = await manager.update(session.id, {
        config: { model: 'anthropic/claude-opus-4-20250514', temperature: 0.5 },
      });

      expect(updated.config?.model).toBe('anthropic/claude-opus-4-20250514');
      expect(updated.config?.temperature).toBe(0.5);
    });

    it('throws on non-existent session', async () => {
      await expect(
        manager.update('session_telegram_nonexistent', { status: 'paused' })
      ).rejects.toThrow('Session not found');
    });
  });

  describe('archive', () => {
    it('sets status to archived', async () => {
      const session = await manager.getOrCreate({
        userId: 'user-1',
        channelType: 'telegram',
        channelId: 'chat-123',
        agentId: 'agent-1',
      });

      await manager.archive(session.id);
      const archived = await manager.get(session.id);
      expect(archived?.status).toBe('archived');
    });
  });

  describe('delete', () => {
    it('removes session completely', async () => {
      const session = await manager.getOrCreate({
        userId: 'user-1',
        channelType: 'telegram',
        channelId: 'chat-123',
        agentId: 'agent-1',
      });

      await manager.delete(session.id);
      const result = await manager.get(session.id);
      expect(result).toBeNull();
    });
  });

  describe('list', () => {
    it('lists sessions by userId', async () => {
      await manager.getOrCreate({
        userId: 'user-1',
        channelType: 'telegram',
        channelId: 'chat-1',
        agentId: 'agent-1',
      });

      await manager.getOrCreate({
        userId: 'user-1',
        channelType: 'discord',
        channelId: 'guild-1',
        agentId: 'agent-1',
      });

      const sessions = await manager.list({ userId: 'user-1' });
      expect(sessions).toHaveLength(2);
    });

    it('filters by channelType', async () => {
      await manager.getOrCreate({
        userId: 'user-1',
        channelType: 'telegram',
        channelId: 'chat-1',
        agentId: 'agent-1',
      });

      await manager.getOrCreate({
        userId: 'user-1',
        channelType: 'discord',
        channelId: 'guild-1',
        agentId: 'agent-1',
      });

      const sessions = await manager.list({ userId: 'user-1', channelType: 'telegram' });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].channelType).toBe('telegram');
    });

    it('filters by status', async () => {
      const s1 = await manager.getOrCreate({
        userId: 'user-1',
        channelType: 'telegram',
        channelId: 'chat-1',
        agentId: 'agent-1',
      });

      await manager.getOrCreate({
        userId: 'user-1',
        channelType: 'discord',
        channelId: 'guild-1',
        agentId: 'agent-1',
      });

      await manager.archive(s1.id);

      const active = await manager.list({ userId: 'user-1', status: 'active' });
      expect(active).toHaveLength(1);
      expect(active[0].channelType).toBe('discord');
    });

    it('respects limit', async () => {
      await manager.getOrCreate({
        userId: 'user-1',
        channelType: 'telegram',
        channelId: 'chat-1',
        agentId: 'agent-1',
      });

      await manager.getOrCreate({
        userId: 'user-1',
        channelType: 'discord',
        channelId: 'guild-1',
        agentId: 'agent-1',
      });

      const sessions = await manager.list({ userId: 'user-1', limit: 1 });
      expect(sessions).toHaveLength(1);
    });
  });

  describe('incrementMessageCount', () => {
    it('increments message counter', async () => {
      const session = await manager.getOrCreate({
        userId: 'user-1',
        channelType: 'telegram',
        channelId: 'chat-123',
        agentId: 'agent-1',
      });

      expect(session.messageCount).toBe(0);

      await manager.incrementMessageCount(session.id);
      await manager.incrementMessageCount(session.id);
      await manager.incrementMessageCount(session.id);

      const updated = await manager.get(session.id);
      expect(updated?.messageCount).toBe(3);
    });

    it('updates lastActiveAt on increment', async () => {
      const session = await manager.getOrCreate({
        userId: 'user-1',
        channelType: 'telegram',
        channelId: 'chat-123',
        agentId: 'agent-1',
      });

      const before = session.lastActiveAt;
      await new Promise((r) => setTimeout(r, 10));
      await manager.incrementMessageCount(session.id);

      const updated = await manager.get(session.id);
      expect(updated!.lastActiveAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });
  });

  describe('thread integration', () => {
    it('session threadId works with memory entries', async () => {
      const session = await manager.getOrCreate({
        userId: 'user-1',
        channelType: 'telegram',
        channelId: 'chat-123',
        agentId: 'agent-1',
      });

      await adapter.addEntry({
        threadId: session.id,
        message: { role: 'user', content: 'Hello' },
        tokenCount: 5,
      });

      await adapter.addEntry({
        threadId: session.id,
        message: { role: 'assistant', content: 'Hi there!' },
        tokenCount: 8,
      });

      const entries = await adapter.getEntries({ threadId: session.id });
      expect(entries.success).toBe(true);
      if (entries.success) {
        expect(entries.data).toHaveLength(2);
        expect(entries.data[0].message.content).toBe('Hello');
        expect(entries.data[1].message.content).toBe('Hi there!');
      }
    });
  });
});
