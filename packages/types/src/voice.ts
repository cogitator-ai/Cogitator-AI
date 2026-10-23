export interface TranscribeResult {
  text: string;
  language?: string;
  duration?: number;
  words?: Array<{
    word: string;
    start: number;
    end: number;
    confidence: number;
  }>;
}

/**
 * Audio format of synthesized speech. `pcm16` is raw 16-bit little-endian PCM, `mulaw` raw G.711
 * μ-law at 8 kHz (telephone audio).
 */
export type VoiceAudioFormat = 'pcm16' | 'mulaw' | 'mp3' | 'opus' | 'aac' | 'flac' | 'wav';

export interface VoiceConfig {
  mode: 'pipeline' | 'realtime';
  audioFormat?: VoiceAudioFormat;
  sampleRate?: number;
}
