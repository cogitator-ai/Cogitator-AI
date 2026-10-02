import { header, section } from '../_shared/setup.js';
import { RealtimeSession } from '@cogitator-ai/voice';

async function main() {
  header('02 — Realtime Voice Session');

  const googleKey = process.env.GOOGLE_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!googleKey && !openaiKey) {
    console.log('Set GOOGLE_API_KEY (Gemini Live) or OPENAI_API_KEY (OpenAI Realtime)');
    process.exit(0);
  }
  const provider = googleKey ? 'gemini' : 'openai';

  section(`1. Create realtime session (${provider})`);
  const session = new RealtimeSession({
    provider,
    apiKey: (googleKey ?? openaiKey)!,
    instructions: 'You are a helpful voice assistant. Keep responses brief.',
    voice: provider === 'gemini' ? 'Puck' : 'marin',
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
          return { temperature: 22, unit: 'celsius', condition: 'sunny', location };
        },
      },
    ],
  });

  section('2. Set up event handlers');
  let audioBytes = 0;
  session.on('audio', (chunk) => {
    audioBytes += chunk.length;
  });
  session.on('transcript', (text, role) => {
    console.log(`  [${role}] ${text}`);
  });
  session.on('tool_call', (name, args) => {
    console.log(`  Tool called: ${name}(${JSON.stringify(args)})`);
  });
  session.on('error', (err) => {
    console.error(`  Error: ${err.message}`);
  });

  section('3. Connect & send message');
  await session.connect();
  console.log('  Connected');

  session.sendText('What is the weather in San Francisco?');
  console.log('  Sent text message, waiting for the spoken answer...');

  const deadline = Date.now() + 30_000;
  let spoke = false;
  while (!spoke && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, deadline - Date.now());
      session.once('turn_end', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    spoke = audioBytes > 0;
  }

  console.log(`  Received ${audioBytes} bytes of PCM16 24kHz audio`);
  session.close();
  console.log('\nSession closed. Done.');
}

void main();
