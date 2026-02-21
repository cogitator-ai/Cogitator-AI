import { describe, it, expect, beforeEach } from 'vitest';
import { EnergyVAD } from '../../vad/energy-vad';
import type { VADEvent } from '../../types';

function generateSilence(length: number): Float32Array {
  return new Float32Array(length);
}

function generateSpeech(length: number, amplitude = 0.5): Float32Array {
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / 16000);
  }
  return samples;
}

describe('EnergyVAD', () => {
  let vad: EnergyVAD;

  beforeEach(() => {
    vad = new EnergyVAD();
  });

  it('has correct name', () => {
    expect(vad.name).toBe('energy');
  });

  it('returns silence for silent audio', () => {
    const event = vad.process(generateSilence(480));
    expect(event).toEqual({ type: 'silence' });
  });

  it('detects speech_start when amplitude crosses threshold', () => {
    const event = vad.process(generateSpeech(480));
    expect(event).toEqual({ type: 'speech_start' });
  });

  it('returns speech events during active speech with probability', () => {
    vad.process(generateSpeech(480));
    const event = vad.process(generateSpeech(480, 0.3));
    expect(event.type).toBe('speech');
    expect((event as Extract<VADEvent, { type: 'speech' }>).probability).toBeGreaterThan(0);
    expect((event as Extract<VADEvent, { type: 'speech' }>).probability).toBeLessThanOrEqual(1);
  });

  it('returns higher probability for louder speech', () => {
    vad.process(generateSpeech(480, 0.5));
    const quietEvent = vad.process(generateSpeech(480, 0.1));
    vad.reset();
    vad.process(generateSpeech(480, 0.5));
    const loudEvent = vad.process(generateSpeech(480, 0.8));

    const quietProb = (quietEvent as Extract<VADEvent, { type: 'speech' }>).probability;
    const loudProb = (loudEvent as Extract<VADEvent, { type: 'speech' }>).probability;
    expect(loudProb).toBeGreaterThan(quietProb);
  });

  it('detects speech_end after enough silence', () => {
    vad.process(generateSpeech(480));

    const chunkDurationMs = (480 / 16000) * 1000;
    const chunksNeeded = Math.ceil(500 / chunkDurationMs);

    const events: VADEvent[] = [];
    for (let i = 0; i < chunksNeeded; i++) {
      events.push(vad.process(generateSilence(480)));
    }

    const speechEnd = events.find(
      (e): e is Extract<VADEvent, { type: 'speech_end' }> => e.type === 'speech_end'
    );
    expect(speechEnd).toBeDefined();
    expect(speechEnd!.duration).toBeGreaterThan(0);
  });

  it('reports correct speech duration in speech_end', () => {
    const chunkSize = 480;
    const chunkDurationMs = (chunkSize / 16000) * 1000;

    vad.process(generateSpeech(chunkSize));
    vad.process(generateSpeech(chunkSize));
    vad.process(generateSpeech(chunkSize));

    const silenceChunksNeeded = Math.ceil(500 / chunkDurationMs);
    const events: VADEvent[] = [];
    for (let i = 0; i < silenceChunksNeeded; i++) {
      events.push(vad.process(generateSilence(chunkSize)));
    }

    const speechEnd = events.find(
      (e): e is Extract<VADEvent, { type: 'speech_end' }> => e.type === 'speech_end'
    );
    expect(speechEnd).toBeDefined();
    const duration = speechEnd!.duration;
    expect(duration).toBeGreaterThanOrEqual(3 * chunkDurationMs);
    expect(duration).toBeLessThan(3 * chunkDurationMs + 600);
  });

  it('reset clears state back to idle', () => {
    vad.process(generateSpeech(480));
    expect(vad.process(generateSpeech(480)).type).toBe('speech');

    vad.reset();

    const event = vad.process(generateSpeech(480));
    expect(event).toEqual({ type: 'speech_start' });
  });

  it('works with default config values', () => {
    const defaultVad = new EnergyVAD();
    const event = defaultVad.process(generateSilence(480));
    expect(event).toEqual({ type: 'silence' });
  });

  it('respects custom threshold', () => {
    const highThreshold = new EnergyVAD({ threshold: 0.9 });
    const event = highThreshold.process(generateSpeech(480, 0.5));
    expect(event).toEqual({ type: 'silence' });
  });

  it('respects custom silenceDuration', () => {
    const shortSilence = new EnergyVAD({ silenceDuration: 50 });
    shortSilence.process(generateSpeech(480));

    const chunkDurationMs = (480 / 16000) * 1000;
    const chunksNeeded = Math.ceil(50 / chunkDurationMs);

    const events: VADEvent[] = [];
    for (let i = 0; i < chunksNeeded; i++) {
      events.push(shortSilence.process(generateSilence(480)));
    }
    expect(events.some((e) => e.type === 'speech_end')).toBe(true);
  });

  it('stays in speaking state during brief silence', () => {
    vad.process(generateSpeech(480));

    const event = vad.process(generateSilence(480));
    expect(event.type).toBe('speech');
  });
});
