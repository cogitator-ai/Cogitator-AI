import type { Section } from './types';

export const voice: Section = {
  id: 'voice',
  title: 'Voice',
  icon: '🎙️',
  description:
    'Speech-to-text, agent and text-to-speech pipelines, realtime speech-to-speech and WebSocket voice servers.',
  recipes: [
    {
      id: 'voice-pipeline',
      title: 'Voice Pipeline',
      difficulty: 'medium',
      time: '10 min',
      problem:
        'You want to answer a spoken question with a spoken reply, using your Cogitator agent in the middle.',
      points: ['Combine `OpenAISTT`, an agent runner and `OpenAITTS` in `VoicePipeline`'],
      file: 'voice-pipeline.ts',
      code: `import { Agent, Cogitator } from '@cogitator-ai/core';
import { OpenAISTT, OpenAITTS, VoicePipeline, createCogitatorRunner } from '@cogitator-ai/voice';

const openaiKey = process.env.OPENAI_API_KEY;
const googleKey = process.env.GOOGLE_API_KEY;
if (!openaiKey || !googleKey) throw new Error('Set OPENAI_API_KEY and GOOGLE_API_KEY');

const stt = new OpenAISTT({ apiKey: openaiKey });
const tts = new OpenAITTS({ apiKey: openaiKey, voice: 'coral' });

const cog = new Cogitator({ llm: { providers: { google: { apiKey: googleKey } } } });
const agent = new Agent({
  name: 'voice-assistant',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are a voice assistant. Answer in one short sentence.',
});

const pipeline = new VoicePipeline({ stt, tts, agent: createCogitatorRunner(cog, agent) });

const question = await tts.synthesize('What is the capital of France?', { format: 'wav' });
const result = await pipeline.process(question, { sessionId: 'example' });

console.log(\`Heard:   "\${result.transcript}"\`);
console.log(\`Replied: "\${result.response}" (\${result.audio.length} bytes of MP3)\`);

await cog.close();`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/voice openai',
      env: ['OPENAI_API_KEY', 'GOOGLE_API_KEY'],
      run: 'OPENAI_API_KEY=your-key GOOGLE_API_KEY=your-key npx tsx voice-pipeline.ts',
      repoRun: 'npx tsx examples/voice/01-pipeline.ts',
      example: 'voice/01-pipeline.ts',
      docs: [
        {
          href: '/docs/voice/pipeline',
          label: 'Voice Pipeline',
        },
      ],
    },
    {
      id: 'realtime-session',
      title: 'Realtime Session',
      difficulty: 'medium',
      time: '10 min',
      problem: 'You want low-latency speech-to-speech with tool calling.',
      points: [
        'Open a Gemini Live `RealtimeSession` with a tool',
        'Listen for audio, transcripts and tool calls',
      ],
      file: 'realtime-session.ts',
      code: `import { RealtimeSession } from '@cogitator-ai/voice';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const session = new RealtimeSession({
  provider: 'gemini',
  apiKey,
  instructions: 'You are a helpful voice assistant. Keep responses brief.',
  voice: 'Puck',
  tools: [
    {
      name: 'get_weather',
      description: 'Get current weather for a location',
      parameters: {
        type: 'object',
        properties: { location: { type: 'string' } },
        required: ['location'],
      },
      execute: async (args: unknown) => {
        const { location } = args as { location: string };
        return { location, temperature: 22, unit: 'celsius', condition: 'sunny' };
      },
    },
  ],
});

let audioBytes = 0;
session.on('audio', (chunk) => {
  audioBytes += chunk.length;
});
session.on('transcript', (text, role) => console.log(\`[\${role}] \${text}\`));
session.on('tool_call', (name, args) => console.log(\`tool: \${name}(\${JSON.stringify(args)})\`));
session.on('error', (error) => console.error(error.message));

await session.connect();
session.sendText('What is the weather in San Francisco?');

const deadline = Date.now() + 30_000;
while (audioBytes === 0 && Date.now() < deadline) {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, deadline - Date.now());
    session.once('turn_end', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

console.log(\`Received \${audioBytes} bytes of PCM16 24kHz audio\`);
session.close();`,
      install: 'pnpm add @cogitator-ai/voice',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx realtime-session.ts',
      repoRun: 'npx tsx examples/voice/02-realtime.ts',
      notes: [
        {
          type: 'tip',
          text: "With `provider: 'openai'` and an OpenAI key the same code runs on the OpenAI Realtime API (pick an OpenAI voice such as `marin`).",
        },
      ],
      example: 'voice/02-realtime.ts',
      docs: [
        {
          href: '/docs/voice/realtime',
          label: 'Realtime',
        },
      ],
    },
    {
      id: 'voice-agent',
      title: 'Voice Agent Server',
      difficulty: 'advanced',
      time: '15 min',
      problem: 'Browsers or phones should stream audio to your agent and hear it answer.',
      points: [
        'Serve a `VoiceAgent` over WebSocket with Deepgram STT, ElevenLabs TTS and energy-based VAD',
      ],
      file: 'voice-agent.ts',
      code: `import { Agent, Cogitator } from '@cogitator-ai/core';
import { DeepgramSTT, ElevenLabsTTS, EnergyVAD, VoiceAgent, createCogitatorRunner } from '@cogitator-ai/voice';

const googleKey = process.env.GOOGLE_API_KEY;
const deepgramKey = process.env.DEEPGRAM_API_KEY;
const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
if (!googleKey || !deepgramKey || !elevenLabsKey) {
  throw new Error('Set GOOGLE_API_KEY, DEEPGRAM_API_KEY and ELEVENLABS_API_KEY');
}

const cog = new Cogitator({
  llm: { providers: { google: { apiKey: googleKey } } },
  memory: { adapter: 'memory' },
});

const agent = new Agent({
  name: 'voice-assistant',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are a friendly voice assistant. Answer in one or two short sentences.',
});

const voiceAgent = new VoiceAgent({
  agent: createCogitatorRunner(cog, agent),
  mode: 'pipeline',
  stt: new DeepgramSTT({ apiKey: deepgramKey, model: 'nova-3', sampleRate: 16000 }),
  tts: new ElevenLabsTTS({ apiKey: elevenLabsKey }),
  vad: new EnergyVAD({ threshold: 0.02 }),
  transport: { path: '/voice', maxConnections: 10 },
});

voiceAgent.on('session_start', (id) => console.log(\`session started: \${id}\`));
voiceAgent.on('session_end', (id) => console.log(\`session ended: \${id}\`));
voiceAgent.on('error', (error) => console.error(error.message));

await voiceAgent.listen(8080);
console.log('Voice agent on ws://localhost:8080/voice — send PCM16 16kHz mono frames');

process.on('SIGINT', async () => {
  await voiceAgent.close();
  await cog.close();
  process.exit(0);
});`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/voice',
      env: ['GOOGLE_API_KEY', 'DEEPGRAM_API_KEY', 'ELEVENLABS_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key DEEPGRAM_API_KEY=your-key ELEVENLABS_API_KEY=your-key npx tsx voice-agent.ts',
      repoRun: 'npx tsx examples/voice/03-voice-agent.ts',
      notes: [
        {
          type: 'info',
          text: 'Clients send PCM16 16 kHz mono binary frames and JSON control messages: `interrupt`, `end_of_speech` or `{ "type": "text", "text": "..." }`.',
        },
      ],
      example: 'voice/03-voice-agent.ts',
      docs: [
        {
          href: '/docs/voice',
          label: 'Voice',
        },
      ],
    },
    {
      id: 'realtime-voice-agent',
      title: 'Realtime Voice Agent',
      difficulty: 'advanced',
      time: '15 min',
      problem: 'The same WebSocket server, but backed by a realtime model with server-side tools.',
      points: [
        'Run `VoiceAgent` in `realtime` mode on Gemini Live',
        'Talk to it from a WebSocket client',
      ],
      file: 'realtime-voice-agent.ts',
      code: `import { VoiceAgent } from '@cogitator-ai/voice';
import { WebSocket } from 'ws';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const voiceAgent = new VoiceAgent({
  mode: 'realtime',
  agent: {
    run: async () => ({ content: '' }),
    instructions: 'You are a concise voice concierge. Use tools when they help.',
  },
  realtimeProvider: 'gemini',
  realtimeApiKey: apiKey,
  voice: 'Puck',
  tools: [
    {
      name: 'get_opening_hours',
      description: 'Opening hours of the office for a given weekday',
      parameters: {
        type: 'object',
        properties: { day: { type: 'string', description: 'Weekday name' } },
        required: ['day'],
      },
      execute: async (args) => {
        const { day } = args as { day: string };
        return { day, open: '09:00', close: day.toLowerCase() === 'friday' ? '15:00' : '18:00' };
      },
    },
  ],
});
voiceAgent.on('error', (error) => console.error(error.message));
await voiceAgent.listen(0);

const client = new WebSocket(\`ws://localhost:\${voiceAgent.port}/voice\`);
let audioBytes = 0;
const answered = new Promise<void>((resolve) => {
  client.on('message', (data, isBinary) => {
    if (isBinary) {
      audioBytes += (data as Buffer).length;
      return;
    }
    const event = JSON.parse(data.toString()) as { type: string; text?: string; role?: string };
    if (event.type === 'transcript') console.log(\`[\${event.role}] \${event.text}\`);
    if (event.type === 'turn_end' && audioBytes > 0) resolve();
  });
});
await new Promise<void>((resolve) => client.once('open', () => resolve()));

client.send(JSON.stringify({ type: 'text', text: 'When does the office close on Friday?' }));
await Promise.race([answered, new Promise((resolve) => setTimeout(resolve, 30_000))]);
console.log(\`Received \${audioBytes} bytes of PCM16 24kHz audio\`);

client.close();
await voiceAgent.close();`,
      install: 'pnpm add @cogitator-ai/voice ws ws',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx realtime-voice-agent.ts',
      repoRun: 'npx tsx examples/voice/04-realtime-voice-agent.ts',
      example: 'voice/04-realtime-voice-agent.ts',
      docs: [
        {
          href: '/docs/voice/realtime',
          label: 'Realtime',
        },
      ],
    },
  ],
};
