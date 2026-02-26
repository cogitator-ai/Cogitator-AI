import { describe, it, expect, beforeEach } from 'vitest';
import { ThreadManager } from '../client/thread-manager';
import { InMemoryThreadStorage } from '../client/storage';

describe('ThreadManager', () => {
  let manager: ThreadManager;

  beforeEach(() => {
    manager = new ThreadManager();
  });

  describe('updateThread', () => {
    it('updates thread metadata', async () => {
      const thread = await manager.createThread({ key: 'original' });

      const updated = await manager.updateThread(thread.id, {
        metadata: { key: 'updated', extra: 'new' },
      });

      expect(updated).toBeDefined();
      expect(updated!.metadata.key).toBe('updated');
      expect(updated!.metadata.extra).toBe('new');
    });

    it('persists metadata changes to storage', async () => {
      const storage = new InMemoryThreadStorage();
      const mgr = new ThreadManager(storage);

      const thread = await mgr.createThread({ foo: 'bar' });
      await mgr.updateThread(thread.id, { metadata: { foo: 'baz' } });

      const stored = await storage.loadThread(thread.id);
      expect(stored!.thread.metadata.foo).toBe('baz');
    });

    it('returns undefined for non-existent thread', async () => {
      const result = await manager.updateThread('thread_nope', { metadata: { x: 'y' } });
      expect(result).toBeUndefined();
    });
  });

  describe('addMessage with array content', () => {
    it('normalizes text content parts', async () => {
      const thread = await manager.createThread();
      const msg = await manager.addMessage(thread.id, {
        role: 'user',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: ' World' },
        ],
      });

      expect(msg).toBeDefined();
      expect(msg!.content).toHaveLength(2);
      expect(msg!.content[0]).toMatchObject({
        type: 'text',
        text: { value: 'Hello', annotations: [] },
      });
    });

    it('normalizes image_url content parts', async () => {
      const thread = await manager.createThread();
      const msg = await manager.addMessage(thread.id, {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://example.com/img.png' } }],
      });

      expect(msg).toBeDefined();
      expect(msg!.content[0]).toMatchObject({
        type: 'image_url',
        image_url: { url: 'https://example.com/img.png' },
      });
    });

    it('normalizes image_file content parts', async () => {
      const thread = await manager.createThread();
      const msg = await manager.addMessage(thread.id, {
        role: 'user',
        content: [{ type: 'image_file', image_file: { file_id: 'file_123', detail: 'high' } }],
      });

      expect(msg).toBeDefined();
      expect(msg!.content[0]).toMatchObject({
        type: 'image_file',
        image_file: { file_id: 'file_123', detail: 'high' },
      });
    });
  });

  describe('listMessages pagination', () => {
    it('filters by run_id', async () => {
      const thread = await manager.createThread();
      await manager.addMessage(thread.id, { role: 'user', content: 'msg1' });
      await manager.addAssistantMessage(thread.id, 'resp1', 'asst_1', 'run_1');
      await manager.addAssistantMessage(thread.id, 'resp2', 'asst_1', 'run_2');

      const messages = await manager.listMessages(thread.id, { run_id: 'run_1' });
      expect(messages).toHaveLength(1);
      expect(messages[0].run_id).toBe('run_1');
    });

    it('paginates with after cursor', async () => {
      const thread = await manager.createThread();
      await manager.addMessage(thread.id, { role: 'user', content: 'first' });
      const second = await manager.addMessage(thread.id, { role: 'user', content: 'second' });
      await manager.addMessage(thread.id, { role: 'user', content: 'third' });

      const messages = await manager.listMessages(thread.id, {
        order: 'asc',
        after: second!.id,
      });
      expect(messages).toHaveLength(1);
    });

    it('paginates with before cursor', async () => {
      const thread = await manager.createThread();
      await manager.addMessage(thread.id, { role: 'user', content: 'first' });
      const second = await manager.addMessage(thread.id, { role: 'user', content: 'second' });
      await manager.addMessage(thread.id, { role: 'user', content: 'third' });

      const messages = await manager.listMessages(thread.id, {
        order: 'asc',
        before: second!.id,
      });
      expect(messages).toHaveLength(1);
    });

    it('applies limit', async () => {
      const thread = await manager.createThread();
      await manager.addMessage(thread.id, { role: 'user', content: 'a' });
      await manager.addMessage(thread.id, { role: 'user', content: 'b' });
      await manager.addMessage(thread.id, { role: 'user', content: 'c' });

      const messages = await manager.listMessages(thread.id, { limit: 2 });
      expect(messages).toHaveLength(2);
    });

    it('returns empty array for non-existent thread', async () => {
      const messages = await manager.listMessages('thread_nonexistent');
      expect(messages).toEqual([]);
    });
  });

  describe('assistant CRUD', () => {
    it('creates assistant with all fields', async () => {
      const asst = await manager.createAssistant({
        model: 'gpt-4',
        name: 'Test',
        instructions: 'Be helpful',
        tools: [{ type: 'code_interpreter' }],
        metadata: { env: 'test' },
        temperature: 0.5,
      });

      expect(asst.id).toMatch(/^asst_/);
      expect(asst.name).toBe('Test');
      expect(asst.model).toBe('gpt-4');
      expect(asst.instructions).toBe('Be helpful');
      expect(asst.tools).toHaveLength(1);
      expect(asst.metadata).toEqual({ env: 'test' });
      expect(asst.temperature).toBe(0.5);
    });

    it('creates assistant with defaults', async () => {
      const asst = await manager.createAssistant({ model: 'gpt-4' });

      expect(asst.name).toBeNull();
      expect(asst.instructions).toBeNull();
      expect(asst.tools).toEqual([]);
      expect(asst.metadata).toEqual({});
    });

    it('updates assistant fields', async () => {
      const asst = await manager.createAssistant({ model: 'gpt-4', name: 'Old' });
      const updated = await manager.updateAssistant(asst.id, { name: 'New', model: 'gpt-3.5' });

      expect(updated!.name).toBe('New');
      expect(updated!.model).toBe('gpt-3.5');
    });

    it('returns undefined when updating non-existent assistant', async () => {
      const result = await manager.updateAssistant('asst_nope', { name: 'X' });
      expect(result).toBeUndefined();
    });

    it('caches assistants after first load', async () => {
      const storage = new InMemoryThreadStorage();
      const mgr = new ThreadManager(storage);

      const asst = await mgr.createAssistant({ model: 'gpt-4' });

      const first = await mgr.getAssistant(asst.id);
      const second = await mgr.getAssistant(asst.id);
      expect(first).toBe(second);
    });
  });

  describe('addMessage edge cases', () => {
    it('returns undefined for non-existent thread', async () => {
      const result = await manager.addMessage('thread_nope', {
        role: 'user',
        content: 'hello',
      });
      expect(result).toBeUndefined();
    });

    it('returns undefined for getMessage on non-existent thread', async () => {
      const result = await manager.getMessage('thread_nope', 'msg_nope');
      expect(result).toBeUndefined();
    });
  });

  describe('addAssistantMessage edge cases', () => {
    it('returns undefined for non-existent thread', async () => {
      const result = await manager.addAssistantMessage('thread_nope', 'hi', 'asst_1', 'run_1');
      expect(result).toBeUndefined();
    });
  });
});
