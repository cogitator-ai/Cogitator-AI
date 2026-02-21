import { describe, it, expect } from 'vitest';
import { ElevenLabsTTS } from '@cogitator-ai/voice';

describe('ElevenLabs TTS E2E', () => {
  const apiKey = process.env.ELEVENLABS_API_KEY;

  it.skipIf(!apiKey)(
    'generates speech',
    async () => {
      const tts = new ElevenLabsTTS({ apiKey: apiKey! });

      const audio = await tts.synthesize('Hello from Cogitator voice package.');
      expect(audio).toBeInstanceOf(Buffer);
      expect(audio.length).toBeGreaterThan(100);
    },
    15000
  );

  it.skipIf(!apiKey)(
    'streams speech',
    async () => {
      const tts = new ElevenLabsTTS({ apiKey: apiKey! });

      const chunks: Buffer[] = [];
      for await (const chunk of tts.streamSynthesize('This is a streaming test.')) {
        chunks.push(chunk);
      }
      expect(chunks.length).toBeGreaterThan(0);
      const totalSize = chunks.reduce((sum, c) => sum + c.length, 0);
      expect(totalSize).toBeGreaterThan(100);
    },
    15000
  );
});
