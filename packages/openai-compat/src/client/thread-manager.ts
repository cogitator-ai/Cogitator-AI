import { nanoid } from 'nanoid';
import type { ImageInput } from '@cogitator-ai/types';
import type {
  Thread,
  Message,
  MessageIncompleteReason,
  CreateMessageRequest,
  MessageContent,
  MessageContentPart,
  AssistantTool,
  FilePurpose,
  ResponseFormat,
} from '../types/openai-types';
import {
  type ThreadStorage,
  type StoredFile,
  type ListStoredThreadsOptions,
  type StoredThreadPage,
  InMemoryThreadStorage,
} from './storage';
import { cursorWindow } from './pagination';

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

export interface AssistantMessageParams {
  threadId: string;
  content: string;
  assistantId: string;
  runId: string;
  /** Default: a new `msg_` id */
  messageId?: string;
  /** Set for an answer the model did not finish: the message is then `incomplete` */
  incompleteReason?: MessageIncompleteReason;
  /** Unix seconds, default: now */
  createdAt?: number;
}

/** The assistant message of a run, `completed`, or `incomplete` with `incompleteReason`. */
export function assistantMessage(params: AssistantMessageParams): Message {
  const now = Math.floor(Date.now() / 1000);
  const { incompleteReason } = params;
  return {
    id: params.messageId ?? `msg_${nanoid()}`,
    object: 'thread.message',
    created_at: params.createdAt ?? now,
    thread_id: params.threadId,
    status: incompleteReason ? 'incomplete' : 'completed',
    ...(incompleteReason && { incomplete_details: { reason: incompleteReason } }),
    completed_at: incompleteReason ? null : now,
    incomplete_at: incompleteReason ? now : null,
    role: 'assistant',
    content: [{ type: 'text', text: { value: params.content, annotations: [] } }],
    assistant_id: params.assistantId,
    run_id: params.runId,
    attachments: null,
    metadata: {},
  };
}

export interface StoredThread {
  thread: Thread;
  messages: Message[];
  /**
   * Who may reach the thread: a digest of the API key that created it. Absent when the server
   * has no API keys, and on threads stored before key scoping, which every key reaches.
   */
  owner?: string;
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

  /** Create a thread, reachable only by `owner` when one is given (see {@link StoredThread.owner}). */
  async createThread(metadata?: Record<string, string>, owner?: string): Promise<Thread> {
    const id = `thread_${nanoid()}`;
    const thread: Thread = {
      id,
      object: 'thread',
      created_at: Math.floor(Date.now() / 1000),
      metadata: metadata ?? {},
    };

    const stored: StoredThread = { thread, messages: [], ...(owner !== undefined && { owner }) };
    await this.storage.saveThread(id, stored);
    return thread;
  }

  async getThread(id: string): Promise<Thread | undefined> {
    const stored = await this.getStoredThread(id);
    return stored?.thread;
  }

  /** The thread with its messages and owner, as storage holds it */
  async getStoredThread(id: string): Promise<StoredThread | undefined> {
    const stored = await this.storage.loadThread(id);
    return stored ?? undefined;
  }

  /** A page of stored threads, for operators: the API does not list threads. */
  async listThreads(options?: ListStoredThreadsOptions): Promise<StoredThreadPage> {
    return this.storage.listThreads(options);
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

  /**
   * Messages of a thread, newest first by default. `after` / `before` are message ids: `limit`
   * then takes the messages right after `after`, or right before `before`, in list order.
   */
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

    messages = cursorWindow(messages, { after: options?.after, before: options?.before });
    const limit = options?.limit;
    if (limit) {
      messages = options.before
        ? messages.slice(Math.max(0, messages.length - limit))
        : messages.slice(0, limit);
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
   * Pass `messageId` to keep the id already announced in stream events, and
   * `incompleteReason` for an answer the model did not finish (status `incomplete`).
   */
  async addAssistantMessage(
    threadId: string,
    content: string,
    assistantId: string,
    runId: string,
    messageId?: string,
    incompleteReason?: MessageIncompleteReason
  ): Promise<Message | undefined> {
    return this.appendMessage(
      threadId,
      assistantMessage({ threadId, content, assistantId, runId, messageId, incompleteReason })
    );
  }

  /**
   * Append a message built elsewhere (see {@link assistantMessage}). Writes to one thread keep
   * the order of the calls, so a caller that does not await one still stores it before the next.
   * Undefined when the thread does not exist.
   */
  async appendMessage(threadId: string, message: Message): Promise<Message | undefined> {
    return this.withLock(`thread:${threadId}`, async () => {
      const stored = await this.getStoredThread(threadId);
      if (!stored) return undefined;
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
