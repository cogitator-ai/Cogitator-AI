/**
 * Tests for OpenAI Adapter
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIAdapter } from '../client/openai-adapter.js';
import { ThreadManager } from '../client/thread-manager.js';

const mockCogitator = {
  run: vi.fn(),
} as any;

describe('OpenAIAdapter', () => {
  let adapter: OpenAIAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new OpenAIAdapter(mockCogitator);
  });

  describe('Assistants', () => {
    it('should create an assistant', () => {
      const assistant = adapter.createAssistant({
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

    it('should get an assistant', () => {
      const created = adapter.createAssistant({
        model: 'gpt-4',
        name: 'Test',
      });

      const retrieved = adapter.getAssistant(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
    });

    it('should return undefined for non-existent assistant', () => {
      const result = adapter.getAssistant('asst_nonexistent');
      expect(result).toBeUndefined();
    });

    it('should update an assistant', () => {
      const created = adapter.createAssistant({
        model: 'gpt-4',
        name: 'Original',
      });

      const updated = adapter.updateAssistant(created.id, {
        name: 'Updated',
        instructions: 'New instructions',
      });

      expect(updated?.name).toBe('Updated');
      expect(updated?.instructions).toBe('New instructions');
    });

    it('should delete an assistant', () => {
      const created = adapter.createAssistant({
        model: 'gpt-4',
        name: 'Test',
      });

      const deleted = adapter.deleteAssistant(created.id);
      expect(deleted).toBe(true);

      const retrieved = adapter.getAssistant(created.id);
      expect(retrieved).toBeUndefined();
    });

    it('should list assistants', () => {
      adapter.createAssistant({ model: 'gpt-4', name: 'First' });
      adapter.createAssistant({ model: 'gpt-4', name: 'Second' });

      const list = adapter.listAssistants();
      expect(list).toHaveLength(2);
    });
  });

  describe('Threads', () => {
    it('should create a thread', () => {
      const thread = adapter.createThread();

      expect(thread.id).toMatch(/^thread_/);
      expect(thread.object).toBe('thread');
      expect(thread.metadata).toEqual({});
    });

    it('should create a thread with metadata', () => {
      const thread = adapter.createThread({ key: 'value' });

      expect(thread.metadata).toEqual({ key: 'value' });
    });

    it('should get a thread', () => {
      const created = adapter.createThread();
      const retrieved = adapter.getThread(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
    });

    it('should delete a thread', () => {
      const created = adapter.createThread();
      const deleted = adapter.deleteThread(created.id);

      expect(deleted).toBe(true);
      expect(adapter.getThread(created.id)).toBeUndefined();
    });
  });

  describe('Messages', () => {
    let threadId: string;

    beforeEach(() => {
      const thread = adapter.createThread();
      threadId = thread.id;
    });

    it('should add a message to a thread', () => {
      const message = adapter.addMessage(threadId, {
        role: 'user',
        content: 'Hello!',
      });

      expect(message).toBeDefined();
      expect(message?.id).toMatch(/^msg_/);
      expect(message?.role).toBe('user');
      expect(message?.thread_id).toBe(threadId);
    });

    it('should list messages in a thread', () => {
      adapter.addMessage(threadId, { role: 'user', content: 'First' });
      adapter.addMessage(threadId, { role: 'user', content: 'Second' });

      const messages = adapter.listMessages(threadId);

      expect(messages).toHaveLength(2);
    });

    it('should list messages in descending order by default', () => {
      adapter.addMessage(threadId, { role: 'user', content: 'First' });
      adapter.addMessage(threadId, { role: 'user', content: 'Second' });

      const messages = adapter.listMessages(threadId);

      expect(messages[0].content[0]).toMatchObject({ type: 'text' });
    });

    it('should get a specific message', () => {
      const created = adapter.addMessage(threadId, {
        role: 'user',
        content: 'Test message',
      });

      const retrieved = adapter.getMessage(threadId, created!.id);

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
    it('should add a file', () => {
      const content = Buffer.from('test content');
      const file = manager.addFile(content, 'test.txt');

      expect(file.id).toMatch(/^file_/);
      expect(file.filename).toBe('test.txt');
    });

    it('should get a file', () => {
      const content = Buffer.from('test content');
      const created = manager.addFile(content, 'test.txt');

      const retrieved = manager.getFile(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.content.toString()).toBe('test content');
    });

    it('should delete a file', () => {
      const content = Buffer.from('test content');
      const created = manager.addFile(content, 'test.txt');

      const deleted = manager.deleteFile(created.id);

      expect(deleted).toBe(true);
      expect(manager.getFile(created.id)).toBeUndefined();
    });
  });

  describe('getMessagesForLLM', () => {
    it('should convert messages to LLM format', () => {
      const thread = manager.createThread();
      manager.addMessage(thread.id, { role: 'user', content: 'Hello' });
      manager.addAssistantMessage(thread.id, 'Hi there!', 'asst_1', 'run_1');

      const llmMessages = manager.getMessagesForLLM(thread.id);

      expect(llmMessages).toHaveLength(2);
      expect(llmMessages[0]).toEqual({ role: 'user', content: 'Hello' });
      expect(llmMessages[1]).toEqual({ role: 'assistant', content: 'Hi there!' });
    });
  });
});

