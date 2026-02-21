import { header, section } from '../_shared/setup.js';
import { RealtimeSession } from '@cogitator-ai/voice';

async function main() {
  header('02 — Realtime Voice Session');

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log('Set OPENAI_API_KEY to run this example');
    process.exit(0);
  }

  section('1. Create realtime session');
  const session = new RealtimeSession({
    provider: 'openai',
    apiKey,
    instructions: 'You are a helpful voice assistant. Keep responses brief.',
    voice: 'coral',
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
          return { temperature: 72, condition: 'sunny', location };
        },
      },
    ],
  });

  console.log('Session created (OpenAI Realtime API)');

  section('2. Set up event handlers');
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
  console.log('  Connected to OpenAI Realtime API');

  session.sendText('What is the weather in San Francisco?');
  console.log('  Sent text message, waiting for response...');

  await new Promise((resolve) => setTimeout(resolve, 5000));

  session.close();
  console.log('\nSession closed. Done.');
}

main();
