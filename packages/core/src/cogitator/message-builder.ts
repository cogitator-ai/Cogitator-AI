import type {
  Message,
  RunOptions,
  MemoryAdapter,
  MemoryResult,
  ToolCall,
  ToolResult,
  ContentPart,
  ImageInput,
  AudioInput,
} from '@cogitator-ai/types';
import { ContextBuilder, countMessageTokens } from '@cogitator-ai/memory';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { getLogger } from '../logger';
import { ensureThreadAccess, threadMetadata } from './threads';
import type { Agent } from '../agent';
import type { ReflectionEngine } from '../reflection/index';
import type { AgentContext } from '@cogitator-ai/types';
import { sanitizeToolHistory } from '../utils/tool-history';
import { transcribeAudio } from '../tools/audio-transcribe';

/**
 * Transcribe run audio inputs and prepend the transcripts to the user's text input.
 */
export async function buildInputWithAudio(
  input: string,
  audio: AudioInput[] | undefined,
  options: { apiKey?: string; signal?: AbortSignal }
): Promise<string> {
  if (!audio || audio.length === 0) {
    return input;
  }

  if (!options.apiKey) {
    throw new CogitatorError({
      message:
        'Audio inputs require an OpenAI API key for transcription. Set llm.providers.openai.apiKey or OPENAI_API_KEY.',
      code: ErrorCode.CONFIGURATION_ERROR,
    });
  }

  const transcripts: string[] = [];
  for (const item of audio) {
    const result = await transcribeAudio(item, { apiKey: options.apiKey, signal: options.signal });
    transcripts.push(result.text);
  }

  const block =
    transcripts.length === 1
      ? `[Audio transcription]: ${transcripts[0]}`
      : transcripts.map((text, i) => `[Audio ${i + 1} transcription]: ${text}`).join('\n');

  return input ? `${block}\n\n${input}` : block;
}

function buildUserContent(input: string, images?: ImageInput[]): string | ContentPart[] {
  if (!images || images.length === 0) {
    return input;
  }

  const parts: ContentPart[] = [{ type: 'text', text: input }];

  for (const image of images) {
    if (typeof image === 'string') {
      parts.push({
        type: 'image_url',
        image_url: { url: image, detail: 'auto' },
      });
    } else {
      parts.push({
        type: 'image_base64',
        image_base64: {
          data: image.data,
          media_type: image.mimeType,
        },
      });
    }
  }

  return parts;
}

export async function buildInitialMessages(
  agent: Agent,
  options: RunOptions,
  threadId: string,
  memoryAdapter: MemoryAdapter | undefined,
  contextBuilder: ContextBuilder | undefined
): Promise<Message[]> {
  const userContent = buildUserContent(options.input, options.images);

  if (!memoryAdapter || options.useMemory === false) {
    return [
      { role: 'system', content: agent.instructions },
      { role: 'user', content: userContent },
    ];
  }

  if (options.threadId !== undefined && options.threadAccess !== 'shared') {
    await ensureThreadAccess(memoryAdapter, threadId, {
      agentId: agent.id,
      userId: options.userId,
    });
  } else {
    try {
      await createThreadIfMissing(memoryAdapter, threadId, agent.id, options.userId);
    } catch (err) {
      reportMemoryError(err, 'load', options.onMemoryError);
    }
  }

  if (contextBuilder && options.loadHistory !== false) {
    const ctx = await contextBuilder.build({
      threadId,
      agentId: agent.id,
      userId: options.userId,
      systemPrompt: agent.instructions,
      currentInput: options.input,
    });
    for (const warning of ctx.warnings ?? []) {
      getLogger().warn(warning, { agent: agent.name, threadId });
    }
    for (const { source, error } of ctx.errors ?? []) {
      reportMemoryError(
        new Error(`Memory context (${source}) could not be loaded: ${error.message}`, {
          cause: error,
        }),
        'load',
        options.onMemoryError
      );
    }
    return [
      ...withInstructions(sanitizeToolHistory(ctx.messages), agent.instructions),
      { role: 'user', content: userContent },
    ];
  }

  if (options.loadHistory !== false) {
    const entries = await memoryAdapter.getEntries({ threadId, limit: 20 });
    const messages: Message[] = [{ role: 'system', content: agent.instructions }];
    if (entries.success) {
      messages.push(...sanitizeToolHistory(entries.data.map((e) => e.message)));
    } else {
      reportMemoryError(
        new Error(`Memory getEntries failed: ${entries.error}`),
        'load',
        options.onMemoryError
      );
    }
    messages.push({ role: 'user', content: userContent });
    return messages;
  }

  return [
    { role: 'system', content: agent.instructions },
    { role: 'user', content: userContent },
  ];
}

