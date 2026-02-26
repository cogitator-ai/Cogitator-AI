import { nanoid } from 'nanoid';
import type {
  Thread,
  Message,
  CreateMessageRequest,
  MessageContent,
  MessageContentPart,
  AssistantTool,
} from '../types/openai-types';
import { type ThreadStorage, type StoredFile, InMemoryThreadStorage } from './storage';

export interface StoredThread {
  thread: Thread;
  messages: Message[];
}

export interface StoredAssistant {
  id: string;
  name: string | null;
  model: string;
  instructions: string | null;
  tools: AssistantTool[];
  metadata: Record<string, string>;
  temperature?: number;
  created_at: number;
}

/**
 * Manages threads, messages, and assistants with pluggable storage.
 *
 * By default uses in-memory storage. For production, use Redis or PostgreSQL.
 *
 * @example In-memory (default)
 * ```ts
 * const manager = new ThreadManager();
 * ```
 *
 * @example Redis persistence
 * ```ts
 * import { RedisThreadStorage, ThreadManager } from '@cogitator-ai/openai-compat';
 *
 * const storage = new RedisThreadStorage({ url: 'redis://localhost:6379' });
 * await storage.connect();
 *
 * const manager = new ThreadManager(storage);
 * ```
 *
 * @example PostgreSQL persistence
 * ```ts
 * import { PostgresThreadStorage, ThreadManager } from '@cogitator-ai/openai-compat';
 *
 * const storage = new PostgresThreadStorage({
 *   connectionString: 'postgresql://user:pass@localhost/db',
 * });
 * await storage.connect();
 *
 * const manager = new ThreadManager(storage);
 * ```
 */
export class ThreadManager {
  private storage: ThreadStorage;
  private cache = {
    threads: new Map<string, StoredThread>(),
    assistants: new Map<string, StoredAssistant>(),
    files: new Map<string, StoredFile>(),
  };

  constructor(storage?: ThreadStorage) {
    this.storage = storage ?? new InMemoryThreadStorage();
  }

  async createAssistant(params: {
    model: string;
    name?: string;
    instructions?: string;
    tools?: AssistantTool[];
    metadata?: Record<string, string>;
    temperature?: number;
  }): Promise<StoredAssistant> {
    const id = `asst_${nanoid()}`;
    const assistant: StoredAssistant = {
      id,
      name: params.name ?? null,
      model: params.model,
      instructions: params.instructions ?? null,
      tools: params.tools ?? [],
      metadata: params.metadata ?? {},
      temperature: params.temperature,
      created_at: Math.floor(Date.now() / 1000),
    };

    await this.storage.saveAssistant(id, assistant);
    this.cache.assistants.set(id, assistant);
    return assistant;
  }

  async getAssistant(id: string): Promise<StoredAssistant | undefined> {
    if (this.cache.assistants.has(id)) {
      return this.cache.assistants.get(id);
    }
    const assistant = await this.storage.loadAssistant(id);
    if (assistant) {
      this.cache.assistants.set(id, assistant);
    }
    return assistant ?? undefined;
  }

  async updateAssistant(
    id: string,
    updates: Partial<Omit<StoredAssistant, 'id' | 'created_at'>>
  ): Promise<StoredAssistant | undefined> {
    const assistant = await this.getAssistant(id);
    if (!assistant) return undefined;

    Object.assign(assistant, updates);
    await this.storage.saveAssistant(id, assistant);
    return assistant;
  }

  async deleteAssistant(id: string): Promise<boolean> {
    this.cache.assistants.delete(id);
    return this.storage.deleteAssistant(id);
  }

  async listAssistants(): Promise<StoredAssistant[]> {
    return this.storage.listAssistants();
  }

  async createThread(metadata?: Record<string, string>): Promise<Thread> {
    const id = `thread_${nanoid()}`;
    const thread: Thread = {
      id,
      object: 'thread',
      created_at: Math.floor(Date.now() / 1000),
      metadata: metadata ?? {},
    };

    const stored: StoredThread = { thread, messages: [] };
    await this.storage.saveThread(id, stored);
    this.cache.threads.set(id, stored);
    return thread;
  }

  async getThread(id: string): Promise<Thread | undefined> {
    const stored = await this.getStoredThread(id);
    return stored?.thread;
  }

  private async getStoredThread(id: string): Promise<StoredThread | undefined> {
    if (this.cache.threads.has(id)) {
      return this.cache.threads.get(id);
    }
    const stored = await this.storage.loadThread(id);
    if (stored) {
      this.cache.threads.set(id, stored);
    }
    return stored ?? undefined;
  }

  async updateThread(
    id: string,
    updates: { metadata?: Record<string, string> }
  ): Promise<Thread | undefined> {
    const stored = await this.getStoredThread(id);
    if (!stored) return undefined;

    if (updates.metadata) {
      Object.assign(stored.thread.metadata, updates.metadata);
    }

    await this.storage.saveThread(id, stored);
    return stored.thread;
  }

  async deleteThread(id: string): Promise<boolean> {
    this.cache.threads.delete(id);
    return this.storage.deleteThread(id);
  }

