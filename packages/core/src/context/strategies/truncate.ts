import type {
  CompressionContext,
  CompressionResult,
  CompressionStrategyHandler,
  ContentPart,
  Message,
} from '@cogitator-ai/types';
import { countMessageTokens, countTokens } from './token-utils';

export class TruncateStrategy implements CompressionStrategyHandler {
  readonly name = 'truncate' as const;

  async compress(ctx: CompressionContext): Promise<CompressionResult> {
    const { messages, targetTokens } = ctx;

    if (messages.length === 0) {
      return {
        messages: [],
        originalTokens: 0,
        compressedTokens: 0,
        strategy: this.name,
        truncated: 0,
      };
    }

    const originalTokens = messages.reduce((sum, m) => sum + countMessageTokens(m), 0);

    const systemMessages: Message[] = [];
    const otherMessages: Message[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessages.push(msg);
      } else {
        otherMessages.push(msg);
      }
    }

    const systemTokens = systemMessages.reduce((sum, m) => sum + countMessageTokens(m), 0);
    const availableForHistory = targetTokens - systemTokens;

    if (availableForHistory <= 0) {
      return {
        messages: systemMessages,
        originalTokens,
        compressedTokens: systemTokens,
        strategy: this.name,
        truncated: otherMessages.length,
      };
    }

    const kept: Message[] = [];
    let usedTokens = 0;

    for (let i = otherMessages.length - 1; i >= 0; i--) {
      const msg = otherMessages[i];
      const msgTokens = countMessageTokens(msg);

      if (usedTokens + msgTokens <= availableForHistory) {
        kept.unshift(msg);
        usedTokens += msgTokens;
      } else if (kept.length === 0) {
        const truncated = this.truncateMessage(msg, availableForHistory);
        if (truncated) {
          kept.unshift(truncated);
          usedTokens += countMessageTokens(truncated);
        }
        break;
      } else {
        break;
      }
    }

    const result = [...systemMessages, ...kept];
    const compressedTokens = systemTokens + usedTokens;

    return {
      messages: result,
      originalTokens,
      compressedTokens,
      strategy: this.name,
      truncated: otherMessages.length - kept.length,
    };
  }

  private truncateMessage(message: Message, maxTokens: number): Message | null {
    if (maxTokens <= 0) {
      return null;
    }

    if (typeof message.content === 'string') {
      const content = this.truncateTextToTokens(message.content, maxTokens);
      if (!content) return null;
      return { ...message, content };
    }

    let remainingTextTokens = Math.max(
      0,
      maxTokens - countMessageTokens({ ...message, content: [] })
    );
    const content: ContentPart[] = message.content.flatMap((part): ContentPart[] => {
      if (part.type !== 'text') {
        return [part];
      }

      if (remainingTextTokens <= 0) {
        return [];
      }

      const text = this.truncateTextPartToTokens(part.text, remainingTextTokens);
      if (!text) {
        return [];
      }

      remainingTextTokens -= countTokens(text);
      return [{ ...part, text }];
    });

    const truncated: Message = { ...message, content };
    return countMessageTokens(truncated) <= maxTokens ? truncated : null;
  }

  private truncateTextToTokens(text: string, maxTokens: number): string {
    let maxChars = Math.max(0, (maxTokens - 4) * 4);
    if (maxChars === 0) {
      return '';
    }

    let truncated =
      text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 3))}...` : text;

    while (countMessageTokens({ role: 'user', content: truncated }) > maxTokens && maxChars > 0) {
      maxChars -= 4;
      truncated = text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 3))}...` : text;
    }

    return truncated;
  }

  private truncateTextPartToTokens(text: string, maxTokens: number): string {
    let maxChars = Math.max(0, maxTokens * 4);
    if (maxChars === 0) {
      return '';
    }

    let truncated =
      text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 3))}...` : text;

    while (countTokens(truncated) > maxTokens && maxChars > 0) {
      maxChars -= 4;
      truncated = text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 3))}...` : text;
    }

    return truncated;
  }
}
