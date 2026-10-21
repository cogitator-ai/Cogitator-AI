import Anthropic from '@anthropic-ai/sdk';
import type { SummarizeFn } from '@cogitator-ai/memory';
import type { Message, MessageContent, ToolCall } from '@cogitator-ai/types';

/** Beta of Anthropic's compaction on request */
export const ANTHROPIC_COMPACTION_BETA = 'compact-2026-09-04';

export interface AnthropicCompactionOptions {
  /** A Claude model that compacts */
  model: string;
  /** A client of your own, else one from `apiKey` or `ANTHROPIC_API_KEY` */
  client?: Anthropic;
  apiKey?: string;
  maxTokens?: number;
}

function textOf(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}

function toolCallsOf(message: Message): ToolCall[] {
  if (!('toolCalls' in message)) return [];
  const calls: unknown = message.toolCalls;
  return Array.isArray(calls) ? calls : [];
}

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * `messages` as the turns Anthropic takes: a system message (such as an earlier summary) and a
 * tool result are read as the user's, the calls of an assistant message as text, and turns of
 * one role in a row are joined, so nothing of the conversation is left out of the compaction
 */
function turnsOf(messages: readonly Message[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    const text = textOf(message.content);
    const calls = toolCallsOf(message)
      .map((call) => `[calls ${call.name} ${JSON.stringify(call.arguments)}]`)
      .join('\n');
    const turn: Turn =
      message.role === 'assistant'
        ? { role: 'assistant', content: [text, calls].filter(Boolean).join('\n') }
        : message.role === 'tool'
          ? { role: 'user', content: `[${message.name ?? 'tool'} result] ${text}` }
          : { role: 'user', content: text };
    if (!turn.content.trim()) continue;
    const last = turns.at(-1);
    if (last?.role === turn.role) last.content += `\n\n${turn.content}`;
    else turns.push(turn);
  }
  return turns;
}

/**
 * A summarizer that has Anthropic compact the messages it gets (the `compaction` parameter of
 * the Messages API, beta `compact-2026-09-04`), with the summarizer's prompt as the
 * compaction's `instructions`, and answers with the `content` of the compaction block. A
 * hierarchical compaction checks that answer like any other: its atoms and quotes are parsed and
 * verified. The signed block itself is not kept, so a conversation goes on with Cogitator's own
 * summary on every model.
 *
 * ```ts
 * new CompactionService({ adapter, summarize: anthropicCompactionSummarizer({ model: 'claude-sonnet-5-5' }) });
 * ```
 */
export function anthropicCompactionSummarizer(options: AnthropicCompactionOptions): SummarizeFn {
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey });
  return async (messages, summarizeOptions) => {
    const response = await client.beta.messages.create({
      model: summarizeOptions?.model ?? options.model,
      max_tokens: options.maxTokens ?? 8192,
      messages: turnsOf(messages),
      compaction: {
        type: 'summarize',
        ...(summarizeOptions?.prompt && { instructions: summarizeOptions.prompt }),
      },
      betas: [ANTHROPIC_COMPACTION_BETA],
    });
    const block = response.content.find((item) => item.type === 'compaction');
    if (block?.type !== 'compaction' || !block.content) {
      throw new Error('Anthropic answered the compaction without a summary');
    }
    return block.content;
  };
}
