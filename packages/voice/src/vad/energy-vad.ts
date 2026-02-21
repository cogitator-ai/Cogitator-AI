import type { VADEvent, VADProvider } from '../types.js';
import { calculateRMS } from '../audio.js';

export interface EnergyVADConfig {
  threshold?: number;
  silenceDuration?: number;
  sampleRate?: number;
}

export class EnergyVAD implements VADProvider {
  readonly name = 'energy';

  private readonly threshold: number;
  private readonly silenceDuration: number;
  private readonly sampleRate: number;

  private state: 'idle' | 'speaking' = 'idle';
  private speechSamples = 0;
  private silenceSamples = 0;

  constructor(config: EnergyVADConfig = {}) {
    this.threshold = config.threshold ?? 0.01;
    this.silenceDuration = config.silenceDuration ?? 500;
    this.sampleRate = config.sampleRate ?? 16000;
  }

  process(samples: Float32Array): VADEvent {
    const rms = calculateRMS(samples);
    const isSpeech = rms > this.threshold;
    const chunkDurationMs = (samples.length / this.sampleRate) * 1000;

    if (this.state === 'idle') {
      if (isSpeech) {
        this.state = 'speaking';
        this.speechSamples = samples.length;
        this.silenceSamples = 0;
        return { type: 'speech_start' };
      }
      return { type: 'silence' };
    }

    this.speechSamples += samples.length;

    if (isSpeech) {
      this.silenceSamples = 0;
      return { type: 'speech', probability: Math.min(1, rms / 0.5) };
    }

    this.silenceSamples += chunkDurationMs;

    if (this.silenceSamples >= this.silenceDuration) {
      const duration = (this.speechSamples / this.sampleRate) * 1000;
      this.state = 'idle';
      this.speechSamples = 0;
      this.silenceSamples = 0;
      return { type: 'speech_end', duration };
    }

    return { type: 'speech', probability: 0 };
  }

  reset(): void {
    this.state = 'idle';
    this.silenceSamples = 0;
    this.speechSamples = 0;
  }
}
