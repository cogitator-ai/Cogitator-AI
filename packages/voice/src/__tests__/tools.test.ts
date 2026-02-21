import { describe, it, expect, vi } from 'vitest';
import { transcribeTool, speakTool, voiceTools } from '../tools';
import type { STTProvider, TTSProvider } from '../types';

describe('voice tools', () => {
  const mockSTT: STTProvider = {
    name: 'mock',
    transcribe: vi.fn().mockResolvedValue({ text: 'Hello world', language: 'en', duration: 1.5 }),
    createStream: vi.fn(),
  };

  const mockTTS: TTSProvider = {
    name: 'mock',
    synthesize: vi.fn().mockResolvedValue(Buffer.from('audio-data')),
    streamSynthesize: vi.fn(),
  };

  describe('transcribeTool', () => {
    it('creates a tool with correct name and description', () => {
      const tool = transcribeTool(mockSTT);
      expect(tool.name).toBe('transcribe_audio');
      expect(tool.description).toBeTruthy();
    });

    it('has zod parameters schema', () => {
      const tool = transcribeTool(mockSTT);
      expect(tool.parameters).toBeDefined();
    });

    it('transcribes base64 audio', async () => {
      const tool = transcribeTool(mockSTT);
      const audioBase64 = Buffer.from('test-audio').toString('base64');
      const result = await tool.execute({ audioBase64 });
      expect(result).toEqual({ text: 'Hello world', language: 'en', duration: 1.5 });
      expect(mockSTT.transcribe).toHaveBeenCalledWith(expect.any(Buffer), { language: undefined });
    });

    it('passes language option', async () => {
      const tool = transcribeTool(mockSTT);
      await tool.execute({ audioBase64: btoa('audio'), language: 'es' });
      expect(mockSTT.transcribe).toHaveBeenCalledWith(expect.any(Buffer), { language: 'es' });
    });
  });

  describe('speakTool', () => {
    it('creates a tool with correct name', () => {
      const tool = speakTool(mockTTS);
      expect(tool.name).toBe('speak_text');
    });

    it('synthesizes text to base64 audio', async () => {
      const tool = speakTool(mockTTS);
      const result = await tool.execute({ text: 'Hello' });
      expect(result).toHaveProperty('audioBase64');
      expect(result).toHaveProperty('format', 'mp3');
    });

    it('passes voice option', async () => {
      const tool = speakTool(mockTTS);
      await tool.execute({ text: 'Hello', voice: 'coral' });
      expect(mockTTS.synthesize).toHaveBeenCalledWith('Hello', { voice: 'coral' });
    });
  });

  describe('voiceTools', () => {
    it('returns array of both tools', () => {
      const tools = voiceTools({ stt: mockSTT, tts: mockTTS });
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('transcribe_audio');
      expect(tools[1].name).toBe('speak_text');
    });
  });
});
