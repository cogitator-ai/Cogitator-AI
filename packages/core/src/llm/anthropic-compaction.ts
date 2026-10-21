import Anthropic from '@anthropic-ai/sdk';
import type { SummarizeFn } from '@cogitator-ai/memory';
import type { MessageContent } from '@cogitator-ai/types';

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
      messages: messages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => ({
          role: message.role === 'assistant' ? ('assistant' as const) : ('user' as const),
          content: textOf(message.content),
        })),
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
