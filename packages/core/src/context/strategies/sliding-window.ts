import type {
  CompressionContext,
  CompressionResult,
  CompressionStrategyHandler,
  LLMBackend,
  Message,
} from '@cogitator-ai/types';
import { countMessagesTokens, countTokens } from './token-utils';

const SUMMARY_PROMPT = `Summarize the following conversation history concisely, preserving key facts, decisions, and context that would be important for continuing the conversation. Be brief but include all important details.

Conversation:
`;

export class SlidingWindowStrategy implements CompressionStrategyHandler {
  readonly name = 'sliding-window' as const;

  async compress(ctx: CompressionContext): Promise<CompressionResult> {
    const { messages, targetTokens, windowSize, backend, summaryModel } = ctx;

    if (messages.length === 0) {
      return {
        messages: [],
        originalTokens: 0,
        compressedTokens: 0,
        strategy: this.name,
        summarized: 0,
      };
    }

    const originalTokens = countMessagesTokens(messages);

    const systemMessages: Message[] = [];
    const conversationMessages: Message[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessages.push(msg);
      } else {
        conversationMessages.push(msg);
      }
    }

    const systemTokens = countMessagesTokens(systemMessages);
    const effectiveWindowSize = Math.min(windowSize, conversationMessages.length);
    const recentMessages = conversationMessages.slice(-effectiveWindowSize);
    const olderMessages = conversationMessages.slice(0, -effectiveWindowSize);

    if (olderMessages.length === 0) {
      return {
        messages: [...systemMessages, ...recentMessages],
        originalTokens,
        compressedTokens: originalTokens,
        strategy: this.name,
        summarized: 0,
      };
    }

    const recentTokens = countMessagesTokens(recentMessages);
    const availableForSummary = targetTokens - systemTokens - recentTokens;

    if (availableForSummary <= 100) {
      return {
        messages: [...systemMessages, ...recentMessages],
        originalTokens,
        compressedTokens: systemTokens + recentTokens,
        strategy: this.name,
        summarized: olderMessages.length,
      };
    }

    let summaryContent: string;

    if (backend && summaryModel) {
      summaryContent = await this.generateSummary(olderMessages, backend, summaryModel);
    } else {
      summaryContent = this.createBasicSummary(olderMessages);
    }

    const summaryTokens = countTokens(summaryContent);
    if (summaryTokens > availableForSummary) {
      const maxChars = availableForSummary * 4;
      summaryContent = summaryContent.slice(0, maxChars) + '...';
    }

    const summaryMessage: Message = {
      role: 'system',
      content: `[Previous conversation summary]\n${summaryContent}`,
    };

    const result = [...systemMessages, summaryMessage, ...recentMessages];

    return {
      messages: result,
      originalTokens,
      compressedTokens: countMessagesTokens(result),
      strategy: this.name,
      summarized: olderMessages.length,
    };
  }

  private async generateSummary(
    messages: Message[],
    backend: LLMBackend,
    model: string
  ): Promise<string> {
    const conversationText = messages
      .map((m) => {
        const content = typeof m.content === 'string' ? m.content : '[complex content]';
        return `${m.role}: ${content}`;
      })
      .join('\n');

    try {
      const response = await backend.chat({
        model,
        messages: [{ role: 'user', content: SUMMARY_PROMPT + conversationText }],
        maxTokens: 500,
        temperature: 0.3,
      });

      return response.content;
    } catch {
      return this.createBasicSummary(messages);
    }
  }

  private createBasicSummary(messages: Message[]): string {
    const userMessages = messages.filter((m) => m.role === 'user');
    const assistantMessages = messages.filter((m) => m.role === 'assistant');

    const topics: string[] = [];

    for (const msg of userMessages.slice(-3)) {
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (content.length > 0) {
        const preview = content.slice(0, 100) + (content.length > 100 ? '...' : '');
        topics.push(`User asked: ${preview}`);
      }
    }

    for (const msg of assistantMessages.slice(-2)) {
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (content.length > 0) {
        const preview = content.slice(0, 100) + (content.length > 100 ? '...' : '');
        topics.push(`Assistant responded: ${preview}`);
      }
    }

    return `Earlier in this conversation (${messages.length} messages):\n${topics.join('\n')}`;
  }
}
