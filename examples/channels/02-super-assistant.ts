import 'dotenv/config';
import { RuntimeBuilder } from '@cogitator-ai/channels';

const config = {
  name: 'jarvis',
  personality: `You are Jarvis, a personal AI assistant.
Be concise, friendly, and proactive.
Remember important things using memory tools.`,
  llm: {
    provider: 'google' as const,
    model: 'google/gemini-2.5-flash',
  },
  channels: {
    telegram: { ownerIds: [process.env.OWNER_TG_ID ?? ''] },
  },
  capabilities: {
    webSearch: true,
    scheduler: true,
  },
  memory: {
    adapter: 'sqlite' as const,
    path: '~/.cogitator/memory.db',
    knowledgeGraph: true,
    autoExtract: true,
  },
};

const builder = new RuntimeBuilder(config, process.env as Record<string, string>);
const runtime = await builder.build();

await runtime.gateway.start();
if (runtime.scheduler) runtime.scheduler.start();

console.log(`\n  ${config.name} is running!`);
console.log('  Press Ctrl+C to stop\n');

process.on('SIGINT', async () => {
  console.log('\n  Shutting down...');
  if (runtime.scheduler) runtime.scheduler.stop();
  await runtime.gateway.stop();
  await runtime.cleanup();
  process.exit(0);
});
