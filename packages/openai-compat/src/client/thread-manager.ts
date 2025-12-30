/**
 * Thread Manager
 *
 * Manages the mapping between OpenAI threads and Cogitator internal state.
 */

import { nanoid } from 'nanoid';
import type {
  Thread,
  Message,
  CreateMessageRequest,
  MessageContent,
} from '../types/openai-types.js';

export interface StoredThread {
  thread: Thread;
  messages: Message[];
}

export interface StoredAssistant {
  id: string;
  name: string | null;
  model: string;
  instructions: string | null;
  tools: unknown[];
  metadata: Record<string, string>;
  temperature?: number;
  created_at: number;
}

/**
 * Manages threads, messages, and assistants in memory
 *
 * In production, this should be backed by a database
 */
export class ThreadManager {
  private threads = new Map<string, StoredThread>();
  private assistants = new Map<string, StoredAssistant>();
  private files = new Map<string, { id: string; content: Buffer; filename: string; created_at: number }>();


  createAssistant(params: {
    model: string;
    name?: string;
    instructions?: string;
    tools?: unknown[];
    metadata?: Record<string, string>;
    temperature?: number;
  }): StoredAssistant {
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

    this.assistants.set(id, assistant);
    return assistant;
  }

  getAssistant(id: string): StoredAssistant | undefined {
    return this.assistants.get(id);
  }

  updateAssistant(id: string, updates: Partial<Omit<StoredAssistant, 'id' | 'created_at'>>): StoredAssistant | undefined {
    const assistant = this.assistants.get(id);
    if (!assistant) return undefined;

    Object.assign(assistant, updates);
    return assistant;
  }

  deleteAssistant(id: string): boolean {
    return this.assistants.delete(id);
  }

  listAssistants(): StoredAssistant[] {
    return Array.from(this.assistants.values());
  }


  createThread(metadata?: Record<string, string>): Thread {
    const id = `thread_${nanoid()}`;
    const thread: Thread = {
      id,
      object: 'thread',
      created_at: Math.floor(Date.now() / 1000),
      metadata: metadata ?? {},
    };

    this.threads.set(id, { thread, messages: [] });
    return thread;
  }

  getThread(id: string): Thread | undefined {
    return this.threads.get(id)?.thread;
  }

  deleteThread(id: string): boolean {
    return this.threads.delete(id);
  }


  addMessage(threadId: string, request: CreateMessageRequest): Message | undefined {
    const stored = this.threads.get(threadId);
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
    return message;
  }

  getMessage(threadId: string, messageId: string): Message | undefined {
    const stored = this.threads.get(threadId);
    return stored?.messages.find((m) => m.id === messageId);
  }

  listMessages(threadId: string, options?: {
    limit?: number;
    order?: 'asc' | 'desc';
    after?: string;
    before?: string;
    run_id?: string;
  }): Message[] {
    const stored = this.threads.get(threadId);
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
  getMessagesForLLM(threadId: string): Array<{ role: 'user' | 'assistant'; content: string }> {
    const messages = this.listMessages(threadId, { order: 'asc' });
    
    return messages.map((msg) => ({
      role: msg.role,
      content: this.extractTextContent(msg.content),
    }));
  }

  /**
   * Add an assistant message (from LLM response)
   */
  addAssistantMessage(
    threadId: string,
    content: string,
    assistantId: string,
    runId: string
  ): Message | undefined {
    const stored = this.threads.get(threadId);
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
    return message;
  }


  addFile(content: Buffer, filename: string): { id: string; filename: string; created_at: number } {
    const id = `file_${nanoid()}`;
    const created_at = Math.floor(Date.now() / 1000);
    
    this.files.set(id, { id, content, filename, created_at });
    
    return { id, filename, created_at };
  }

  getFile(id: string): { id: string; content: Buffer; filename: string; created_at: number } | undefined {
    return this.files.get(id);
  }

  deleteFile(id: string): boolean {
    return this.files.delete(id);
  }


  private normalizeContent(content: string | unknown[]): MessageContent[] {
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

    return (content as Array<{ type: string; text?: string }>).map((part) => {
      if (part.type === 'text' && typeof part.text === 'string') {
        return {
          type: 'text' as const,
          text: {
            value: part.text,
            annotations: [],
          },
        };
      }
      return part as MessageContent;
    });
  }

  private extractTextContent(content: MessageContent[]): string {
    return content
      .filter((c) => c.type === 'text')
      .map((c) => (c as { type: 'text'; text: { value: string } }).text.value)
      .join('\n');
  }
}

