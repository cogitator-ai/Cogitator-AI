import { z } from 'zod';
import { tool } from '../tool';
import { createLinkedAbortController, getAbortErrorMessage } from '../utils/abort';

const SPEECH_GENERATION_TIMEOUT_MS = 60_000;

export type TTSModel = 'tts-1' | 'tts-1-hd' | 'gpt-4o-mini-tts';

export type TTSVoice =
  | 'alloy'
  | 'ash'
  | 'ballad'
  | 'coral'
  | 'echo'
  | 'fable'
  | 'nova'
  | 'onyx'
  | 'sage'
  | 'shimmer'
  | 'verse'
  | 'marin'
  | 'cedar';

export type TTSFormat = 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';

export interface GenerateSpeechConfig {
  apiKey?: string;
  defaultModel?: TTSModel;
  defaultVoice?: TTSVoice;
  defaultFormat?: TTSFormat;
  defaultSpeed?: number;
}

export interface SpeechResult {
  audioBase64: string;
  format: TTSFormat;
  voice: TTSVoice;
  model: TTSModel;
  textLength: number;
}

const voiceSchema = z.enum([
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
]);

const formatSchema = z.enum(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']);

const modelSchema = z.enum(['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts']);

export function createGenerateSpeechTool(config: GenerateSpeechConfig = {}) {
  const getApiKey = () => config.apiKey || process.env.OPENAI_API_KEY;

  return tool({
    name: 'generateSpeech',
    description:
      'Convert text to natural-sounding speech using OpenAI TTS. Returns base64-encoded audio. Max input: 4096 characters.',
    parameters: z.object({
      text: z.string().max(4096).describe('Text to convert to speech (max 4096 characters)'),
      voice: voiceSchema
        .optional()
        .describe(
          'Voice to use. Options: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse, marin, cedar'
        ),
      model: modelSchema
        .optional()
        .describe('TTS model. tts-1 is fast, tts-1-hd is higher quality'),
      speed: z
        .number()
        .min(0.25)
        .max(4.0)
        .optional()
        .describe('Speech speed (0.25 to 4.0, default 1.0)'),
      format: formatSchema.optional().describe('Output audio format (default: mp3)'),
    }),
    sideEffects: ['network', 'external'],
    execute: async ({ text, voice, model, speed, format }, context): Promise<SpeechResult> => {
      const apiKey = getApiKey();
      if (!apiKey) {
        throw new Error('OpenAI API key required for speech generation');
      }

      const selectedModel = model || config.defaultModel || 'tts-1';
      const selectedVoice = voice || config.defaultVoice || 'alloy';
      const selectedFormat = format || config.defaultFormat || 'mp3';
      const selectedSpeed = speed ?? config.defaultSpeed ?? 1.0;

      const abort = createLinkedAbortController(context?.signal, SPEECH_GENERATION_TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: selectedModel,
            input: text,
            voice: selectedVoice,
            speed: selectedSpeed,
            response_format: selectedFormat,
          }),
          signal: abort.signal,
        });
      } catch (err) {
        const error = err as Error;
        if (error.name === 'AbortError') {
          throw new Error(
            getAbortErrorMessage('Speech generation request', abort, SPEECH_GENERATION_TIMEOUT_MS)
          );
        }
        throw err;
      } finally {
        abort.cleanup();
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData.error?.message || response.statusText || 'Unknown error';
        throw new Error(`Speech generation failed: ${errorMessage}`);
      }

      const audioBuffer = await response.arrayBuffer();
      const audioBase64 = Buffer.from(audioBuffer).toString('base64');

      return {
        audioBase64,
        format: selectedFormat,
        voice: selectedVoice,
        model: selectedModel,
        textLength: text.length,
      };
    },
  });
}
