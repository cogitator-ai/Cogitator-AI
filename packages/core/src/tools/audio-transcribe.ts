import { z } from 'zod';
import { tool } from '../tool';
import { audioInputToBuffer } from '../utils/audio-fetch';
import { createLinkedAbortController, getAbortErrorMessage } from '../utils/abort';
import type { AudioFormat } from '@cogitator-ai/types';

const TRANSCRIPTION_TIMEOUT_MS = 60_000;

export type TranscriptionModel = 'whisper-1' | 'gpt-4o-transcribe' | 'gpt-4o-mini-transcribe';

export interface TranscribeAudioConfig {
  apiKey?: string;
  defaultModel?: TranscriptionModel;
  defaultLanguage?: string;
}

export interface TranscriptionWord {
  word: string;
  start: number;
  end: number;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
  words?: TranscriptionWord[];
}

const audioInputSchema = z.union([
  z.string().describe('URL of the audio file'),
  z.object({
    data: z.string().describe('Base64 encoded audio data'),
    format: z
      .enum(['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm', 'ogg', 'flac'])
      .describe('Audio format'),
  }),
]);

export function createTranscribeAudioTool(config: TranscribeAudioConfig = {}) {
  const getApiKey = () => config.apiKey || process.env.OPENAI_API_KEY;

  return tool({
    name: 'transcribeAudio',
    description:
      'Transcribe audio to text using OpenAI Whisper. Supports mp3, mp4, wav, webm, m4a, ogg, flac formats up to 25MB.',
    parameters: z.object({
      audio: audioInputSchema.describe('Audio file as URL or base64 data'),
      language: z
        .string()
        .optional()
        .describe('ISO-639-1 language code (e.g., "en", "es", "fr", "de", "ja")'),
      model: z
        .enum(['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'])
        .optional()
        .describe('Transcription model to use'),
      timestamps: z
        .boolean()
        .optional()
        .describe('Include word-level timestamps (only supported with whisper-1)'),
    }),
    execute: async (
      { audio, language, model, timestamps },
      context
    ): Promise<TranscriptionResult> => {
      const apiKey = getApiKey();
      if (!apiKey) {
        throw new Error('OpenAI API key required for audio transcription');
      }

      const { buffer, filename } = await audioInputToBuffer(
        audio as string | { data: string; format: AudioFormat },
        { signal: context?.signal, timeout: TRANSCRIPTION_TIMEOUT_MS }
      );

      const selectedModel = model || config.defaultModel || 'whisper-1';
      const selectedLanguage = language || config.defaultLanguage;

      const formData = new FormData();
      formData.append('file', new Blob([new Uint8Array(buffer)]), filename);
      formData.append('model', selectedModel);

      if (selectedLanguage) {
        formData.append('language', selectedLanguage);
      }

      if (timestamps && selectedModel === 'whisper-1') {
        formData.append('response_format', 'verbose_json');
        formData.append('timestamp_granularities[]', 'word');
      }

      const abort = createLinkedAbortController(context?.signal, TRANSCRIPTION_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: formData,
          signal: abort.signal,
        });
      } catch (err) {
        const error = err as Error;
        if (error.name === 'AbortError') {
          throw new Error(
            getAbortErrorMessage('Transcription request', abort, TRANSCRIPTION_TIMEOUT_MS)
          );
        }
        throw err;
      } finally {
        abort.cleanup();
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData.error?.message || response.statusText || 'Unknown error';
        throw new Error(`Transcription failed: ${errorMessage}`);
      }

      const result = await response.json();

      return {
        text: result.text,
        language: result.language,
        duration: result.duration,
        words: result.words,
      };
    },
  });
}
