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

export type VoiceAudioFormat = 'pcm16' | 'mp3' | 'opus' | 'aac' | 'flac' | 'wav';

export interface VoiceConfig {
  mode: 'pipeline' | 'realtime';
  audioFormat?: VoiceAudioFormat;
  sampleRate?: number;
}
