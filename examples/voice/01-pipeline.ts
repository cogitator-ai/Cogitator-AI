import { header, section } from '../_shared/setup.js';
import { OpenAISTT, OpenAITTS, VoicePipeline, float32ToPcm16, pcmToWav } from '@cogitator-ai/voice';

async function main() {
  header('01 — Voice Pipeline');

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log('Set OPENAI_API_KEY to run this example');
    process.exit(0);
  }

  section('1. Configure STT & TTS');
  const stt = new OpenAISTT({ apiKey });
  const tts = new OpenAITTS({ apiKey, voice: 'coral' });
  console.log('STT: OpenAI Whisper');
  console.log('TTS: OpenAI (coral voice)');

  section('2. Create pipeline');
  const mockAgent = {
    run: async (input: string) => {
      console.log(`  Agent received: "${input}"`);
      return { content: `I heard you say: ${input}. How can I help?` };
    },
  };

  const pipeline = new VoicePipeline({ stt, tts, agent: mockAgent });
  console.log('Pipeline ready.');

  section('3. Generate test audio');
  const samples = new Float32Array(16000);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / 16000);
  }
  const wav = pcmToWav(float32ToPcm16(samples), 16000);
  console.log(`Test WAV: ${wav.length} bytes (1s of 440Hz tone)`);

  section('4. Process through pipeline');
  const result = await pipeline.process(wav);
  console.log(`Transcript: "${result.transcript}"`);
  console.log(`Response:   "${result.response}"`);
  console.log(`Audio size: ${result.audio.length} bytes`);

  console.log('\nDone.');
}

main();
