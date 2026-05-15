import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchAudioAsBuffer,
  audioInputToBuffer,
  isValidAudioFormat,
  getAudioMimeType,
} from '../utils/audio-fetch';

describe('audio-fetch utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isValidAudioFormat', () => {
    it('should return true for valid formats', () => {
      expect(isValidAudioFormat('mp3')).toBe(true);
      expect(isValidAudioFormat('wav')).toBe(true);
      expect(isValidAudioFormat('webm')).toBe(true);
      expect(isValidAudioFormat('m4a')).toBe(true);
      expect(isValidAudioFormat('ogg')).toBe(true);
      expect(isValidAudioFormat('flac')).toBe(true);
    });

    it('should return false for invalid formats', () => {
      expect(isValidAudioFormat('aac')).toBe(false);
      expect(isValidAudioFormat('txt')).toBe(false);
      expect(isValidAudioFormat('png')).toBe(false);
    });
  });

  describe('getAudioMimeType', () => {
    it('should return correct mime types', () => {
      expect(getAudioMimeType('mp3')).toBe('audio/mpeg');
      expect(getAudioMimeType('wav')).toBe('audio/wav');
      expect(getAudioMimeType('webm')).toBe('audio/webm');
      expect(getAudioMimeType('ogg')).toBe('audio/ogg');
      expect(getAudioMimeType('flac')).toBe('audio/flac');
      expect(getAudioMimeType('m4a')).toBe('audio/m4a');
    });
  });

  describe('fetchAudioAsBuffer', () => {
    it('should fetch audio from URL and detect format from content-type', async () => {
      const mockAudioData = Buffer.from('fake audio data');

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          headers: new Headers({ 'content-type': 'audio/mpeg' }),
          arrayBuffer: () => Promise.resolve(mockAudioData.buffer),
        })
      );

      const result = await fetchAudioAsBuffer('https://example.com/audio.mp3');

      expect(result.format).toBe('mp3');
      expect(result.filename).toBe('audio.mp3');
      expect(result.buffer).toBeInstanceOf(Buffer);
    });

    it('should detect format from URL extension when content-type is missing', async () => {
      const mockAudioData = Buffer.from('fake audio data');

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          headers: new Headers({}),
          arrayBuffer: () => Promise.resolve(mockAudioData.buffer),
        })
      );

      const result = await fetchAudioAsBuffer('https://example.com/recording.wav');

      expect(result.format).toBe('wav');
      expect(result.filename).toBe('audio.wav');
    });

    it('should throw on HTTP error', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
        })
      );

      await expect(fetchAudioAsBuffer('https://example.com/notfound.mp3')).rejects.toThrow(
        'Failed to fetch audio: HTTP 404'
      );
    });

    it('should throw if file exceeds 25MB limit', async () => {
      const largeBuffer = Buffer.alloc(26 * 1024 * 1024);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          headers: new Headers({ 'content-type': 'audio/mpeg' }),
          arrayBuffer: () => Promise.resolve(largeBuffer.buffer),
        })
      );

      await expect(fetchAudioAsBuffer('https://example.com/large.mp3')).rejects.toThrow(
        'Audio file exceeds 25MB limit'
      );
    });

    it('should respect timeout option', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(
          () =>
            new Promise((_, reject) => {
              setTimeout(() => reject(new Error('aborted')), 100);
            })
        )
      );

      await expect(
        fetchAudioAsBuffer('https://example.com/slow.mp3', { timeout: 50 })
      ).rejects.toThrow();
    });

    it('should honor an abort signal', async () => {
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

      await expect(
        fetchAudioAsBuffer('https://example.com/audio.mp3', { signal: controller.signal })
      ).rejects.toThrow('Audio fetch aborted');
    });
  });

  describe('audioInputToBuffer', () => {
    it('should handle URL string input', async () => {
      const mockAudioData = Buffer.from('fake audio data');

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          headers: new Headers({ 'content-type': 'audio/wav' }),
          arrayBuffer: () => Promise.resolve(mockAudioData.buffer),
        })
      );

      const result = await audioInputToBuffer('https://example.com/audio.wav');

      expect(result.format).toBe('wav');
      expect(result.buffer).toBeInstanceOf(Buffer);
    });

    it('should handle base64 object input', async () => {
      const audioData = Buffer.from('test audio').toString('base64');

      const result = await audioInputToBuffer({
        data: audioData,
        format: 'mp3',
      });

      expect(result.format).toBe('mp3');
      expect(result.filename).toBe('audio.mp3');
      expect(result.buffer.toString()).toBe('test audio');
    });

    it('should handle data URL input', async () => {
      const audioData = Buffer.from('test audio').toString('base64');
      const dataUrl = `data:audio/wav;base64,${audioData}`;

      const result = await audioInputToBuffer(dataUrl);

      expect(result.format).toBe('wav');
      expect(result.buffer.toString()).toBe('test audio');
    });

    it('should throw for oversized base64 input', async () => {
      const largeData = Buffer.alloc(26 * 1024 * 1024).toString('base64');

      await expect(
        audioInputToBuffer({
          data: largeData,
          format: 'mp3',
        })
      ).rejects.toThrow('Audio file exceeds 25MB limit');
    });
  });
});
