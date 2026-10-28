import type {
  ImageInput,
  MemoryEntry,
  MessageContent,
  QueuedRunMessage,
  RunInterrupt,
  RunResult,
  Thread,
} from '@cogitator-ai/types';
import {
  toPendingApprovals,
  toPendingInterrupts,
  toRunUsage,
  type PendingInterrupt,
} from '@cogitator-ai/server-shared';
import type {
  QueuedMessage,
  ThreadInfo,
  ThreadMessage,
  ThreadStatus,
  TurnPending,
  TurnUsage,
  UserInput,
} from '../protocol/types.js';
import { PermissionModeSchema } from '../protocol/common.js';
import type { ThreadLogEntrySchema } from '../protocol/session.js';
import type { z } from 'zod';

/** The thread metadata keys the host reads and writes */
export const THREAD_KEYS = {
  agent: 'agent',
  permissionMode: 'permissionMode',
  forkedFrom: 'forkedFrom',
  archived: 'archived',
  reviewOf: 'reviewOf',
} as const;

/** What a run takes of the input parts of a turn: its text and its images */
export function toRunInput(input: readonly UserInput[]): { input: string; images?: ImageInput[] } {
  const texts: string[] = [];
  const images: ImageInput[] = [];
  for (const part of input) {
    if (part.type === 'text') texts.push(part.text);
    else if ('url' in part) images.push(part.url);
    else images.push({ data: part.data, mimeType: part.mimeType });
  }
  return { input: texts.join('\n\n'), ...(images.length > 0 && { images }) };
}

/** The input parts as one message a run's queue takes */
export function toMessageContent(input: readonly UserInput[]): MessageContent {
  if (input.every((part) => part.type === 'text')) {
    return input.map((part) => (part.type === 'text' ? part.text : '')).join('\n\n');
  }
  return input.map((part) => {
    if (part.type === 'text') return { type: 'text' as const, text: part.text };
    if ('url' in part) return { type: 'image_url' as const, image_url: { url: part.url } };
    return {
      type: 'image_url' as const,
      image_url: { url: `data:${part.mimeType};base64,${part.data}` },
    };
  });
}

/** A message content back as input parts */
export function toUserInput(content: MessageContent): UserInput[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.map((part): UserInput => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image_url') return { type: 'image', url: part.image_url.url };
    return { type: 'image', data: part.image_base64.data, mimeType: part.image_base64.media_type };
  });
}

export function toQueuedMessages(messages: readonly QueuedRunMessage[]): QueuedMessage[] {
  return messages.map((message) => ({
    delivery: message.kind,
    input: toUserInput(message.content),
  }));
}

/** The text of a message content, its text parts joined */
export function textOf(content: MessageContent | undefined): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((part) => part.type === 'text')
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

export function toThreadMessage(entry: MemoryEntry): ThreadMessage {
  return {
    entryId: entry.id,
    role: entry.message.role,
    text: textOf(entry.message.content),
    createdAt: entry.createdAt.toISOString(),
  };
}

export function toThreadLogEntry(entry: MemoryEntry): z.output<typeof ThreadLogEntrySchema> {
  const conversation = entry.type === undefined || entry.type === 'message';
  return {
    id: entry.id,
    type: entry.type ?? 'message',
    ...((conversation || entry.type === 'tool_result') && { role: entry.message.role }),
    ...((conversation || entry.type === 'tool_result') && {
      text: textOf(entry.message.content),
    }),
    ...(entry.parentId !== undefined && { parentId: entry.parentId }),
    createdAt: entry.createdAt.toISOString(),
  };
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A thread as the protocol shows it */
export function toThreadInfo(
  thread: Thread,
  state: { status: ThreadStatus; activeTurnId?: string }
): ThreadInfo {
  const agent = stringOf(thread.metadata[THREAD_KEYS.agent]);
  const forkedFrom = stringOf(thread.metadata[THREAD_KEYS.forkedFrom]);
  const mode = PermissionModeSchema.safeParse(thread.metadata[THREAD_KEYS.permissionMode]);
  return {
    id: thread.id,
    ...(agent !== undefined && { agent }),
    status: state.status,
    archived: thread.metadata[THREAD_KEYS.archived] === true,
    ...(state.activeTurnId !== undefined && { activeTurnId: state.activeTurnId }),
    ...(forkedFrom !== undefined && { forkedFrom }),
    ...(mode.success && { permissionMode: mode.data }),
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
    metadata: jsonCopy(thread.metadata),
  };
}

export function toTurnUsage(usage: RunResult['usage']): TurnUsage {
  return { ...toRunUsage(usage), cost: usage.cost, durationMs: usage.duration };
}

/** What a paused run waits on, from its result */
export function pendingOfResult(result: RunResult): TurnPending {
  return {
    approvals: toPendingApprovals(result.pendingApprovals ?? []),
    interrupts: toPendingInterrupts(result.interrupts ?? []),
  };
}

/** What a paused run waits on, from its checkpoint: every interrupt, approvals among them */
export function pendingOfInterrupts(interrupts: readonly RunInterrupt[]): TurnPending {
  return {
    approvals: [],
    interrupts: interrupts.map((entry): PendingInterrupt => ({
      id: entry.id,
      kind: entry.kind,
      reason: entry.reason,
      message: entry.message,
      ...(entry.responseSchema !== undefined && { responseSchema: entry.responseSchema }),
      ...(entry.expiresAt !== undefined && { expiresAt: entry.expiresAt }),
      ...(entry.toolCallId !== undefined && { toolCallId: entry.toolCallId }),
      ...(entry.toolName !== undefined && { toolName: entry.toolName }),
    })),
  };
}

/** `value` as plain JSON: dates as ISO strings, functions and undefined left out */
export function jsonCopy<T>(value: T): Record<string, unknown> & T {
  return JSON.parse(JSON.stringify(value ?? {})) as Record<string, unknown> & T;
}
