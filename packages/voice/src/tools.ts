import { z } from 'zod';
import type { STTProvider, TTSProvider } from './types.js';

export interface VoiceTool<TParams = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<TParams>;
  execute: (params: TParams) => Promise<unknown>;
}

const TranscribeParamsSchema = z.object({
  audioBase64: z.string().describe('Base64-encoded audio data'),
  language: z.string().optional().describe('Language code (e.g., "en", "es")'),
});

type TranscribeParams = z.infer<typeof TranscribeParamsSchema>;

const SpeakParamsSchema = z.object({
  text: z.string().describe('Text to convert to speech'),
  voice: z.string().optional().describe('Voice to use'),
});

type SpeakParams = z.infer<typeof SpeakParamsSchema>;

export function transcribeTool(stt: STTProvider): VoiceTool<TranscribeParams> {
  return {
    name: 'transcribe_audio',
    description: 'Transcribe audio input to text using speech recognition',
    parameters: TranscribeParamsSchema,
    execute: async ({ audioBase64, language }) => {
      const audio = Buffer.from(audioBase64, 'base64');
      const result = await stt.transcribe(audio, { language });
      return { text: result.text, language: result.language, duration: result.duration };
    },
  };
}

export function speakTool(tts: TTSProvider): VoiceTool<SpeakParams> {
  return {
    name: 'speak_text',
    description: 'Convert text to speech audio',
    parameters: SpeakParamsSchema,
    execute: async ({ text, voice }) => {
      const audio = await tts.synthesize(text, { voice });
      return { audioBase64: audio.toString('base64'), format: 'mp3' };
    },
  };
}

export function voiceTools(config: {
  stt: STTProvider;
  tts: TTSProvider;
}): [VoiceTool<TranscribeParams>, VoiceTool<SpeakParams>] {
  return [transcribeTool(config.stt), speakTool(config.tts)];
}
