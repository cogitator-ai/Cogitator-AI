import type { Section } from './types';

export const channels: Section = {
  id: 'channels',
  title: 'Messaging Channels',
  icon: '💬',
  description:
    'Put an agent on Telegram, a WebChat socket, GitHub issues and reviews or an email inbox, or build a full personal assistant from a config object.',
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
    {
      id: 'social-feeds',
      title: 'Publish to Bluesky and Threads',
      difficulty: 'medium',
      time: '15 min',
      problem:
        'You want to post the same announcement to Bluesky and Threads, now or on a schedule, without posting it twice after a crash and without renewing tokens by hand.',
      points: [
        'One `FeedPublisher` sends a post to every feed and tracks each delivery on its own',
        'Text longer than a feed takes is cut at a word for that feed: 300 graphemes on Bluesky, 500 characters on Threads',
        'The same `key` publishes once, and `publishAt` schedules a post in a store that survives restarts',
        'A post quotes another with `quote`: its id belongs to one feed, so the quote goes to that feed only',
        'The Bluesky session and the Threads token live in a `TokenStore`, and the Threads token renews itself before it expires',
      ],
      file: 'social-publisher.ts',
      code: `import { BlueskyFeed, FeedPublisher, FilePublishStore, FileTokenStore, ThreadsFeed } from '@cogitator-ai/channels';

const tokens = new FileTokenStore();

const publisher = new FeedPublisher({
  feeds: [
    new BlueskyFeed({
      identifier: process.env.BLUESKY_HANDLE!,
      appPassword: process.env.BLUESKY_APP_PASSWORD!,
      store: tokens,
    }),
    new ThreadsFeed({ accessToken: process.env.THREADS_ACCESS_TOKEN!, store: tokens }),
  ],
  store: new FilePublishStore(),
  dryRun: process.env.PUBLISH !== '1',
  onPublished: ({ feed, post }) => console.log(\`\${feed}: \${post.url || post.id}\`),
  onFailed: ({ feed, error, final }) =>
    console.log(\`\${feed}: \${final ? 'failed' : 'will retry'}: \${error.message}\`),
});

const today = new Date().toISOString().slice(0, 10);

const { job, duplicate } = await publisher.publish(
  {
    text: 'Open models now run on an ordinary laptop. What changed, and what it means for you:',
    link: { url: 'https://example.com/story', title: 'Open models on laptops' },
    tags: ['AI'],
    langs: ['en'],
  },
  { key: \`story-\${today}\` }
);
console.log(duplicate ? 'Already published today' : \`Job \${job.id}\`);

for (const delivery of job.deliveries) {
  if (!delivery.post) continue;
  await publisher.publish(
    { text: 'In case you missed it:', quote: delivery.post.id },
    { feeds: [delivery.feed], key: \`quote-\${delivery.feed}-\${today}\` }
  );
}

await publisher.publish(
  { text: 'Good morning! Three things worth reading today:', link: { url: 'https://example.com/brief' } },
  { publishAt: Date.now() + 60_000, key: \`brief-\${today}\` }
);

publisher.start();

process.on('SIGINT', async () => {
  await publisher.stop();
  process.exit(0);
});`,
      install: 'pnpm add @cogitator-ai/channels @atproto/api',
      env: [
        'BLUESKY_HANDLE',
        'BLUESKY_APP_PASSWORD',
        'THREADS_ACCESS_TOKEN',
        'PUBLISH (optional, 1 posts for real)',
      ],
      run: 'npx tsx social-publisher.ts',
      repoRun: 'npx tsx examples/channels/04-social-publisher.ts',
      notes: [
        {
          type: 'tip',
          text: 'Bluesky bots sign in with an app password from Settings, Privacy and security, App passwords. Threads needs a long-lived token, which lasts 60 days and is renewed from then on.',
        },
        {
          type: 'info',
          text: 'Rate limits, a used Threads quota and a feed that is down are retried with backoff. Several workers can share jobs and tokens through `PostgresPublishStore` and `PostgresTokenStore`.',
        },
      ],
      example: 'channels/04-social-publisher.ts',
      docs: [
        {
          href: '/docs/channels/feeds',
          label: 'Social Feeds',
        },
        {
          href: '/docs/channels/bluesky',
          label: 'Bluesky',
        },
        {
          href: '/docs/channels/threads',
          label: 'Threads',
        },
      ],
    },
    {
      id: 'github-bot',
      title: 'GitHub Issue and Review Bot',
      difficulty: 'medium',
      time: '15 min',
      problem:
        'You want an agent that answers when people mention it in issues, pull requests and code reviews, in the same place they asked.',
      points: [
        'Run a `Gateway` with `githubChannel()` on a webhook server of its own',
        'Every issue and pull request is a conversation, and every review thread one of its own, answered with a reply in it',
        'Deliveries are checked against the webhook secret and handled once, even when GitHub sends one again',
        'Only the repository owner, members and collaborators reach the agent by default (`associations`, `authors`), since what people write steers it',
        "The bot answers mentions of `@login` (or every event with `trigger: 'all'`), skips its own comments and other bots",
      ],
      file: 'github-bot.ts',
      code: `import { Agent, Cogitator } from '@cogitator-ai/core';
import { Gateway, githubChannel } from '@cogitator-ai/channels';

const token = process.env.GITHUB_CHANNEL_TOKEN;
const secret = process.env.GITHUB_WEBHOOK_SECRET;
const apiKey = process.env.GOOGLE_API_KEY;
if (!token || !secret || !apiKey) {
  throw new Error('Set GITHUB_CHANNEL_TOKEN, GITHUB_WEBHOOK_SECRET and GOOGLE_API_KEY');
}

const github = githubChannel({
  token,
  webhook: { secret, port: 8787 },
  repositories: ['acme/*'],
});

const agent = new Agent({
  name: 'github-assistant',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You help maintainers on GitHub. Be precise and brief, and use GitHub Markdown.',
});

const cogitator = new Cogitator({
  llm: { providers: { google: { apiKey } } },
  memory: { adapter: 'memory' },
});
const memory = await cogitator.getMemory();

const gateway = new Gateway({
  agent,
  cogitator,
  channels: [github],
  ...(memory && { memory }),
  reactions: { enabled: true },
});

await gateway.start();
console.log(\`@\${github.login} is listening on http://localhost:8787/github/webhook\`);`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/channels',
      env: ['GITHUB_CHANNEL_TOKEN', 'GITHUB_WEBHOOK_SECRET', 'GOOGLE_API_KEY'],
      run: 'npx tsx github-bot.ts',
      repoRun: 'npx tsx examples/channels/06-github-bot.ts',
      notes: [
        {
          type: 'tip',
          text: 'Add the webhook in the repository settings with content type `application/json` and the events Issues, Issue comments, Pull requests, Pull request reviews and Pull request review comments. A tunnel to port 8787 is enough to try it.',
        },
        {
          type: 'warning',
          text: 'Give the bot an account of its own and a fine-grained token scoped to the repositories it answers in. With your own token it posts as you and takes your comments for its own, and a classic `repo` token reaches every private repository you have.',
        },
        {
          type: 'info',
          text: 'A GitHub App installation token works too: pass a function that returns a fresh one as `token`, and set `login` to `<app-slug>[bot]`, since such a token cannot read its own user.',
        },
      ],
      example: 'channels/06-github-bot.ts',
      docs: [
        {
          href: '/docs/channels/github',
          label: 'GitHub',
        },
        {
          href: '/docs/channels/gateway',
          label: 'Gateway',
        },
      ],
    },
    {
      id: 'email-bot',
      title: 'Email Bot That Answers in the Thread',
      difficulty: 'medium',
      time: '15 min',
      problem:
        'You want an agent that answers mail sent to a mailbox, as a reply in the same thread, without answering spoofed senders or auto-replies.',
      points: [
        'Run a `Gateway` with `emailChannel()`: IMAP with IDLE reads new mail, SMTP sends the answers',
        'Answers keep the thread: `Re:` subject, `In-Reply-To` and `References`, and every email thread is a conversation of its own',
        'The agent reads the new text only, without quoted history and signatures, as HTML rendered from its Markdown goes out',
        'Only `allowFrom` reaches the agent, and mail whose DKIM, SPF or DMARC results fail for the sender domain is dropped',
        'Auto-replies, bounces, bulk mail and its own mail are skipped, so it never loops with another bot',
      ],
      file: 'email-bot.ts',
      code: `import { Agent, Cogitator } from '@cogitator-ai/core';
import { Gateway, emailChannel } from '@cogitator-ai/channels';

const address = process.env.EMAIL_ADDRESS;
const password = process.env.EMAIL_PASSWORD;
const apiKey = process.env.GOOGLE_API_KEY;
if (!address || !password || !apiKey) {
  throw new Error('Set EMAIL_ADDRESS, EMAIL_PASSWORD and GOOGLE_API_KEY');
}

const email = emailChannel({
  address,
  name: 'Acme Assistant',
  allowFrom: ['acme.com'],
  imap: { host: 'imap.gmail.com', auth: { user: address, pass: password } },
  smtp: { host: 'smtp.gmail.com', port: 587, auth: { user: address, pass: password } },
});

const agent = new Agent({
  name: 'email-assistant',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You answer email for the Acme team. Be friendly and brief.',
});

const cogitator = new Cogitator({
  llm: { providers: { google: { apiKey } } },
  memory: { adapter: 'memory' },
});
const memory = await cogitator.getMemory();

const gateway = new Gateway({
  agent,
  cogitator,
  channels: [email],
  ...(memory && { memory }),
});

await gateway.start();
console.log(\`\${address} answers mail from acme.com\`);`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/channels imapflow postal-mime nodemailer',
      env: ['EMAIL_ADDRESS', 'EMAIL_PASSWORD', 'GOOGLE_API_KEY'],
      run: 'npx tsx email-bot.ts',
      repoRun: 'npx tsx examples/channels/07-email-bot.ts',
      notes: [
        {
          type: 'tip',
          text: 'Give the bot a mailbox of its own: it reads every unread mail there and marks it read. For Gmail turn on 2-step verification and use an app password.',
        },
        {
          type: 'warning',
          text: 'A `From` address is easy to forge. Keep `allowFrom` short, leave `senderAuth` on, and give the agent no tool a stranger must not reach.',
        },
        {
          type: 'info',
          text: "Mailgun, Postmark and SendGrid can post inbound mail instead: `webhook: { provider: 'mailgun', signingKey, port: 8788 }`. Their DKIM and SPF results are checked for the sender domain.",
        },
      ],
      example: 'channels/07-email-bot.ts',
      docs: [
        {
          href: '/docs/channels/email',
          label: 'Email',
        },
        {
          href: '/docs/channels/gateway',
          label: 'Gateway',
        },
      ],
    },
  ],
};
