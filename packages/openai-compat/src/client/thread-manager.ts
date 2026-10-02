import { nanoid } from 'nanoid';
import type { ImageInput } from '@cogitator-ai/types';
import type {
  Thread,
  Message,
  CreateMessageRequest,
  MessageContent,
  MessageContentPart,
  AssistantTool,
  FilePurpose,
  ResponseFormat,
} from '../types/openai-types';
import { type ThreadStorage, type StoredFile, InMemoryThreadStorage } from './storage';

export interface LLMThreadMessage {
  role: 'user' | 'assistant';
  content: string;
  images?: ImageInput[];
}

type ImageMimeType = Extract<ImageInput, { mimeType: string }>['mimeType'];

const IMAGE_MIME_BY_EXTENSION: Record<string, ImageMimeType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

const ASSISTANT_UPDATABLE_FIELDS = [
  'model',
  'name',
  'description',
  'instructions',
  'tools',
  'metadata',
  'temperature',
  'top_p',
  'response_format',
] as const;

export interface StoredThread {
  thread: Thread;
  messages: Message[];
}

export interface StoredAssistant {
  id: string;
  name: string | null;
  description?: string | null;
  model: string;
  instructions: string | null;
  tools: AssistantTool[];
  metadata: Record<string, string>;
  temperature?: number;
  top_p?: number;
  response_format?: ResponseFormat;
  created_at: number;
}

export interface CreateAssistantParams {
  model: string;
  name?: string;
  description?: string;
  instructions?: string;
  tools?: AssistantTool[];
  metadata?: Record<string, string>;
  temperature?: number;
  top_p?: number;
  response_format?: ResponseFormat;
}

