import 'dotenv/config';
import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { Gateway, telegramChannel, ownerCommands, rateLimit } from '@cogitator-ai/channels';
import { z } from 'zod';

const TG_TOKEN = process.env.TG_TOKEN;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const OWNER_TG_ID = process.env.OWNER_TG_ID;

if (!TG_TOKEN) {
  console.error('\n  Missing TG_TOKEN. Get one from @BotFather on Telegram.\n');
  process.exit(1);
}
if (!GOOGLE_API_KEY) {
  console.error('\n  Missing GOOGLE_API_KEY.\n');
  process.exit(1);
}

const timeTool = tool({
  name: 'current_time',
  description: 'Get the current date and time',
  parameters: z.object({}),
  execute: async () => {
    const now = new Date();
    return {
      iso: now.toISOString(),
      readable: now.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'long' }),
      unix: Math.floor(now.getTime() / 1000),
    };
  },
});

const calcTool = tool({
  name: 'calculate',
  description: 'Evaluate a math expression',
  parameters: z.object({
    expression: z.string().describe('The math expression to evaluate, e.g. "2 + 2 * 3"'),
  }),
  execute: async ({ expression }) => {
    const sanitized = expression.replace(/[^0-9+\-*/().%\s]/g, '');
    const result = new Function(`return (${sanitized})`)() as number;
    return { expression, result };
  },
});

const agent = new Agent({
  name: 'telegram-assistant',
  model: 'google/gemini-2.5-flash',
  instructions: `You are a helpful personal assistant on Telegram.

IMPORTANT: You MUST use your tools when relevant. NEVER guess or make up answers when a tool can provide accurate data.
- For ANY question about current time/date → ALWAYS call current_time tool
- For ANY math expression → ALWAYS call calculate tool

Keep responses concise — this is a chat messenger, not an essay.
Use markdown formatting when it helps readability.`,
  tools: [timeTool, calcTool],
});

const cogitator = new Cogitator({
  llm: {
    defaultProvider: 'google',
    providers: {
      google: { apiKey: GOOGLE_API_KEY },
    },
  },
});

const middleware = [rateLimit({ maxPerMinute: 15 })];

if (OWNER_TG_ID) {
  middleware.unshift(
    ownerCommands({
      ownerIds: { telegram: OWNER_TG_ID },
      onStatus: () => {
        const stats = gateway.stats;
        return [
          `Uptime: ${formatMs(stats.uptime)}`,
          `Messages: ${stats.messagesToday} today`,
          `Channels: ${stats.connectedChannels.join(', ')}`,
        ].join('\n');
      },
    })
  );
}

const gateway = new Gateway({
  agent,
  cogitator,
  channels: [telegramChannel({ token: TG_TOKEN })],
  middleware,
  stream: { flushInterval: 600, minChunkSize: 30 },
  onError: (err, msg) => {
    console.error(`Error processing message from ${msg.userId}:`, err.message);
  },
});

await gateway.start();

console.log('\n  Telegram assistant is running!');
console.log(`  Bot token: ${TG_TOKEN.slice(0, 8)}...`);
if (OWNER_TG_ID) {
  console.log(`  Owner: ${OWNER_TG_ID} (use /status, /help in chat)`);
}
console.log('\n  Press Ctrl+C to stop\n');

process.on('SIGINT', async () => {
  console.log('\n  Shutting down...');
  await gateway.stop();
  await cogitator.close();
  process.exit(0);
});

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
