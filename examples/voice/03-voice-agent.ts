import { header, section } from '../_shared/setup.js';
import { VoiceAgent, DeepgramSTT, ElevenLabsTTS, EnergyVAD } from '@cogitator-ai/voice';

async function main() {
  header('03 — Voice Agent (WebSocket Server)');

  const openaiKey = process.env.OPENAI_API_KEY;
  const deepgramKey = process.env.DEEPGRAM_API_KEY;
  const elevenLabsKey = process.env.ELEVENLABS_API_KEY;

  if (!openaiKey || !deepgramKey || !elevenLabsKey) {
    console.log('Set OPENAI_API_KEY, DEEPGRAM_API_KEY, ELEVENLABS_API_KEY to run this example');
    process.exit(0);
  }

  section('1. Define agent logic');
  const mockAgent = {
    run: async (input: string) => {
      return { content: `You said: ${input}. I'm a voice agent powered by Cogitator!` };
    },
  };

  section('2. Create voice agent');
  const voiceAgent = new VoiceAgent({
    agent: mockAgent,
    mode: 'pipeline',
    stt: new DeepgramSTT({ apiKey: deepgramKey, model: 'nova-3' }),
    tts: new ElevenLabsTTS({ apiKey: elevenLabsKey }),
    vad: new EnergyVAD({ threshold: 0.02 }),
    transport: { path: '/voice', maxConnections: 10 },
  });

  voiceAgent.on('session_start', (id) => console.log(`  Session started: ${id}`));
  voiceAgent.on('session_end', (id) => console.log(`  Session ended: ${id}`));
  voiceAgent.on('error', (err) => console.error(`  Error: ${err.message}`));

  section('3. Start WebSocket server');
  await voiceAgent.listen(8080);
  console.log('Voice agent listening on ws://localhost:8080/voice');
  console.log('Connect with a WebSocket client to start a voice conversation.');
  console.log('Press Ctrl+C to stop.\n');

  process.on('SIGINT', async () => {
    await voiceAgent.close();
    process.exit(0);
  });
}

main();
