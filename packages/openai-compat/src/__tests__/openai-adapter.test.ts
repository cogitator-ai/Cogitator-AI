import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Cogitator } from '@cogitator-ai/core';
import { OpenAIAdapter } from '../client/openai-adapter';
import { ThreadManager } from '../client/thread-manager';

const mockCogitator = {
  run: vi.fn(),
} as unknown as Cogitator;

describe('OpenAIAdapter', () => {
  let adapter: OpenAIAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new OpenAIAdapter(mockCogitator);
  });

  describe('Assistants', () => {
    it('should create an assistant', async () => {
      const assistant = await adapter.createAssistant({
        model: 'gpt-4',
        name: 'Test Assistant',
        instructions: 'You are a helpful assistant.',
      });

      expect(assistant.id).toMatch(/^asst_/);
      expect(assistant.object).toBe('assistant');
      expect(assistant.name).toBe('Test Assistant');
      expect(assistant.model).toBe('gpt-4');
      expect(assistant.instructions).toBe('You are a helpful assistant.');
    });

    it('should get an assistant', async () => {
      const created = await adapter.createAssistant({
        model: 'gpt-4',
        name: 'Test',
      });

      const retrieved = await adapter.getAssistant(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
    });

    it('should return undefined for non-existent assistant', async () => {
      const result = await adapter.getAssistant('asst_nonexistent');
      expect(result).toBeUndefined();
    });

    it('should update an assistant', async () => {
      const created = await adapter.createAssistant({
        model: 'gpt-4',
        name: 'Original',
      });

      const updated = await adapter.updateAssistant(created.id, {
        name: 'Updated',
        instructions: 'New instructions',
      });

      expect(updated?.name).toBe('Updated');
      expect(updated?.instructions).toBe('New instructions');
    });

    it('should delete an assistant', async () => {
      const created = await adapter.createAssistant({
        model: 'gpt-4',
        name: 'Test',
      });

      const deleted = await adapter.deleteAssistant(created.id);
      expect(deleted).toBe(true);

      const retrieved = await adapter.getAssistant(created.id);
      expect(retrieved).toBeUndefined();
    });

    it('should list assistants', async () => {
      await adapter.createAssistant({ model: 'gpt-4', name: 'First' });
      await adapter.createAssistant({ model: 'gpt-4', name: 'Second' });

      const list = await adapter.listAssistants();
      expect(list).toHaveLength(2);
    });
  });

  describe('Threads', () => {
    it('should create a thread', async () => {
      const thread = await adapter.createThread();

      expect(thread.id).toMatch(/^thread_/);
      expect(thread.object).toBe('thread');
      expect(thread.metadata).toEqual({});
    });

    it('should create a thread with metadata', async () => {
      const thread = await adapter.createThread({ key: 'value' });

      expect(thread.metadata).toEqual({ key: 'value' });
    });

    it('should get a thread', async () => {
      const created = await adapter.createThread();
      const retrieved = await adapter.getThread(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
    });

    it('should delete a thread', async () => {
      const created = await adapter.createThread();
      const deleted = await adapter.deleteThread(created.id);

      expect(deleted).toBe(true);
      expect(await adapter.getThread(created.id)).toBeUndefined();
    });
  });

  describe('Messages', () => {
    let threadId: string;

    beforeEach(async () => {
      const thread = await adapter.createThread();
      threadId = thread.id;
    });

    it('should add a message to a thread', async () => {
      const message = await adapter.addMessage(threadId, {
        role: 'user',
        content: 'Hello!',
      });

      expect(message).toBeDefined();
      expect(message?.id).toMatch(/^msg_/);
      expect(message?.role).toBe('user');
      expect(message?.thread_id).toBe(threadId);
    });

    it('should list messages in a thread', async () => {
      await adapter.addMessage(threadId, { role: 'user', content: 'First' });
      await adapter.addMessage(threadId, { role: 'user', content: 'Second' });

      const messages = await adapter.listMessages(threadId);

      expect(messages).toHaveLength(2);
    });

    it('should list messages in descending order by default', async () => {
      await adapter.addMessage(threadId, { role: 'user', content: 'First' });
      await adapter.addMessage(threadId, { role: 'user', content: 'Second' });

      const messages = await adapter.listMessages(threadId);

      expect(messages[0].content[0]).toMatchObject({ type: 'text' });
    });

    it('should get a specific message', async () => {
      const created = await adapter.addMessage(threadId, {
        role: 'user',
        content: 'Test message',
      });

      const retrieved = await adapter.getMessage(threadId, created!.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created!.id);
    });
  });
});

describe('ThreadManager', () => {
  let manager: ThreadManager;

  beforeEach(() => {
    manager = new ThreadManager();
  });

  describe('Files', () => {
    it('should add a file', async () => {
      const content = Buffer.from('test content');
      const file = await manager.addFile(content, 'test.txt');

      expect(file.id).toMatch(/^file_/);
      expect(file.filename).toBe('test.txt');
    });

    it('should get a file', async () => {
      const content = Buffer.from('test content');
      const created = await manager.addFile(content, 'test.txt');

      const retrieved = await manager.getFile(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.content.toString()).toBe('test content');
    });

    it('should delete a file', async () => {
      const content = Buffer.from('test content');
      const created = await manager.addFile(content, 'test.txt');

      const deleted = await manager.deleteFile(created.id);

      expect(deleted).toBe(true);
      expect(await manager.getFile(created.id)).toBeUndefined();
    });

    it('should list all files', async () => {
      const file1 = await manager.addFile(Buffer.from('content1'), 'file1.txt');
      const file2 = await manager.addFile(Buffer.from('content2'), 'file2.txt');

      const files = await manager.listFiles();

      expect(files).toHaveLength(2);
      expect(files.map((f) => f.id)).toContain(file1.id);
      expect(files.map((f) => f.id)).toContain(file2.id);
    });

    it('should return empty array when no files', async () => {
      const files = await manager.listFiles();
      expect(files).toEqual([]);
    });
  });

  describe('getMessagesForLLM', () => {
    it('should convert messages to LLM format', async () => {
      const thread = await manager.createThread();
      await manager.addMessage(thread.id, { role: 'user', content: 'Hello' });
      await manager.addAssistantMessage(thread.id, 'Hi there!', 'asst_1', 'run_1');

      const llmMessages = await manager.getMessagesForLLM(thread.id);

      expect(llmMessages).toHaveLength(2);
      expect(llmMessages[0]).toEqual({ role: 'user', content: 'Hello' });
      expect(llmMessages[1]).toEqual({ role: 'assistant', content: 'Hi there!' });
    });
  });
});
