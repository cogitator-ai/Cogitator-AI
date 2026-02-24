import type {
  Message,
  RunOptions,
  MemoryAdapter,
  ToolCall,
  ToolResult,
  ContentPart,
  ImageInput,
} from '@cogitator-ai/types';
import { ContextBuilder, countMessageTokens } from '@cogitator-ai/memory';
import { getLogger } from '../logger';
import type { Agent } from '../agent';
import type { ReflectionEngine } from '../reflection/index';
import type { AgentContext } from '@cogitator-ai/types';

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

  const threadResult = await memoryAdapter.getThread(threadId);
  if (!threadResult.success || !threadResult.data) {
    await memoryAdapter.createThread(agent.id, { agentId: agent.id }, threadId);
  }

  if (contextBuilder && options.loadHistory !== false) {
    const ctx = await contextBuilder.build({
      threadId,
      agentId: agent.id,
      systemPrompt: agent.instructions,
    });
    return [...ctx.messages, { role: 'user', content: userContent }];
  }

  if (options.loadHistory !== false) {
    const entries = await memoryAdapter.getEntries({ threadId, limit: 20 });
    const messages: Message[] = [{ role: 'system', content: agent.instructions }];
    if (entries.success) {
      messages.push(...entries.data.map((e) => e.message));
    }
    messages.push({ role: 'user', content: userContent });
    return messages;
  }

  return [
    { role: 'system', content: agent.instructions },
    { role: 'user', content: userContent },
  ];
}

export async function saveEntry(
  threadId: string,
  agentId: string,
  message: Message,
  memoryAdapter: MemoryAdapter | undefined,
  toolCalls?: ToolCall[],
  toolResults?: ToolResult[],
  onError?: (error: Error, operation: 'save' | 'load') => void
): Promise<void> {
  if (!memoryAdapter) return;

  try {
    const threadResult = await memoryAdapter.getThread(threadId);
    if (!threadResult.success || !threadResult.data) {
      await memoryAdapter.createThread(agentId, { agentId }, threadId);
    }

    await memoryAdapter.addEntry({
      threadId,
      message,
      toolCalls,
      toolResults,
      tokenCount: countMessageTokens(message),
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    getLogger().warn('Failed to save memory entry', { error: error.message });
    onError?.(error, 'save');
  }
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
    messages[0].content = typeof content === 'string' ? content + suffix : suffix;
  }
}

export function addContextToMessages(messages: Message[], context: Record<string, unknown>): void {
  if (messages.length > 0 && messages[0].role === 'system') {
    const contextStr = Object.entries(context)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join('\n');
    const suffix = `\n\nContext:\n${contextStr}`;
    const content = messages[0].content;
    messages[0].content = typeof content === 'string' ? content + suffix : suffix;
  }
}
