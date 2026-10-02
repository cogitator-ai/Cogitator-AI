import { describe, it, expect } from 'vitest';
import {
  pcmToWav,
  wavToPcm,
  resample,
  calculateRMS,
  float32ToPcm16,
  pcm16ToFloat32,
  detectAudioFormat,
  audioMimeType,
} from '../audio';

describe('audio utilities', () => {
  describe('float32ToPcm16', () => {
    it('converts Float32Array to PCM16 Buffer', () => {
      const samples = new Float32Array([0, 0.5, -0.5, 1.0, -1.0]);
      const pcm = float32ToPcm16(samples);
      expect(pcm.length).toBe(samples.length * 2);
    });

    it('clamps values to [-1, 1]', () => {
      const samples = new Float32Array([1.5, -1.5]);
      const pcm = float32ToPcm16(samples);
      const view = new DataView(pcm.buffer, pcm.byteOffset);
      expect(view.getInt16(0, true)).toBe(32767);
      expect(view.getInt16(2, true)).toBe(-32768);
    });
  });

  describe('pcm16ToFloat32', () => {
    it('converts PCM16 Buffer to Float32Array', () => {
      const original = new Float32Array([0, 0.5, -0.5]);
      const pcm = float32ToPcm16(original);
      const result = pcm16ToFloat32(pcm);
      expect(result.length).toBe(original.length);
      for (let i = 0; i < result.length; i++) {
        expect(result[i]).toBeCloseTo(original[i], 3);
      }
    });
  });

  describe('pcmToWav', () => {
    it('creates valid WAV header', () => {
      const pcm = float32ToPcm16(new Float32Array(1600));
      const wav = pcmToWav(pcm, 16000);
      expect(wav.length).toBe(pcm.length + 44);
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
      expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    });

    it('defaults to 16kHz sample rate', () => {
      const pcm = float32ToPcm16(new Float32Array(100));
      const wav = pcmToWav(pcm);
      const view = new DataView(wav.buffer, wav.byteOffset);
      expect(view.getUint32(24, true)).toBe(16000);
    });
  });

  describe('wavToPcm', () => {
    it('extracts PCM data and sample rate', () => {
      const samples = new Float32Array([0.1, 0.2, 0.3]);
      const pcm = float32ToPcm16(samples);
      const wav = pcmToWav(pcm, 44100);
      const result = wavToPcm(wav);
      expect(result.sampleRate).toBe(44100);
      expect(result.samples.length).toBe(samples.length);
    });

    it('throws on invalid WAV', () => {
      expect(() => wavToPcm(Buffer.from('not a wav'))).toThrow();
    });
  });

  describe('resample', () => {
    it('downsamples from 48kHz to 16kHz', () => {
      const input = new Float32Array(4800);
      for (let i = 0; i < input.length; i++) {
        input[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
      }
      const output = resample(input, 48000, 16000);
      expect(output.length).toBe(1600);
    });

    it('upsamples from 16kHz to 48kHz', () => {
      const input = new Float32Array(1600);
      const output = resample(input, 16000, 48000);
      expect(output.length).toBe(4800);
    });

    it('returns copy if rates match', () => {
      const input = new Float32Array([1, 2, 3]);
      const output = resample(input, 16000, 16000);
      expect(output).toEqual(input);
      expect(output).not.toBe(input);
    });
  });

  describe('calculateRMS', () => {
    it('returns 0 for silence', () => {
      expect(calculateRMS(new Float32Array(100))).toBe(0);
    });

    it('returns ~0.707 for full-scale sine wave', () => {
      const samples = new Float32Array(16000);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin((2 * Math.PI * 440 * i) / 16000);
      }
      expect(calculateRMS(samples)).toBeCloseTo(0.707, 2);
    });

    it('returns 1 for DC offset of 1', () => {
      const samples = new Float32Array(100).fill(1);
      expect(calculateRMS(samples)).toBeCloseTo(1, 5);
    });
  });

  describe('pcm16ToFloat32 odd-length input', () => {
    it('ignores a trailing odd byte instead of throwing', () => {
      const samples = pcm16ToFloat32(Buffer.from([0xff, 0x7f, 0x01]));
      expect(samples).toHaveLength(1);
      expect(samples[0]).toBeCloseTo(1, 5);
    });

    it('reads from a Buffer view with a non-zero byteOffset', () => {
      const backing = Buffer.from([0xaa, 0x00, 0x80, 0xbb]);
      const view = backing.subarray(1, 3);
      expect(Array.from(pcm16ToFloat32(view))).toEqual([-1]);
    });
  });

  describe('detectAudioFormat', () => {
    it.each([
      ['wav', pcmToWav(Buffer.alloc(4), 16000)],
      ['mp3', Buffer.concat([Buffer.from('ID3'), Buffer.alloc(8)])],
      ['mp3', Buffer.from([0xff, 0xfb, 0x90, 0x00])],
      ['ogg', Buffer.from('OggS\0\0\0\0')],
      ['flac', Buffer.from('fLaC\0\0\0\0')],
      ['webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00])],
      ['mp4', Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A ')])],
    ])('detects %s', (format, data) => {
      expect(detectAudioFormat(data)).toBe(format);
    });

    it('returns null for raw PCM and tiny buffers', () => {
      expect(detectAudioFormat(Buffer.alloc(64))).toBeNull();
      expect(detectAudioFormat(Buffer.from([1, 2]))).toBeNull();
      expect(detectAudioFormat(Buffer.from([0xff, 0xf1, 0x50, 0x80]))).toBeNull();
    });

    it('maps formats to mime types', () => {
      expect(audioMimeType('mp3')).toBe('audio/mpeg');
      expect(audioMimeType('wav')).toBe('audio/wav');
    });
  });
});
