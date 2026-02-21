import { describe, it, expect } from 'vitest';
import { OpenAISTT, OpenAITTS, VoicePipeline, float32ToPcm16, pcmToWav } from '@cogitator-ai/voice';

describe('Voice Pipeline E2E (OpenAI)', () => {
  const apiKey = process.env.OPENAI_API_KEY;

  it.skipIf(!apiKey)(
    'runs full STT -> Agent -> TTS pipeline',
    async () => {
      const stt = new OpenAISTT({ apiKey: apiKey! });
      const tts = new OpenAITTS({ apiKey: apiKey! });

      const mockAgent = {
        run: async (input: string) => ({ content: `You said: ${input}` }),
      };

      const pipeline = new VoicePipeline({ stt, tts, agent: mockAgent });

      const samples = new Float32Array(16000);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / 16000);
      }
      const pcm = float32ToPcm16(samples);
      const wav = pcmToWav(pcm, 16000);

      const result = await pipeline.process(wav);
      expect(result).toHaveProperty('transcript');
      expect(result).toHaveProperty('response');
      expect(result).toHaveProperty('audio');
      expect(typeof result.transcript).toBe('string');
      expect(typeof result.response).toBe('string');
      expect(result.audio.length).toBeGreaterThan(0);
    },
    30000
  );

  it.skipIf(!apiKey)(
    'transcribes audio with OpenAI STT',
    async () => {
      const stt = new OpenAISTT({ apiKey: apiKey! });

      const pcm = float32ToPcm16(new Float32Array(16000));
      const wav = pcmToWav(pcm, 16000);

      const result = await stt.transcribe(wav);
      expect(result).toHaveProperty('text');
      expect(typeof result.text).toBe('string');
    },
    15000
  );

  it.skipIf(!apiKey)(
    'generates speech with OpenAI TTS',
    async () => {
      const tts = new OpenAITTS({ apiKey: apiKey! });

      const audio = await tts.synthesize('Hello, this is a test.');
      expect(audio).toBeInstanceOf(Buffer);
      expect(audio.length).toBeGreaterThan(100);
    },
    15000
  );
});