  async addMessage(threadId: string, request: CreateMessageRequest): Promise<Message | undefined> {
    const stored = await this.getStoredThread(threadId);
    if (!stored) return undefined;

    const id = `msg_${nanoid()}`;
    const now = Math.floor(Date.now() / 1000);

    const content: MessageContent[] = this.normalizeContent(request.content);

    const message: Message = {
      id,
      object: 'thread.message',
      created_at: now,
      thread_id: threadId,
      status: 'completed',
      completed_at: now,
      incomplete_at: null,
      role: request.role,
      content,
      assistant_id: null,
      run_id: null,
      attachments: request.attachments ?? null,
      metadata: request.metadata ?? {},
    };

    stored.messages.push(message);
    await this.storage.saveThread(threadId, stored);
    return message;
  }

  async getMessage(threadId: string, messageId: string): Promise<Message | undefined> {
    const stored = await this.getStoredThread(threadId);
    return stored?.messages.find((m) => m.id === messageId);
  }

  async listMessages(
    threadId: string,
    options?: {
      limit?: number;
      order?: 'asc' | 'desc';
      after?: string;
      before?: string;
      run_id?: string;
    }
  ): Promise<Message[]> {
    const stored = await this.getStoredThread(threadId);
    if (!stored) return [];

    let messages = [...stored.messages];

    if (options?.run_id) {
      messages = messages.filter((m) => m.run_id === options.run_id);
    }

    if (options?.order === 'asc') {
      messages.sort((a, b) => a.created_at - b.created_at);
    } else {
      messages.sort((a, b) => b.created_at - a.created_at);
    }

    if (options?.after) {
      const idx = messages.findIndex((m) => m.id === options.after);
      if (idx !== -1) {
        messages = messages.slice(idx + 1);
      }
    }

    if (options?.before) {
      const idx = messages.findIndex((m) => m.id === options.before);
      if (idx !== -1) {
        messages = messages.slice(0, idx);
      }
    }

    if (options?.limit) {
      messages = messages.slice(0, options.limit);
    }

    return messages;
  }

  /**
   * Get messages in Cogitator format for LLM calls
   */
  async getMessagesForLLM(
    threadId: string
  ): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
    const messages = await this.listMessages(threadId, { order: 'asc' });

    return messages.map((msg) => ({
      role: msg.role,
      content: this.extractTextContent(msg.content),
    }));
  }

  /**
   * Add an assistant message (from LLM response)
   */
  async addAssistantMessage(
    threadId: string,
    content: string,
    assistantId: string,
    runId: string
  ): Promise<Message | undefined> {
    const stored = await this.getStoredThread(threadId);
    if (!stored) return undefined;

    const id = `msg_${nanoid()}`;
    const now = Math.floor(Date.now() / 1000);

    const message: Message = {
      id,
      object: 'thread.message',
      created_at: now,
      thread_id: threadId,
      status: 'completed',
      completed_at: now,
      incomplete_at: null,
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: {
            value: content,
            annotations: [],
          },
        },
      ],
      assistant_id: assistantId,
      run_id: runId,
      attachments: null,
      metadata: {},
    };

    stored.messages.push(message);
    await this.storage.saveThread(threadId, stored);
    return message;
  }

  async addFile(
    content: Buffer,
    filename: string
  ): Promise<{ id: string; filename: string; created_at: number }> {
    const id = `file_${nanoid()}`;
    const created_at = Math.floor(Date.now() / 1000);

    const file: StoredFile = { id, content, filename, created_at };
    await this.storage.saveFile(id, file);
    this.cache.files.set(id, file);

    return { id, filename, created_at };
  }

  async getFile(
    id: string
  ): Promise<{ id: string; content: Buffer; filename: string; created_at: number } | undefined> {
    if (this.cache.files.has(id)) {
      return this.cache.files.get(id);
    }
    const file = await this.storage.loadFile(id);
    if (file) {
      this.cache.files.set(id, file);
    }
    return file ?? undefined;
  }

  async deleteFile(id: string): Promise<boolean> {
    this.cache.files.delete(id);
    return this.storage.deleteFile(id);
  }

  async listFiles(): Promise<
    { id: string; content: Buffer; filename: string; created_at: number }[]
  > {
    return this.storage.listFiles();
  }

  private normalizeContent(content: string | MessageContentPart[]): MessageContent[] {
    if (typeof content === 'string') {
      return [
        {
          type: 'text',
          text: {
            value: content,
            annotations: [],
          },
        },
      ];
    }

    return content.map((part): MessageContent => {
      if (part.type === 'text') {
        return {
          type: 'text',
          text: {
            value: part.text,
            annotations: [],
          },
        };
      }
      if (part.type === 'image_url') {
        return {
          type: 'image_url',
          image_url: part.image_url,
        };
      }
      return {
        type: 'image_file',
        image_file: part.image_file,
      };
    });
  }

  private extractTextContent(content: MessageContent[]): string {
    return content
      .filter((c): c is MessageContent & { type: 'text' } => c.type === 'text')
      .map((c) => c.text.value)
      .join('\n');
  }
}