export type UpdateAssistantParams = Partial<Omit<StoredAssistant, 'id' | 'created_at'>>;

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
  private locks = new Map<string, Promise<void>>();

  /**
   * Storage is the single source of truth (no in-process cache), so several
   * server instances can share Redis/PostgreSQL storage without serving stale
   * data. Read-modify-write operations on one thread are serialized per process.
   */
  constructor(storage?: ThreadStorage) {
    this.storage = storage ?? new InMemoryThreadStorage();
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => current);
    this.locks.set(key, chained);
    try {
      await previous;
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === chained) {
        this.locks.delete(key);
      }
    }
  }

  async createAssistant(params: CreateAssistantParams): Promise<StoredAssistant> {
    const id = `asst_${nanoid()}`;
    const assistant: StoredAssistant = {
      id,
      name: params.name ?? null,
      description: params.description ?? null,
      model: params.model,
      instructions: params.instructions ?? null,
      tools: params.tools ?? [],
      metadata: params.metadata ?? {},
      temperature: params.temperature,
      top_p: params.top_p,
      response_format: params.response_format,
      created_at: Math.floor(Date.now() / 1000),
    };

    await this.storage.saveAssistant(id, assistant);
    return assistant;
  }

  async getAssistant(id: string): Promise<StoredAssistant | undefined> {
    const assistant = await this.storage.loadAssistant(id);
    return assistant ?? undefined;
  }

  async updateAssistant(
    id: string,
    updates: UpdateAssistantParams
  ): Promise<StoredAssistant | undefined> {
    return this.withLock(`assistant:${id}`, async () => {
      const assistant = await this.getAssistant(id);
      if (!assistant) return undefined;

      const target = assistant as unknown as Record<string, unknown>;
      const source = updates as Record<string, unknown>;
      for (const field of ASSISTANT_UPDATABLE_FIELDS) {
        if (source[field] !== undefined) {
          target[field] = source[field];
        }
      }
      await this.storage.saveAssistant(id, assistant);
      return assistant;
    });
  }

  async deleteAssistant(id: string): Promise<boolean> {
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
    return thread;
  }

  async getThread(id: string): Promise<Thread | undefined> {
    const stored = await this.getStoredThread(id);
    return stored?.thread;
  }

  private async getStoredThread(id: string): Promise<StoredThread | undefined> {
    const stored = await this.storage.loadThread(id);
    return stored ?? undefined;
  }

  async updateThread(
    id: string,
    updates: { metadata?: Record<string, string> }
  ): Promise<Thread | undefined> {
    return this.withLock(`thread:${id}`, async () => {
      const stored = await this.getStoredThread(id);
      if (!stored) return undefined;

      if (updates.metadata) {
        stored.thread.metadata = { ...stored.thread.metadata, ...updates.metadata };
      }

      await this.storage.saveThread(id, stored);
      return stored.thread;
    });
  }

  async deleteThread(id: string): Promise<boolean> {
    return this.withLock(`thread:${id}`, () => this.storage.deleteThread(id));
  }

  async addMessage(threadId: string, request: CreateMessageRequest): Promise<Message | undefined> {
    return this.withLock(`thread:${threadId}`, async () => {
      const stored = await this.getStoredThread(threadId);
      if (!stored) return undefined;

      const now = Math.floor(Date.now() / 1000);
      const message: Message = {
        id: `msg_${nanoid()}`,
        object: 'thread.message',
        created_at: now,
        thread_id: threadId,
        status: 'completed',
        completed_at: now,
        incomplete_at: null,
        role: request.role,
        content: this.normalizeContent(request.content),
        assistant_id: null,
        run_id: null,
        attachments: request.attachments ?? null,
        metadata: request.metadata ?? {},
      };

      stored.messages.push(message);
      await this.storage.saveThread(threadId, stored);
      return message;
    });
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

    let messages = options?.order === 'asc' ? [...stored.messages] : [...stored.messages].reverse();

    if (options?.run_id) {
      messages = messages.filter((m) => m.run_id === options.run_id);
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
  async getMessagesForLLM(threadId: string): Promise<LLMThreadMessage[]> {
    const messages = await this.listMessages(threadId, { order: 'asc' });
    const result: LLMThreadMessage[] = [];

    for (const msg of messages) {
      const images = await this.extractImages(msg.content);
      result.push({
        role: msg.role,
        content: this.extractTextContent(msg.content),
        ...(images.length > 0 && { images }),
      });
    }

    return result;
  }

  /**
   * Add an assistant message (from LLM response).
   * Pass `messageId` to keep the id already announced in stream events.
   */
  async addAssistantMessage(
    threadId: string,
    content: string,
    assistantId: string,
    runId: string,
    messageId?: string
  ): Promise<Message | undefined> {
    return this.withLock(`thread:${threadId}`, async () => {
      const stored = await this.getStoredThread(threadId);
      if (!stored) return undefined;

      const now = Math.floor(Date.now() / 1000);
      const message: Message = {
        id: messageId ?? `msg_${nanoid()}`,
        object: 'thread.message',
        created_at: now,
        thread_id: threadId,
        status: 'completed',
        completed_at: now,
        incomplete_at: null,
        role: 'assistant',
        content: [{ type: 'text', text: { value: content, annotations: [] } }],
        assistant_id: assistantId,
        run_id: runId,
        attachments: null,
        metadata: {},
      };

      stored.messages.push(message);
      await this.storage.saveThread(threadId, stored);
      return message;
    });
  }

  async addFile(
    content: Buffer,
    filename: string,
    purpose: FilePurpose = 'assistants'
  ): Promise<{ id: string; filename: string; created_at: number; purpose: FilePurpose }> {
    const id = `file_${nanoid()}`;
    const created_at = Math.floor(Date.now() / 1000);

    const file: StoredFile = { id, content, filename, created_at, purpose };
    await this.storage.saveFile(id, file);

    return { id, filename, created_at, purpose };
  }

  async getFile(id: string): Promise<StoredFile | undefined> {
    const file = await this.storage.loadFile(id);
    return file ?? undefined;
  }

  async deleteFile(id: string): Promise<boolean> {
    return this.storage.deleteFile(id);
  }

  async listFiles(): Promise<StoredFile[]> {
    return this.storage.listFiles();
  }

  /**
   * Resolve image parts to Cogitator image inputs: URLs are passed through,
   * uploaded image files are inlined as base64.
   */
  private async extractImages(content: MessageContent[]): Promise<ImageInput[]> {
    const images: ImageInput[] = [];
    for (const part of content) {
      if (part.type === 'image_url') {
        images.push(part.image_url.url);
      } else if (part.type === 'image_file') {
        const file = await this.getFile(part.image_file.file_id);
        const extension = file?.filename.split('.').pop()?.toLowerCase() ?? '';
        const mimeType = IMAGE_MIME_BY_EXTENSION[extension];
        if (file && mimeType) {
          images.push({ data: file.content.toString('base64'), mimeType });
        }
      }
    }
    return images;
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
