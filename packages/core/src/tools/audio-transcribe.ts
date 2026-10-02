import { z } from 'zod';
import { tool } from '../tool';
import { audioInputToBuffer } from '../utils/audio-fetch';
import { createLinkedAbortController, getAbortErrorMessage } from '../utils/abort';
import type { AudioInput } from '@cogitator-ai/types';

const TRANSCRIPTION_TIMEOUT_MS = 60_000;

export type TranscriptionModel =
  'gpt-transcribe' | 'whisper-1' | 'gpt-4o-transcribe' | 'gpt-4o-mini-transcribe';

const TRANSCRIPTION_MODELS = [
  'gpt-transcribe',
  'whisper-1',
  'gpt-4o-transcribe',
  'gpt-4o-mini-transcribe',
] as const satisfies readonly TranscriptionModel[];

const DEFAULT_TRANSCRIPTION_MODEL: TranscriptionModel = 'gpt-transcribe';
const TIMESTAMP_TRANSCRIPTION_MODEL: TranscriptionModel = 'whisper-1';

interface TranscriptionApiResponse {
  text: string;
  language?: string;
  languages?: Array<{ code?: string }>;
  duration?: number;
  words?: TranscriptionWord[];
}

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

export interface TranscribeAudioOptions {
  apiKey: string;
  model?: TranscriptionModel;
  language?: string;
  timestamps?: boolean;
  signal?: AbortSignal;
}

/**
 * Transcribe a single audio input with the OpenAI transcription API.
 * Defaults to `gpt-transcribe`; word timestamps without an explicit model use `whisper-1`,
 * the only transcription model that returns them.
 */
export async function transcribeAudio(
  audio: AudioInput,
  options: TranscribeAudioOptions
): Promise<TranscriptionResult> {
  const { buffer, filename } = await audioInputToBuffer(audio, {
    signal: options.signal,
    timeout: TRANSCRIPTION_TIMEOUT_MS,
  });

  const selectedModel =
    options.model ??
    (options.timestamps ? TIMESTAMP_TRANSCRIPTION_MODEL : DEFAULT_TRANSCRIPTION_MODEL);

  const formData = new FormData();
  formData.append('file', new Blob([new Uint8Array(buffer)]), filename);
  formData.append('model', selectedModel);

  if (options.language) {
    if (selectedModel === 'gpt-transcribe') {
      formData.append('languages[]', options.language);
    } else {
      formData.append('language', options.language);
    }
  }

  if (options.timestamps && selectedModel === 'whisper-1') {
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'word');
  }

  const abort = createLinkedAbortController(options.signal, TRANSCRIPTION_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.apiKey}` },
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
    const errorData = (await response.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    const errorMessage = errorData.error?.message || response.statusText || 'Unknown error';
    throw new Error(`Transcription failed: ${errorMessage}`);
  }

  const result = (await response.json()) as TranscriptionApiResponse;

  return {
    text: result.text,
    language: result.language ?? result.languages?.[0]?.code,
    duration: result.duration,
    words: result.words,
  };
}

export function createTranscribeAudioTool(config: TranscribeAudioConfig = {}) {
  const getApiKey = () => config.apiKey || process.env.OPENAI_API_KEY;

  return tool({
    name: 'transcribeAudio',
    description:
      'Transcribe audio to text using OpenAI speech-to-text models. Supports mp3, mp4, wav, webm, m4a, ogg, flac formats up to 25MB.',
    parameters: z.object({
      audio: audioInputSchema.describe('Audio file as URL or base64 data'),
      language: z
        .string()
        .optional()
        .describe('ISO-639-1 language code (e.g., "en", "es", "fr", "de", "ja")'),
      model: z
        .enum(TRANSCRIPTION_MODELS)
        .optional()
        .describe('Transcription model to use (default: gpt-transcribe)'),
      timestamps: z
        .boolean()
        .optional()
        .describe(
          'Include word-level timestamps. Only whisper-1 returns them; it is used automatically when no model is set'
        ),
    }),
    execute: async (
      { audio, language, model, timestamps },
      context
    ): Promise<TranscriptionResult> => {
      const apiKey = getApiKey();
      if (!apiKey) {
        throw new Error('OpenAI API key required for audio transcription');
      }

      return transcribeAudio(audio as AudioInput, {
        apiKey,
        model: model || config.defaultModel,
        language: language || config.defaultLanguage,
        timestamps,
        signal: context?.signal,
      });
    },
  });
}
