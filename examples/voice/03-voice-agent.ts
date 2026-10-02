import { Agent } from '@cogitator-ai/core';
import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import {
  VoiceAgent,
  DeepgramSTT,
  ElevenLabsTTS,
  EnergyVAD,
  createCogitatorRunner,
} from '@cogitator-ai/voice';

async function main() {
  header('03 — Voice Agent (WebSocket Server)');

  const deepgramKey = process.env.DEEPGRAM_API_KEY;
  const elevenLabsKey = process.env.ELEVENLABS_API_KEY;

  if (!process.env.GOOGLE_API_KEY || !deepgramKey || !elevenLabsKey) {
    console.log('Set GOOGLE_API_KEY, DEEPGRAM_API_KEY, ELEVENLABS_API_KEY to run this example');
    process.exit(0);
  }

  section('1. Create the Cogitator agent');
  const cogitator = createCogitator({ memory: { adapter: 'memory' } });
  const agent = new Agent({
    name: 'voice-assistant',
    model: DEFAULT_MODEL,
    instructions: 'You are a friendly voice assistant. Answer in one or two short sentences.',
  });

  section('2. Create voice agent');
  const voiceAgent = new VoiceAgent({
    agent: createCogitatorRunner(cogitator, agent),
    mode: 'pipeline',
    stt: new DeepgramSTT({ apiKey: deepgramKey, model: 'nova-3', sampleRate: 16000 }),
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
  console.log('Send PCM16 16kHz mono binary frames; JSON control messages:');
  console.log(
    '  { "type": "interrupt" } | { "type": "end_of_speech" } | { "type": "text", "text": "..." }'
  );
  console.log('Press Ctrl+C to stop.\n');

  process.on('SIGINT', async () => {
    await voiceAgent.close();
    await cogitator.close();
    process.exit(0);
  });
}

void main();
