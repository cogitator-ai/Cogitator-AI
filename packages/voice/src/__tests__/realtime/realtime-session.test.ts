import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { RealtimeSessionConfig } from '../../types.js';

type MockAdapter = EventEmitter & {
  connect: ReturnType<typeof vi.fn>;
  pushAudio: ReturnType<typeof vi.fn>;
  sendText: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

let lastOpenAIAdapter: MockAdapter;
let lastGeminiAdapter: MockAdapter;
let openAIConstructorArgs: unknown[];
let geminiConstructorArgs: unknown[];

vi.mock('../../realtime/openai-realtime', () => {
  return {
    OpenAIRealtimeAdapter: class extends EventEmitter {
      connect = vi.fn().mockResolvedValue(undefined);
      pushAudio = vi.fn();
      sendText = vi.fn();
      interrupt = vi.fn();
      close = vi.fn();
      constructor(...args: unknown[]) {
        super();
        openAIConstructorArgs = args;
        lastOpenAIAdapter = this as unknown as MockAdapter;
      }
    },
  };
});

vi.mock('../../realtime/gemini-realtime', () => {
  return {
    GeminiRealtimeAdapter: class extends EventEmitter {
      connect = vi.fn().mockResolvedValue(undefined);
      pushAudio = vi.fn();
      sendText = vi.fn();
      interrupt = vi.fn();
      close = vi.fn();
      constructor(...args: unknown[]) {
        super();
        geminiConstructorArgs = args;
        lastGeminiAdapter = this as unknown as MockAdapter;
      }
    },
  };
});

import { RealtimeSession } from '../../realtime/realtime-session.js';

function createConfig(overrides?: Partial<RealtimeSessionConfig>): RealtimeSessionConfig {
  return {
    provider: 'openai',
    apiKey: 'test-key',
    ...overrides,
  };
}

describe('RealtimeSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openAIConstructorArgs = [];
    geminiConstructorArgs = [];
  });

  describe('adapter routing', () => {
    it('creates OpenAI adapter when provider is openai', () => {
      new RealtimeSession(createConfig({ provider: 'openai' }));

      expect(openAIConstructorArgs).toHaveLength(1);
      expect(geminiConstructorArgs).toHaveLength(0);
    });

    it('creates Gemini adapter when provider is gemini', () => {
      new RealtimeSession(createConfig({ provider: 'gemini' }));

      expect(geminiConstructorArgs).toHaveLength(1);
      expect(openAIConstructorArgs).toHaveLength(0);
    });

    it('passes config to adapter constructor', () => {
      const tools = [
        {
          name: 'test_tool',
          description: 'A test tool',
          parameters: { type: 'object' },
          execute: vi.fn(),
        },
      ];
      const config = createConfig({
        provider: 'openai',
        model: 'gpt-4o-realtime-preview',
        instructions: 'Be helpful',
        tools,
        voice: 'alloy',
      });

      new RealtimeSession(config);

      expect(openAIConstructorArgs[0]).toEqual(config);
    });
  });

  describe('provider getter', () => {
    it('returns openai when configured with openai', () => {
      const session = new RealtimeSession(createConfig({ provider: 'openai' }));
      expect(session.provider).toBe('openai');
    });

    it('returns gemini when configured with gemini', () => {
      const session = new RealtimeSession(createConfig({ provider: 'gemini' }));
      expect(session.provider).toBe('gemini');
    });
  });

  describe('method delegation', () => {
    it('connect() delegates to adapter', async () => {
      const session = new RealtimeSession(createConfig());
      await session.connect();

      expect(lastOpenAIAdapter.connect).toHaveBeenCalledOnce();
    });

    it('pushAudio() delegates to adapter', () => {
      const session = new RealtimeSession(createConfig());
      const chunk = Buffer.from([0x01, 0x02]);
      session.pushAudio(chunk);

      expect(lastOpenAIAdapter.pushAudio).toHaveBeenCalledWith(chunk);
    });

    it('sendText() delegates to adapter', () => {
      const session = new RealtimeSession(createConfig());
      session.sendText('hello');

      expect(lastOpenAIAdapter.sendText).toHaveBeenCalledWith('hello');
    });

    it('interrupt() delegates to adapter', () => {
      const session = new RealtimeSession(createConfig());
      session.interrupt();

      expect(lastOpenAIAdapter.interrupt).toHaveBeenCalledOnce();
    });

    it('close() delegates to adapter', () => {
      const session = new RealtimeSession(createConfig());
      session.close();

      expect(lastOpenAIAdapter.close).toHaveBeenCalledOnce();
    });

    it('delegates to Gemini adapter when provider is gemini', async () => {
      const session = new RealtimeSession(createConfig({ provider: 'gemini' }));
      await session.connect();
      session.sendText('hi');

      expect(lastGeminiAdapter.connect).toHaveBeenCalledOnce();
      expect(lastGeminiAdapter.sendText).toHaveBeenCalledWith('hi');
    });
  });

  describe('event forwarding', () => {
    it('forwards connected events from adapter', () => {
      const session = new RealtimeSession(createConfig());
      const handler = vi.fn();
      session.on('connected', handler);

      lastOpenAIAdapter.emit('connected');

      expect(handler).toHaveBeenCalledOnce();
    });

    it('forwards audio events from adapter', () => {
      const session = new RealtimeSession(createConfig());
      const handler = vi.fn();
      session.on('audio', handler);

      const chunk = Buffer.from('audio-data');
      lastOpenAIAdapter.emit('audio', chunk);

      expect(handler).toHaveBeenCalledWith(chunk);
    });

    it('forwards transcript events from adapter', () => {
      const session = new RealtimeSession(createConfig());
      const handler = vi.fn();
      session.on('transcript', handler);

      lastOpenAIAdapter.emit('transcript', 'Hello world', 'assistant');

      expect(handler).toHaveBeenCalledWith('Hello world', 'assistant');
    });

    it('forwards error events from adapter', () => {
      const session = new RealtimeSession(createConfig());
      const handler = vi.fn();
      session.on('error', handler);

      const err = new Error('connection lost');
      lastOpenAIAdapter.emit('error', err);

      expect(handler).toHaveBeenCalledWith(err);
    });

    it('forwards speech_start events from adapter', () => {
      const session = new RealtimeSession(createConfig());
      const handler = vi.fn();
      session.on('speech_start', handler);

      lastOpenAIAdapter.emit('speech_start');

      expect(handler).toHaveBeenCalledOnce();
    });

    it('forwards tool_call events from adapter', () => {
      const session = new RealtimeSession(createConfig());
      const handler = vi.fn();
      session.on('tool_call', handler);

      lastOpenAIAdapter.emit('tool_call', 'get_weather', { city: 'London' });

      expect(handler).toHaveBeenCalledWith('get_weather', { city: 'London' });
    });
  });
});
