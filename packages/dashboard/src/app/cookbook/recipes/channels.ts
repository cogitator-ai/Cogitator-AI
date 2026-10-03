import type { Section } from './types';

export const channels: Section = {
  id: 'channels',
  title: 'Messaging Channels',
  icon: '💬',
  description:
    'Put an agent on Telegram or a WebChat socket, or build a full personal assistant from a config object.',
  recipes: [
    {
      id: 'telegram-bot',
      title: 'Telegram Bot',
      difficulty: 'easy',
      time: '10 min',
      problem:
        'You want your agent as a Telegram bot with streamed replies, rate limiting and owner-only commands.',
      points: [
        'Run a `Gateway` with `telegramChannel()`',
        'Add `rateLimit()` and `ownerCommands()` middleware',
      ],
      file: 'telegram-bot.ts',
      code: `import { Agent, Cogitator, calculator, datetime } from '@cogitator-ai/core';
import { Gateway, ownerCommands, rateLimit, telegramChannel } from '@cogitator-ai/channels';

const token = process.env.TG_TOKEN;
const apiKey = process.env.GOOGLE_API_KEY;
const ownerId = process.env.OWNER_TG_ID;
if (!token || !apiKey) throw new Error('Set TG_TOKEN (from @BotFather) and GOOGLE_API_KEY');

const agent = new Agent({
  name: 'telegram-assistant',
  model: 'google/gemini-3.5-flash-lite',
  instructions: \`You are a helpful personal assistant on Telegram.
Use the datetime tool for anything about the current date or time and the calculator for math.
Keep responses short — this is a chat, not an essay.\`,
  tools: [datetime, calculator],
});

const cogitator = new Cogitator({ llm: { providers: { google: { apiKey } } } });

const middleware = [rateLimit({ maxPerMinute: 15 })];
if (ownerId) {
  middleware.unshift(
    ownerCommands({
      ownerIds: { telegram: ownerId },
      onStatus: () => \`Uptime: \${Math.round(gateway.stats.uptime / 1000)}s, messages today: \${gateway.stats.messagesToday}\`,
    })
  );
}

const gateway = new Gateway({
  agent,
  cogitator,
  channels: [telegramChannel({ token })],
  middleware,
  stream: { flushInterval: 600, minChunkSize: 30 },
  onError: (error, message) => console.error(\`Message from \${message.userId} failed:\`, error.message),
});

await gateway.start();
console.log('Telegram assistant is running. Press Ctrl+C to stop.');

process.on('SIGINT', async () => {
  await gateway.stop();
  await cogitator.close();
  process.exit(0);
});`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/channels grammy',
      env: ['TG_TOKEN', 'GOOGLE_API_KEY', 'OWNER_TG_ID (optional)'],
      run: 'TG_TOKEN=your-key GOOGLE_API_KEY=your-key npx tsx telegram-bot.ts',
      repoRun: 'npx tsx examples/channels/01-telegram-assistant.ts',
      example: 'channels/01-telegram-assistant.ts',
      docs: [
        {
          href: '/docs/channels/telegram',
          label: 'Telegram',
        },
      ],
    },
    {
      id: 'webchat-bot',
      title: 'WebChat Bot',
      difficulty: 'easy',
      time: '10 min',
      problem: 'Your own web page should chat with the agent over a WebSocket, behind a token.',
      points: ['Serve `webchatChannel()` with an `auth` check'],
      file: 'webchat-bot.ts',
      code: `import { Agent, Cogitator, datetime } from '@cogitator-ai/core';
import { Gateway, webchatChannel } from '@cogitator-ai/channels';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

const webchatToken = process.env.WEBCHAT_TOKEN ?? 'dev-token';
const port = Number(process.env.WEBCHAT_PORT ?? 3100);

const agent = new Agent({
  name: 'webchat-assistant',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are a helpful assistant connected via WebChat. Keep responses concise.',
  tools: [datetime],
});

const cogitator = new Cogitator({ llm: { providers: { google: { apiKey } } } });

const gateway = new Gateway({
  agent,
  cogitator,
  channels: [webchatChannel({ port, auth: (token) => token === webchatToken })],
  stream: { flushInterval: 500, minChunkSize: 20 },
  onError: (error, message) => console.error(\`Message from \${message.userId} failed:\`, error.message),
});

await gateway.start();
console.log(\`WebChat on ws://localhost:\${port}/ws?token=\${webchatToken}\`);

process.on('SIGINT', async () => {
  await gateway.stop();
  await cogitator.close();
  process.exit(0);
});`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/channels ws',
      env: ['GOOGLE_API_KEY', 'WEBCHAT_TOKEN (optional)'],
      run: 'GOOGLE_API_KEY=your-key npx tsx webchat-bot.ts',
      repoRun: 'npx tsx examples/channels/03-webchat-bot.ts',
      extra: [
        {
          title: 'Try it',
          language: 'bash',
          code: `npx wscat -c "ws://localhost:3100/ws?token=dev-token"`,
        },
      ],
      notes: [
        {
          type: 'tip',
          text: 'The repo has a ready browser client: open `examples/channels/webchat-client.html`.',
        },
      ],
      example: 'channels/03-webchat-bot.ts',
      docs: [
        {
          href: '/docs/channels/webchat',
          label: 'WebChat',
        },
      ],
    },
    {
      id: 'super-assistant',
      title: 'Personal Assistant from Config',
      difficulty: 'medium',
      time: '15 min',
      problem:
        'You want a personal assistant with memory, web search and a scheduler, reachable from the terminal and Telegram — configured, not coded.',
      points: [
        'Validate a config with `AssistantConfigSchema`',
        'Build the runtime, gateway and tools with `RuntimeBuilder`',
      ],
      file: 'super-assistant.ts',
      code: `import { AssistantConfigSchema, RuntimeBuilder } from '@cogitator-ai/channels';

const ownerId = process.env.OWNER_TG_ID;

const config = AssistantConfigSchema.parse({
  name: 'jarvis',
  personality: \`You are Jarvis, a personal AI assistant.
Be concise, friendly and proactive. Remember important things using memory tools.\`,
  llm: { provider: 'google', model: 'google/gemini-3.5-flash-lite' },
  channels: process.env.TG_TOKEN ? { telegram: { ownerIds: ownerId ? [ownerId] : [] } } : {},
  capabilities: { webSearch: true, scheduler: true },
  memory: {
    adapter: 'sqlite',
    path: '~/.cogitator/memory.db',
    knowledgeGraph: true,
    autoExtract: true,
    compaction: { threshold: 50 },
  },
  security: { dmPolicy: ownerId ? 'pairing' : 'open' },
});

const runtime = await new RuntimeBuilder(config, process.env).build();
await runtime.gateway.start();
console.log(\`\${config.name} is running — chat in the terminal, or on Telegram if TG_TOKEN is set.\`);

process.on('SIGINT', async () => {
  await runtime.cleanup();
  process.exit(0);
});`,
      install: 'pnpm add @cogitator-ai/channels grammy better-sqlite3',
      env: ['GOOGLE_API_KEY', 'TG_TOKEN (optional)', 'OWNER_TG_ID (optional)'],
      run: 'GOOGLE_API_KEY=your-key npx tsx super-assistant.ts',
      repoRun: 'npx tsx examples/channels/02-super-assistant.ts',
      notes: [
        {
          type: 'tip',
          text: 'The same config as YAML is `examples/channels/cogitator.yml`; `cogitator wizard` writes one and `cogitator up` runs it.',
        },
      ],
      example: 'channels/02-super-assistant.ts',
      docs: [
        {
          href: '/docs/channels/gateway',
          label: 'Gateway',
        },
        {
          href: '/docs/channels/wizard',
          label: 'Wizard',
        },
      ],
    },
  ],
};
