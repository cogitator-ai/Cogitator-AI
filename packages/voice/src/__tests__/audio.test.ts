import { describe, it, expect } from 'vitest';
import {
  pcmToWav,
  wavToPcm,
  resample,
  calculateRMS,
  float32ToPcm16,
  pcm16ToFloat32,
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
});
