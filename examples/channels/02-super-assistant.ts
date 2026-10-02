import 'dotenv/config';
import { AssistantConfigSchema, RuntimeBuilder } from '@cogitator-ai/channels';

const OWNER_TG_ID = process.env.OWNER_TG_ID;

const config = AssistantConfigSchema.parse({
  name: 'jarvis',
  personality: `You are Jarvis, a personal AI assistant.
Be concise, friendly, and proactive.
Remember important things using memory tools.`,
  llm: {
    provider: 'google',
    model: 'google/gemini-3.8-flash',
  },
  channels: process.env.TG_TOKEN
    ? { telegram: { ownerIds: OWNER_TG_ID ? [OWNER_TG_ID] : [] } }
    : {},
  capabilities: {
    webSearch: true,
    scheduler: true,
  },
  memory: {
    adapter: 'sqlite',
    path: '~/.cogitator/memory.db',
    knowledgeGraph: true,
    autoExtract: true,
    compaction: { threshold: 50 },
  },
  security: {
    dmPolicy: OWNER_TG_ID ? 'pairing' : 'open',
  },
});

const builder = new RuntimeBuilder(config, process.env);
const runtime = await builder.build();

await runtime.gateway.start();

console.log(`\n  ${config.name} is running!`);
console.log('  Chat here in the terminal, or on Telegram if TG_TOKEN is set.');
console.log('  Owners can use /status, /sessions, /model, /compact, /help.');
console.log('  Press Ctrl+C to stop\n');

process.on('SIGINT', async () => {
  console.log('\n  Shutting down...');
  await runtime.cleanup();
  process.exit(0);
});
