import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTranscribeAudioTool } from '../tools/audio-transcribe';
import { createGenerateSpeechTool } from '../tools/audio-generate';
import type { ToolContext } from '@cogitator-ai/types';

describe('audio tools', () => {
  const mockContext: ToolContext = {
    runId: 'test-run',
    agentId: 'test-agent',
    threadId: 'test-thread',
    signal: new AbortController().signal,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createTranscribeAudioTool', () => {
    it('should create a tool with correct metadata', () => {
      const tool = createTranscribeAudioTool({ apiKey: 'test-key' });

      expect(tool.name).toBe('transcribeAudio');
      expect(tool.description).toContain('Transcribe audio');
      expect(tool.parameters).toBeDefined();
    });

    it('should transcribe audio from base64 input', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              text: 'Hello, world!',
              language: 'english',
              duration: 2.5,
            }),
        })
      );

      const tool = createTranscribeAudioTool({ apiKey: 'test-key' });
      const audioData = Buffer.from('fake audio').toString('base64');

      const result = await tool.execute(
        {
          audio: { data: audioData, format: 'mp3' },
        },
        mockContext
      );

      expect(result.text).toBe('Hello, world!');
      expect(result.language).toBe('english');
      expect(result.duration).toBe(2.5);

      expect(fetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/audio/transcriptions',
        expect.objectContaining({
          method: 'POST',
          headers: { Authorization: 'Bearer test-key' },
        })
      );
    });

    it('should include timestamps when requested with whisper-1', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              text: 'Hello world',
              words: [
                { word: 'Hello', start: 0.0, end: 0.5 },
                { word: 'world', start: 0.5, end: 1.0 },
              ],
            }),
        })
      );

      const tool = createTranscribeAudioTool({ apiKey: 'test-key' });
      const audioData = Buffer.from('fake audio').toString('base64');

      const result = await tool.execute(
        {
          audio: { data: audioData, format: 'mp3' },
          timestamps: true,
          model: 'whisper-1',
        },
        mockContext
      );

      expect(result.words).toHaveLength(2);
      expect(result.words![0].word).toBe('Hello');
    });

    it('should use default model from config', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ text: 'test' }),
        })
      );

      const tool = createTranscribeAudioTool({
        apiKey: 'test-key',
        defaultModel: 'gpt-4o-transcribe',
      });
      const audioData = Buffer.from('fake audio').toString('base64');

      await tool.execute({ audio: { data: audioData, format: 'mp3' } }, mockContext);

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      const formData = fetchCall[1]?.body as FormData;
      expect(formData.get('model')).toBe('gpt-4o-transcribe');
    });

    it('should throw error when API key is missing', async () => {
      const originalEnv = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      const tool = createTranscribeAudioTool({});
      const audioData = Buffer.from('fake audio').toString('base64');

      await expect(
        tool.execute({ audio: { data: audioData, format: 'mp3' } }, mockContext)
      ).rejects.toThrow('OpenAI API key required');

      process.env.OPENAI_API_KEY = originalEnv;
    });

    it('should throw error on API failure', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          statusText: 'Bad Request',
          json: () => Promise.resolve({ error: { message: 'Invalid audio' } }),
        })
      );

      const tool = createTranscribeAudioTool({ apiKey: 'test-key' });
      const audioData = Buffer.from('fake audio').toString('base64');

      await expect(
        tool.execute({ audio: { data: audioData, format: 'mp3' } }, mockContext)
      ).rejects.toThrow('Transcription failed: Invalid audio');
    });

    it('should honor the tool context abort signal', async () => {
      const controller = new AbortController();
      controller.abort();
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: string, init?: RequestInit) => {
          expect(init?.signal?.aborted).toBe(true);
          const error = new Error('Aborted');
          error.name = 'AbortError';
          return Promise.reject(error);
        })
      );

      const tool = createTranscribeAudioTool({ apiKey: 'test-key' });
      const audioData = Buffer.from('fake audio').toString('base64');

      await expect(
        tool.execute(
          { audio: { data: audioData, format: 'mp3' } },
          { ...mockContext, signal: controller.signal }
        )
      ).rejects.toThrow('Transcription request aborted');
    });
  });

  describe('createGenerateSpeechTool', () => {
    it('should create a tool with correct metadata', () => {
      const tool = createGenerateSpeechTool({ apiKey: 'test-key' });

      expect(tool.name).toBe('generateSpeech');
      expect(tool.description).toContain('Convert text to');
      expect(tool.sideEffects).toContain('network');
    });

    it('should generate speech with default settings', async () => {
      const mockAudioData = new Uint8Array([0x66, 0x61, 0x6b, 0x65]).buffer;

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          arrayBuffer: () => Promise.resolve(mockAudioData),
        })
      );

      const tool = createGenerateSpeechTool({ apiKey: 'test-key' });

      const result = await tool.execute({ text: 'Hello, world!' }, mockContext);

      expect(result.audioBase64).toBe(Buffer.from(mockAudioData).toString('base64'));
      expect(result.format).toBe('mp3');
      expect(result.voice).toBe('alloy');
      expect(result.model).toBe('tts-1');
      expect(result.textLength).toBe(13);

      expect(fetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/audio/speech',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-key',
            'Content-Type': 'application/json',
          },
        })
      );
    });

    it('should use custom voice and model', async () => {
      const mockAudioBuffer = Buffer.from('fake audio');

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          arrayBuffer: () => Promise.resolve(mockAudioBuffer.buffer),
        })
      );

      const tool = createGenerateSpeechTool({ apiKey: 'test-key' });

      const result = await tool.execute(
        {
          text: 'Hello',
          voice: 'nova',
          model: 'tts-1-hd',
          speed: 1.5,
          format: 'wav',
        },
        mockContext
      );

      expect(result.voice).toBe('nova');
      expect(result.model).toBe('tts-1-hd');
      expect(result.format).toBe('wav');

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(fetchCall[1]?.body as string);
      expect(body.voice).toBe('nova');
      expect(body.model).toBe('tts-1-hd');
      expect(body.speed).toBe(1.5);
      expect(body.response_format).toBe('wav');
    });

    it('should use config defaults', async () => {
      const mockAudioBuffer = Buffer.from('fake audio');

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          arrayBuffer: () => Promise.resolve(mockAudioBuffer.buffer),
        })
      );

      const tool = createGenerateSpeechTool({
        apiKey: 'test-key',
        defaultVoice: 'marin',
        defaultModel: 'tts-1-hd',
        defaultFormat: 'opus',
        defaultSpeed: 0.8,
      });

      const result = await tool.execute({ text: 'Hello' }, mockContext);

      expect(result.voice).toBe('marin');
      expect(result.model).toBe('tts-1-hd');
      expect(result.format).toBe('opus');

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(fetchCall[1]?.body as string);
      expect(body.speed).toBe(0.8);
    });

    it('should throw error when API key is missing', async () => {
      const originalEnv = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      const tool = createGenerateSpeechTool({});

      await expect(tool.execute({ text: 'Hello' }, mockContext)).rejects.toThrow(
        'OpenAI API key required'
      );

      process.env.OPENAI_API_KEY = originalEnv;
    });

    it('should throw error on API failure', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          statusText: 'Bad Request',
          json: () => Promise.resolve({ error: { message: 'Text too long' } }),
        })
      );

      const tool = createGenerateSpeechTool({ apiKey: 'test-key' });

      await expect(tool.execute({ text: 'Hello' }, mockContext)).rejects.toThrow(
        'Speech generation failed: Text too long'
      );
    });

    it('should honor the tool context abort signal', async () => {
      const controller = new AbortController();
      controller.abort();
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: string, init?: RequestInit) => {
          expect(init?.signal?.aborted).toBe(true);
          const error = new Error('Aborted');
          error.name = 'AbortError';
          return Promise.reject(error);
        })
      );

      const tool = createGenerateSpeechTool({ apiKey: 'test-key' });

      await expect(
        tool.execute({ text: 'Hello' }, { ...mockContext, signal: controller.signal })
      ).rejects.toThrow('Speech generation request aborted');
    });
  });
});
