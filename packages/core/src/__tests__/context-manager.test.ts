import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextManager } from '../context/context-manager';
import type { Message, LLMBackend, LLMResponse } from '@cogitator-ai/types';

function createMessages(count: number, contentLength = 100): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `Message ${i}: ${'x'.repeat(contentLength)}`,
  }));
}

function createMockBackend(): LLMBackend {
  return {
    chat: vi.fn().mockResolvedValue({
      content: 'Summary of conversation',
      model: 'test-model',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      finishReason: 'stop',
    } as LLMResponse),
    chatStream: vi.fn(),
  };
}

describe('ContextManager', () => {
  describe('constructor', () => {
    it('uses default config values', () => {
      const manager = new ContextManager({});
      expect(manager).toBeDefined();
    });

    it('accepts custom config', () => {
      const manager = new ContextManager({
        enabled: false,
        strategy: 'truncate',
        compressionThreshold: 0.9,
        outputReserve: 0.2,
        windowSize: 5,
      });
      expect(manager).toBeDefined();
    });

    it('creates different strategies', () => {
      const truncate = new ContextManager({ strategy: 'truncate' });
      const sliding = new ContextManager({ strategy: 'sliding-window' });
      const summarize = new ContextManager({ strategy: 'summarize' });
      const hybrid = new ContextManager({ strategy: 'hybrid' });

      expect(truncate).toBeDefined();
      expect(sliding).toBeDefined();
      expect(summarize).toBeDefined();
      expect(hybrid).toBeDefined();
    });
  });

  describe('getModelContextLimit', () => {
    let manager: ContextManager;

    beforeEach(() => {
      manager = new ContextManager({});
    });

    it('returns correct limit for gpt-4o', () => {
      const limit = manager.getModelContextLimit('openai:gpt-4o');
      expect(limit).toBe(128000);
    });

    it('returns correct limit for gpt-4.1', () => {
      const limit = manager.getModelContextLimit('openai:gpt-4.1');
      expect(limit).toBe(128000);
    });

    it('returns correct limit for gpt-4', () => {
      const limit = manager.getModelContextLimit('openai:gpt-4');
      expect(limit).toBe(8192);
    });

    it('returns correct limit for gpt-3.5', () => {
      const limit = manager.getModelContextLimit('openai:gpt-3.5-turbo');
      expect(limit).toBe(16385);
    });

    it('returns correct limit for claude-3', () => {
      const limit = manager.getModelContextLimit('anthropic:claude-3-opus');
      expect(limit).toBe(200000);
    });

    it('returns correct limit for claude-sonnet', () => {
      const limit = manager.getModelContextLimit('anthropic:claude-sonnet-4');
      expect(limit).toBe(200000);
    });

    it('returns correct limit for claude-2', () => {
      const limit = manager.getModelContextLimit('anthropic:claude-2');
      expect(limit).toBe(100000);
    });

    it('returns correct limit for gemini-pro', () => {
      const limit = manager.getModelContextLimit('google:gemini-pro');
      expect(limit).toBe(1000000);
    });

    it('returns correct limit for llama', () => {
      const limit = manager.getModelContextLimit('ollama:llama3');
      expect(limit).toBe(8192);
    });

    it('returns correct limit for mistral', () => {
      const limit = manager.getModelContextLimit('ollama:mistral-large');
      expect(limit).toBeGreaterThanOrEqual(8192);
    });

    it('returns default limit for unknown model', () => {
      const limit = manager.getModelContextLimit('unknown:mystery-model');
      expect(limit).toBe(8192);
    });
  });

  describe('checkState', () => {
    let manager: ContextManager;

    beforeEach(() => {
      manager = new ContextManager({
        compressionThreshold: 0.8,
        outputReserve: 0.15,
      });
    });

    it('returns correct state for small context', () => {
      const messages = createMessages(5, 10);
      const state = manager.checkState(messages, 'openai:gpt-4');

      expect(state.currentTokens).toBeGreaterThan(0);
      expect(state.maxTokens).toBeLessThan(8192);
      expect(state.availableTokens).toBeGreaterThan(0);
      expect(state.utilizationPercent).toBeLessThan(100);
      expect(state.needsCompression).toBe(false);
    });

    it('indicates compression needed for large context', () => {
      const messages = createMessages(100, 500);
      const state = manager.checkState(messages, 'openai:gpt-4');

      expect(state.needsCompression).toBe(true);
      expect(state.utilizationPercent).toBeGreaterThan(80);
    });

    it('calculates utilization percentage correctly', () => {
      const messages = createMessages(10, 50);
      const state = manager.checkState(messages, 'openai:gpt-4');

      expect(state.utilizationPercent).toBeGreaterThanOrEqual(0);
      expect(state.utilizationPercent).toBeLessThanOrEqual(100);
    });
  });

  describe('shouldCompress', () => {
    it('returns false when disabled', () => {
      const manager = new ContextManager({ enabled: false });
      const messages = createMessages(100, 500);

      expect(manager.shouldCompress(messages, 'openai:gpt-4')).toBe(false);
    });

    it('returns false for small context', () => {
      const manager = new ContextManager({ enabled: true });
      const messages = createMessages(5, 10);

      expect(manager.shouldCompress(messages, 'openai:gpt-4')).toBe(false);
    });

    it('returns true for large context', () => {
      const manager = new ContextManager({
        enabled: true,
        compressionThreshold: 0.1,
      });
      const messages = createMessages(50, 100);

      expect(manager.shouldCompress(messages, 'openai:gpt-4')).toBe(true);
    });
  });

  describe('compress', () => {
    describe('truncate strategy', () => {
      let manager: ContextManager;

      beforeEach(() => {
        manager = new ContextManager({
          strategy: 'truncate',
          compressionThreshold: 0.1,
        });
      });

      it('returns original messages when no compression needed', async () => {
        const smallManager = new ContextManager({
          strategy: 'truncate',
          compressionThreshold: 0.99,
        });
        const messages = createMessages(5, 10);
        const result = await smallManager.compress(messages, 'openai:gpt-4');

        expect(result.messages).toEqual(messages);
        expect(result.strategy).toBe('truncate');
      });

      it('truncates old messages when compression needed', async () => {
        const messages = createMessages(50, 100);
        const result = await manager.compress(messages, 'openai:gpt-4');

        expect(result.messages.length).toBeLessThanOrEqual(messages.length);
        expect(result.compressedTokens).toBeLessThanOrEqual(result.originalTokens);
        expect(result.strategy).toBe('truncate');
      });

      it('preserves system messages', async () => {
        const messages: Message[] = [
          { role: 'system', content: 'You are a helpful assistant' },
          ...createMessages(50, 100),
        ];
        const result = await manager.compress(messages, 'openai:gpt-4');

        const systemMessages = result.messages.filter((m) => m.role === 'system');
        expect(systemMessages.length).toBeGreaterThanOrEqual(1);
        expect(systemMessages[0].content).toBe('You are a helpful assistant');
      });

      it('keeps most recent messages', async () => {
        const messages = createMessages(50, 100);
        const lastMessage = messages[messages.length - 1];
        const result = await manager.compress(messages, 'openai:gpt-4');

        expect(result.messages[result.messages.length - 1]).toEqual(lastMessage);
      });

      it('handles empty messages array', async () => {
        const result = await manager.compress([], 'openai:gpt-4');

        expect(result.messages).toEqual([]);
        expect(result.originalTokens).toBe(0);
        expect(result.compressedTokens).toBe(0);
      });
    });

    describe('sliding-window strategy', () => {
      let manager: ContextManager;

      beforeEach(() => {
        manager = new ContextManager({
          strategy: 'sliding-window',
          compressionThreshold: 0.1,
          windowSize: 10,
        });
      });

      it('keeps recent messages in window', async () => {
        const messages = createMessages(50, 50);
        const result = await manager.compress(messages, 'openai:gpt-4');

        expect(result.strategy).toBe('sliding-window');
        const nonSystemMessages = result.messages.filter(
          (m) => m.role !== 'system' || !m.content?.toString().includes('[Previous conversation')
        );
        expect(nonSystemMessages.length).toBeLessThanOrEqual(10);
      });

      it('creates summary of older messages without backend', async () => {
        const messages = createMessages(50, 50);
        const result = await manager.compress(messages, 'openai:gpt-4');

        const summaryMessage = result.messages.find(
          (m) => m.role === 'system' && m.content?.toString().includes('[Previous conversation')
        );
        expect(summaryMessage).toBeDefined();
        expect(result.summarized).toBeGreaterThan(0);
      });

      it('uses backend for summary when available', async () => {
        const backend = createMockBackend();
        const managerWithBackend = new ContextManager(
          {
            strategy: 'sliding-window',
            compressionThreshold: 0.01,
            windowSize: 3,
            summaryModel: 'openai:gpt-4',
          },
          {
            getBackend: () => backend,
          }
        );

        const messages = createMessages(50, 200);
        await managerWithBackend.compress(messages, 'openai:gpt-4');

        expect(backend.chat).toHaveBeenCalled();
      });

      it('falls back to basic summary on backend error', async () => {
        const backend = createMockBackend();
        (backend.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API error'));

        const managerWithBackend = new ContextManager(
          {
            strategy: 'sliding-window',
            compressionThreshold: 0.1,
            windowSize: 5,
            summaryModel: 'openai:gpt-4',
          },
          {
            getBackend: () => backend,
          }
        );

        const messages = createMessages(30, 50);
        const result = await managerWithBackend.compress(messages, 'openai:gpt-4');

        expect(result.messages).toBeDefined();
        expect(result.messages.length).toBeGreaterThan(0);
      });

      it('handles messages shorter than window size', async () => {
        const messages = createMessages(5, 50);
        const result = await manager.compress(messages, 'openai:gpt-4');

        expect(result.messages.length).toBeLessThanOrEqual(messages.length);
      });
    });

    describe('summarize strategy', () => {
      it('uses model from context when no summary model specified', async () => {
        const backend = createMockBackend();
        const manager = new ContextManager(
          {
            strategy: 'summarize',
            compressionThreshold: 0.1,
          },
          {
            getBackend: () => backend,
          }
        );

        const messages = createMessages(30, 100);
        await manager.compress(messages, 'openai:gpt-4');

        expect(backend.chat).toHaveBeenCalled();
      });
    });

    describe('hybrid strategy', () => {
      let manager: ContextManager;

      beforeEach(() => {
        manager = new ContextManager({
          strategy: 'hybrid',
          compressionThreshold: 0.1,
          windowSize: 10,
        });
      });

      it('applies compression to large context', async () => {
        const messages = createMessages(100, 100);
        const result = await manager.compress(messages, 'openai:gpt-4');

        expect(result.strategy).toBe('hybrid');
        expect(result.compressedTokens).toBeLessThanOrEqual(result.originalTokens);
      });

      it('returns original when no compression needed', async () => {
        const smallManager = new ContextManager({
          strategy: 'hybrid',
          compressionThreshold: 0.99,
        });
        const messages = createMessages(5, 10);
        const result = await smallManager.compress(messages, 'openai:gpt-4');

        expect(result.messages).toEqual(messages);
      });
    });
  });

  describe('edge cases', () => {
    it('handles very long single message', async () => {
      const manager = new ContextManager({
        strategy: 'truncate',
        compressionThreshold: 0.1,
      });
      const messages: Message[] = [{ role: 'user', content: 'x'.repeat(50000) }];
      const result = await manager.compress(messages, 'openai:gpt-4');

      expect(result.messages.length).toBeLessThanOrEqual(1);
    });

    it('handles messages with complex content', async () => {
      const manager = new ContextManager({
        strategy: 'sliding-window',
        compressionThreshold: 0.1,
        windowSize: 5,
      });
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look at this image' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
          ],
        },
        { role: 'assistant', content: 'I see the image' },
        ...createMessages(20, 50),
      ];
      const result = await manager.compress(messages, 'openai:gpt-4');

      expect(result.messages).toBeDefined();
    });

    it('handles only system messages', async () => {
      const manager = new ContextManager({
        strategy: 'truncate',
        compressionThreshold: 0.1,
      });
      const messages: Message[] = [
        { role: 'system', content: 'System prompt 1' },
        { role: 'system', content: 'System prompt 2' },
      ];
      const result = await manager.compress(messages, 'openai:gpt-4');

      expect(result.messages.length).toBe(2);
    });

    it('preserves message order after compression', async () => {
      const manager = new ContextManager({
        strategy: 'truncate',
        compressionThreshold: 0.5,
      });
      const messages = createMessages(20, 50);
      const result = await manager.compress(messages, 'openai:gpt-4');

      for (let i = 1; i < result.messages.length; i++) {
        const prev = result.messages[i - 1];
        const curr = result.messages[i];
        if (prev.role !== 'system' && curr.role !== 'system') {
          const prevIndex = messages.findIndex((m) => m.content === prev.content);
          const currIndex = messages.findIndex((m) => m.content === curr.content);
          if (prevIndex !== -1 && currIndex !== -1) {
            expect(prevIndex).toBeLessThan(currIndex);
          }
        }
      }
    });
  });
});
