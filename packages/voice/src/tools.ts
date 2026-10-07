import { z } from 'zod';
import type { ToolContentResult } from '@cogitator-ai/types';
import type { STTProvider, TTSProvider } from './types.js';

export interface VoiceTool<TParams = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<TParams>;
  execute: (params: TParams) => Promise<unknown>;
}

const MAX_AUDIO_BASE64_LENGTH = 50 * 1024 * 1024 * 1.37;

const TranscribeParamsSchema = z.object({
  audioBase64: z
    .string()
    .max(Math.ceil(MAX_AUDIO_BASE64_LENGTH))
    .describe('Base64-encoded audio data'),
  language: z.string().optional().describe('Language code (e.g., "en", "es")'),
});

type TranscribeParams = z.infer<typeof TranscribeParamsSchema>;

const SpeakParamsSchema = z.object({
  text: z.string().describe('Text to convert to speech'),
  voice: z.string().optional().describe('Voice to use'),
  format: z
    .enum(['pcm16', 'mp3', 'opus', 'aac', 'flac', 'wav'])
    .optional()
    .describe('Output audio format'),
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

type SpeechFormat = NonNullable<SpeakParams['format']>;

const SPEECH_MEDIA_TYPES: Record<SpeechFormat, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm16: 'audio/L16',
};

/**
 * `speak_text`: synthesizes speech and returns it as a tool result with a `file` part (see
 * `ToolContentResult`). The application gets the audio from the result, in `onToolResult` or
 * `RunResult.toolCalls`, while the model sees only a one-line description instead of the base64
 * audio, which would fill its context.
 */
export function speakTool(tts: TTSProvider): VoiceTool<SpeakParams> {
  return {
    name: 'speak_text',
    description: 'Convert text to speech audio, which is delivered to the application',
    parameters: SpeakParamsSchema,
    execute: async ({ text, voice, format }) => {
      const audio = await tts.synthesize(text, { voice, format });
      const speechFormat = format ?? 'mp3';
      const result: ToolContentResult = {
        type: 'tool-content',
        content: [
          {
            type: 'text',
            text: `Synthesized speech: ${audio.length} bytes of ${speechFormat} audio, delivered to the application.`,
          },
          {
            type: 'file',
            data: audio.toString('base64'),
            mediaType: SPEECH_MEDIA_TYPES[speechFormat],
            filename: `speech.${speechFormat === 'pcm16' ? 'pcm' : speechFormat}`,
          },
        ],
      };
      return result;
    },
  };
}

export function voiceTools(config: {
  stt: STTProvider;
  tts: TTSProvider;
}): [VoiceTool<TranscribeParams>, VoiceTool<SpeakParams>] {
  return [transcribeTool(config.stt), speakTool(config.tts)];
}
