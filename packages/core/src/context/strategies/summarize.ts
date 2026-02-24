import type {
  CompressionContext,
  CompressionResult,
  CompressionStrategyHandler,
  LLMBackend,
  Message,
} from '@cogitator-ai/types';
import { countMessagesTokens, countTokens } from './token-utils';

const SUMMARY_SYSTEM_PROMPT = `You are a conversation summarizer. Your task is to create a concise but comprehensive summary of a conversation that preserves:
- Key facts and information shared
- Important decisions made
- User preferences and requirements mentioned
- Any pending questions or tasks
- Critical context needed to continue the conversation

Be concise but thorough. Focus on information that would be essential for continuing the conversation naturally.`;

const SUMMARY_USER_PROMPT = `Summarize the following conversation. Focus on preserving all important context:

`;

export class SummarizeStrategy implements CompressionStrategyHandler {
  readonly name = 'summarize' as const;

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

    const keepRecent = Math.min(
      windowSize,
      Math.max(2, Math.floor(conversationMessages.length * 0.2))
    );
    const recentMessages = conversationMessages.slice(-keepRecent);
    const olderMessages = conversationMessages.slice(0, -keepRecent);

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
    const availableForSummary = targetTokens - systemTokens - recentTokens - 100;

    if (availableForSummary <= 50) {
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
      summaryContent = await this.generateLLMSummary(
        olderMessages,
        backend,
        summaryModel,
        availableForSummary
      );
    } else {
      summaryContent = this.generateFallbackSummary(olderMessages, availableForSummary);
    }

    const summaryMessage: Message = {
      role: 'system',
      content: `[Conversation Summary - ${olderMessages.length} previous messages]\n\n${summaryContent}`,
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

  private async generateLLMSummary(
    messages: Message[],
    backend: LLMBackend,
    model: string,
    maxTokens: number
  ): Promise<string> {
    const conversationText = this.formatConversation(messages);

    try {
      const targetSummaryTokens = Math.min(maxTokens, 800);

      const response = await backend.chat({
        model,
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
          { role: 'user', content: SUMMARY_USER_PROMPT + conversationText },
        ],
        maxTokens: targetSummaryTokens,
        temperature: 0.2,
      });

      return response.content;
    } catch {
      return this.generateFallbackSummary(messages, maxTokens);
    }
  }

  private formatConversation(messages: Message[]): string {
    return messages
      .map((m) => {
        const content = typeof m.content === 'string' ? m.content : '[complex content]';
        const role = m.role.charAt(0).toUpperCase() + m.role.slice(1);
        return `${role}: ${content}`;
      })
      .join('\n\n');
  }

  private generateFallbackSummary(messages: Message[], maxTokens: number): string {
    const sections: string[] = [];

    const userMessages = messages.filter((m) => m.role === 'user');
    const assistantMessages = messages.filter((m) => m.role === 'assistant');
    const toolMessages = messages.filter((m) => m.role === 'tool');

    if (userMessages.length > 0) {
      sections.push(`User requests (${userMessages.length} messages):`);
      for (const msg of userMessages.slice(-5)) {
        const content = typeof msg.content === 'string' ? msg.content : '';
        const preview = content.slice(0, 150) + (content.length > 150 ? '...' : '');
        sections.push(`  - ${preview}`);
      }
    }

    if (assistantMessages.length > 0) {
      sections.push(`\nAssistant responses (${assistantMessages.length} messages):`);
      for (const msg of assistantMessages.slice(-3)) {
        const content = typeof msg.content === 'string' ? msg.content : '';
        const preview = content.slice(0, 200) + (content.length > 200 ? '...' : '');
        sections.push(`  - ${preview}`);
      }
    }

    if (toolMessages.length > 0) {
      sections.push(`\nTool interactions: ${toolMessages.length} tool calls were made`);
    }

    let summary = sections.join('\n');

    const currentTokens = countTokens(summary);
    if (currentTokens > maxTokens) {
      const maxChars = maxTokens * 4;
      summary = summary.slice(0, maxChars) + '\n[Summary truncated]';
    }

    return summary;
  }
}
