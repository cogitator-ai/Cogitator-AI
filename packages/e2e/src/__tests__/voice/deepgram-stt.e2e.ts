import { describe, it, expect } from 'vitest';
import { DeepgramSTT, float32ToPcm16, pcmToWav } from '@cogitator-ai/voice';

describe('Deepgram STT E2E', () => {
  const apiKey = process.env.DEEPGRAM_API_KEY;

  it.skipIf(!apiKey)(
    'transcribes audio via batch API',
    async () => {
      const stt = new DeepgramSTT({ apiKey: apiKey! });

      const pcm = float32ToPcm16(new Float32Array(16000));
      const wav = pcmToWav(pcm, 16000);

      const result = await stt.transcribe(wav);
      expect(result).toHaveProperty('text');
      expect(typeof result.text).toBe('string');
    },
    15000
  );
});
