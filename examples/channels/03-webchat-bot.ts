import 'dotenv/config';
import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { Gateway, webchatChannel } from '@cogitator-ai/channels';
import { z } from 'zod';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const WEBCHAT_TOKEN = process.env.WEBCHAT_TOKEN ?? 'dev-token';
const PORT = Number(process.env.WEBCHAT_PORT ?? 3100);

if (!GOOGLE_API_KEY) {
  console.error('\n  Missing GOOGLE_API_KEY.\n');
  process.exit(1);
}

const timeTool = tool({
  name: 'current_time',
  description: 'Get the current date and time',
  parameters: z.object({}),
  execute: async () => ({
    iso: new Date().toISOString(),
    readable: new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'long' }),
  }),
});

const agent = new Agent({
  name: 'webchat-assistant',
  model: 'google/gemini-2.5-flash',
  instructions: `You are a helpful assistant connected via WebChat.
Keep responses concise. Use markdown for formatting.`,
  tools: [timeTool],
});

const cogitator = new Cogitator({
  llm: {
    defaultProvider: 'google',
    providers: { google: { apiKey: GOOGLE_API_KEY } },
  },
});

const gateway = new Gateway({
  agent,
  cogitator,
  channels: [
    webchatChannel({
      port: PORT,
      auth: (token) => token === WEBCHAT_TOKEN,
    }),
  ],
  stream: { flushInterval: 500, minChunkSize: 20 },
  onError: (err, msg) => {
    console.error(`Error processing message from ${msg.userId}:`, err.message);
  },
});

await gateway.start();

console.log(`\n  WebChat bot running on ws://localhost:${PORT}/ws`);
console.log(`  Token: ${WEBCHAT_TOKEN}`);
console.log(`\n  Connect with: npx wscat -c "ws://localhost:${PORT}/ws?token=${WEBCHAT_TOKEN}"`);
console.log('  Or open examples/channels/webchat-client.html in a browser\n');

process.on('SIGINT', async () => {
  console.log('\n  Shutting down...');
  await gateway.stop();
  await cogitator.close();
  process.exit(0);
});