/**
 * `messages` opening with a system message that starts with the agent's
 * instructions, which the rest of a run (run context, insights, handoffs)
 * builds on. A context without them gets them put in front of its own
 * system message, or as a new one.
 */
function withInstructions(messages: Message[], instructions: string): Message[] {
  const [first, ...rest] = messages;
  if (first?.role !== 'system') return [{ role: 'system', content: instructions }, ...messages];
  if (typeof first.content === 'string') {
    if (first.content.startsWith(instructions)) return messages;
    return [{ ...first, content: `${instructions}\n\n${first.content}` }, ...rest];
  }
  return [{ ...first, content: [{ type: 'text', text: instructions }, ...first.content] }, ...rest];
}

/** The value of a memory operation, or an error naming the operation that failed. */
function unwrap<T>(result: MemoryResult<T>, operation: string): T {
  if (!result.success) throw new Error(`Memory ${operation} failed: ${result.error}`);
  return result.data;
}

/**
 * Creates thread `threadId`, owned by `userId`, unless it exists. A thread
 * that cannot be read is left alone: creating it would overwrite its owner.
 */

async function createThreadIfMissing(
  memoryAdapter: MemoryAdapter,
  threadId: string,
  agentId: string,
  userId: string | undefined
): Promise<void> {
  const thread = unwrap(await memoryAdapter.getThread(threadId), 'getThread');
  if (!thread) {
    unwrap(
      await memoryAdapter.createThread(agentId, threadMetadata({ agentId, userId }), threadId),
      'createThread'
    );
  }
}

export async function saveEntry(
  threadId: string,
  agentId: string,
  message: Message,
  memoryAdapter: MemoryAdapter | undefined,
  toolCalls?: ToolCall[],
  toolResults?: ToolResult[],
  onError?: (error: Error, operation: 'save' | 'load') => void,
  userId?: string
): Promise<void> {
  if (!memoryAdapter) return;

  try {
    await createThreadIfMissing(memoryAdapter, threadId, agentId, userId);

    unwrap(
      await memoryAdapter.addEntry({
        threadId,
        message,
        toolCalls,
        toolResults,
        tokenCount: countMessageTokens(message),
      }),
      'addEntry'
    );
  } catch (err) {
    reportMemoryError(err, 'save', onError);
  }
}

/** Logs a memory failure and hands it to the run's `onMemoryError`; the run goes on. */
function reportMemoryError(
  err: unknown,
  operation: 'save' | 'load',
  onError: ((error: Error, operation: 'save' | 'load') => void) | undefined
): void {
  const error = err instanceof Error ? err : new Error(String(err));
  getLogger().warn(`Failed to ${operation} memory`, { error: error.message });
  onError?.(error, operation);
}

export async function enrichMessagesWithInsights(
  messages: Message[],
  reflectionEngine: ReflectionEngine,
  agentContext: AgentContext
): Promise<void> {
  const insights = await reflectionEngine.getRelevantInsights(agentContext);
  if (insights.length > 0 && messages.length > 0 && messages[0].role === 'system') {
    const suffix = `\n\nPast learnings that may help:\n${insights.map((i) => `- ${i.content}`).join('\n')}`;
    const content = messages[0].content;
    if (typeof content === 'string') {
      messages[0].content = content + suffix;
    } else if (Array.isArray(content)) {
      messages[0].content = [...content, { type: 'text' as const, text: suffix }];
    } else {
      messages[0].content = suffix;
    }
  }
}

export function addContextToMessages(messages: Message[], context: Record<string, unknown>): void {
  if (messages.length > 0 && messages[0].role === 'system') {
    const contextStr = Object.entries(context)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join('\n');
    const suffix = `\n\nContext:\n${contextStr}`;
    const content = messages[0].content;
    if (typeof content === 'string') {
      messages[0].content = content + suffix;
    } else if (Array.isArray(content)) {
      messages[0].content = [...content, { type: 'text' as const, text: suffix }];
    } else {
      messages[0].content = suffix;
    }
  }
}
