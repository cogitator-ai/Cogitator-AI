import { Command } from 'commander';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { printBanner } from '../utils/logger.js';

interface InitAnswers {
  provider: string;
  apiKey: string;
  model: string;
  channels: string[];
  telegramToken?: string;
  discordToken?: string;
  slackToken?: string;
  slackSigningSecret?: string;
  memory: string;
  projectName: string;
}

const PROVIDER_MODELS: Record<string, { label: string; value: string }[]> = {
  anthropic: [
    { label: 'Claude Sonnet 4 (recommended)', value: 'anthropic/claude-sonnet-4-20250514' },
    { label: 'Claude Opus 4', value: 'anthropic/claude-opus-4-20250514' },
    { label: 'Claude Haiku 3.5', value: 'anthropic/claude-3-5-haiku-20241022' },
  ],
  openai: [
    { label: 'GPT-4o (recommended)', value: 'openai/gpt-4o' },
    { label: 'GPT-4o mini', value: 'openai/gpt-4o-mini' },
    { label: 'o3-mini', value: 'openai/o3-mini' },
  ],
  google: [
    { label: 'Gemini 2.5 Flash (recommended)', value: 'google/gemini-2.5-flash' },
    { label: 'Gemini 2.5 Pro', value: 'google/gemini-2.5-pro' },
  ],
  ollama: [
    { label: 'Llama 3.1 8B (recommended)', value: 'ollama/llama3.1:8b' },
    { label: 'Gemma 3 4B', value: 'ollama/gemma3:4b' },
    { label: 'Mistral 7B', value: 'ollama/mistral:7b' },
  ],
};

const API_KEY_NAMES: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
};

export const initCommand = new Command('init')
  .description('Create a new Cogitator AI assistant project')
  .argument('[name]', 'Project name')
  .option('--no-install', 'Skip dependency installation')
  .action(async (nameArg: string | undefined, options: { install: boolean }) => {
    printBanner();
    p.intro(chalk.bgCyan(chalk.black(' cogitator init ')));

    const answers = await collectAnswers(nameArg);
    if (!answers) return;

    const projectPath = resolve(process.cwd(), answers.projectName);

    if (existsSync(projectPath)) {
      p.cancel(`Directory "${answers.projectName}" already exists`);
      process.exit(1);
    }

    await p.tasks([
      {
        title: 'Creating project structure',
        task: () => {
          createProjectFiles(projectPath, answers);
          return 'Project files created';
        },
      },
      {
        title: 'Installing dependencies',
        enabled: options.install,
        task: () => {
          try {
            execSync('pnpm install', { cwd: projectPath, stdio: 'pipe' });
            return 'Dependencies installed';
          } catch {
            return 'Install failed — run pnpm install manually';
          }
        },
      },
    ]);

    const channelNames = answers.channels.join(', ') || 'webchat';
    p.note(
      [`cd ${answers.projectName}`, !options.install ? 'pnpm install' : '', 'cogitator up']
        .filter(Boolean)
        .join('\n'),
      'Next steps'
    );

    p.outro(`${chalk.green('Your assistant is ready!')} Channels: ${chalk.cyan(channelNames)}`);
  });

async function collectAnswers(nameArg?: string): Promise<InitAnswers | null> {
  const projectName =
    nameArg ??
    ((await p.text({
      message: 'Project name',
      placeholder: 'my-assistant',
      validate: (v) => (!v.trim() ? 'Name is required' : undefined),
    })) as string);

  if (p.isCancel(projectName)) {
    p.cancel('Setup cancelled');
    process.exit(0);
  }

  const provider = (await p.select({
    message: 'Which LLM provider?',
    options: [
      { value: 'anthropic', label: 'Anthropic (Claude)', hint: 'recommended' },
      { value: 'openai', label: 'OpenAI (GPT-4o)' },
      { value: 'google', label: 'Google (Gemini)' },
      { value: 'ollama', label: 'Ollama (local, free)', hint: 'no API key needed' },
    ],
  })) as string;

  if (p.isCancel(provider)) {
    p.cancel('Setup cancelled');
    process.exit(0);
  }

  let apiKey = '';
  if (provider !== 'ollama') {
    const keyResult = await p.password({
      message: `${API_KEY_NAMES[provider]}:`,
      validate: (v) => (!v.trim() ? 'API key is required' : undefined),
    });
    if (p.isCancel(keyResult)) {
      p.cancel('Setup cancelled');
      process.exit(0);
    }
    apiKey = keyResult as string;
  }

  const model = (await p.select({
    message: 'Default model',
    options: PROVIDER_MODELS[provider],
  })) as string;

  if (p.isCancel(model)) {
    p.cancel('Setup cancelled');
    process.exit(0);
  }

  const channels = (await p.multiselect({
    message: 'Which channels to connect?',
    options: [
      { value: 'telegram', label: 'Telegram' },
      { value: 'discord', label: 'Discord' },
      { value: 'slack', label: 'Slack' },
      { value: 'webchat', label: 'WebChat (localhost)', hint: 'no setup needed' },
    ],
    required: false,
  })) as string[];

  if (p.isCancel(channels)) {
    p.cancel('Setup cancelled');
    process.exit(0);
  }

  let telegramToken: string | undefined;
  let discordToken: string | undefined;
  let slackToken: string | undefined;
  let slackSigningSecret: string | undefined;

  if (channels.includes('telegram')) {
    const token = await p.password({
      message: 'Telegram bot token (from @BotFather):',
      validate: (v) => (!v.trim() ? 'Token is required' : undefined),
    });
    if (p.isCancel(token)) {
      p.cancel('Setup cancelled');
      process.exit(0);
    }
    telegramToken = token as string;
  }

  if (channels.includes('discord')) {
    const token = await p.password({
      message: 'Discord bot token:',
      validate: (v) => (!v.trim() ? 'Token is required' : undefined),
    });
    if (p.isCancel(token)) {
      p.cancel('Setup cancelled');
      process.exit(0);
    }
    discordToken = token as string;
  }

  if (channels.includes('slack')) {
    const token = await p.password({
      message: 'Slack bot token (xoxb-...):',
      validate: (v) => (!v.trim() ? 'Token is required' : undefined),
    });
    if (p.isCancel(token)) {
      p.cancel('Setup cancelled');
      process.exit(0);
    }
    slackToken = token as string;

    const secret = await p.password({
      message: 'Slack signing secret:',
      validate: (v) => (!v.trim() ? 'Signing secret is required' : undefined),
    });
    if (p.isCancel(secret)) {
      p.cancel('Setup cancelled');
      process.exit(0);
    }
    slackSigningSecret = secret as string;
  }

  const memory = (await p.select({
    message: 'Memory adapter',
    options: [
      { value: 'memory', label: 'In-memory (no persistence)', hint: 'simple, for testing' },
      { value: 'sqlite', label: 'SQLite (recommended)', hint: 'zero config, file-based' },
      { value: 'postgres', label: 'PostgreSQL', hint: 'production-grade' },
    ],
  })) as string;

  if (p.isCancel(memory)) {
    p.cancel('Setup cancelled');
    process.exit(0);
  }

  return {
    provider,
    apiKey,
    model,
    channels: channels.length > 0 ? channels : ['webchat'],
    telegramToken,
    discordToken,
    slackToken,
    slackSigningSecret,
    memory,
    projectName: projectName as string,
  };
}

function createProjectFiles(projectPath: string, answers: InitAnswers): void {
  mkdirSync(join(projectPath, 'src'), { recursive: true });

  const deps: Record<string, string> = {
    '@cogitator-ai/core': '^0.1.0',
    '@cogitator-ai/channels': '^0.1.0',
    '@cogitator-ai/memory': '^0.1.0',
    zod: '^3.22.4',
  };

  if (answers.channels.includes('telegram')) deps.grammy = '^1.20.0';
  if (answers.channels.includes('discord')) deps['discord.js'] = '^14.0.0';
  if (answers.channels.includes('slack')) deps['@slack/bolt'] = '^3.0.0';
  if (answers.channels.includes('webchat')) deps.ws = '^8.0.0';

  writeFileSync(
    join(projectPath, 'package.json'),
    JSON.stringify(
      {
        name: answers.projectName,
        version: '0.1.0',
        type: 'module',
        scripts: {
          dev: 'tsx watch src/agent.ts',
          start: 'tsx src/agent.ts',
          build: 'tsc',
        },
        dependencies: deps,
        devDependencies: {
          '@types/node': '^20.10.0',
          tsx: '^4.7.0',
          typescript: '^5.3.0',
        },
      },
      null,
      2
    )
  );

  writeFileSync(
    join(projectPath, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          outDir: './dist',
          rootDir: './src',
        },
        include: ['src/**/*'],
      },
      null,
      2
    )
  );

  writeEnvFile(projectPath, answers);
  writeConfigFile(projectPath, answers);
  writeAgentFile(projectPath, answers);

  writeFileSync(
    join(projectPath, '.gitignore'),
    `node_modules/
dist/
.env
*.log
sessions.db
`
  );
}

function writeEnvFile(projectPath: string, answers: InitAnswers): void {
  const lines: string[] = [];

  if (answers.apiKey && API_KEY_NAMES[answers.provider]) {
    lines.push(`${API_KEY_NAMES[answers.provider]}=${answers.apiKey}`);
  }
  if (answers.telegramToken) lines.push(`TELEGRAM_BOT_TOKEN=${answers.telegramToken}`);
  if (answers.discordToken) lines.push(`DISCORD_BOT_TOKEN=${answers.discordToken}`);
  if (answers.slackToken) lines.push(`SLACK_BOT_TOKEN=${answers.slackToken}`);
  if (answers.slackSigningSecret) lines.push(`SLACK_SIGNING_SECRET=${answers.slackSigningSecret}`);

  if (lines.length > 0) {
    writeFileSync(join(projectPath, '.env'), lines.join('\n') + '\n');
  }
}

function writeConfigFile(projectPath: string, answers: InitAnswers): void {
  const channelImports: string[] = [];
  const channelSetup: string[] = [];

  for (const ch of answers.channels) {
    switch (ch) {
      case 'telegram':
        channelImports.push('telegramChannel');
        channelSetup.push(`    telegramChannel({ token: process.env.TELEGRAM_BOT_TOKEN! }),`);
        break;
      case 'discord':
        channelImports.push('discordChannel');
        channelSetup.push(
          `    discordChannel({ token: process.env.DISCORD_BOT_TOKEN!, mentionOnly: true }),`
        );
        break;
      case 'slack':
        channelImports.push('slackChannel');
        channelSetup.push(
          `    slackChannel({\n      token: process.env.SLACK_BOT_TOKEN!,\n      signingSecret: process.env.SLACK_SIGNING_SECRET!,\n    }),`
        );
        break;
      case 'webchat':
        channelImports.push('webchatChannel');
        channelSetup.push(`    webchatChannel({ port: 18789 }),`);
        break;
    }
  }

  const providerConfig =
    answers.provider === 'ollama'
      ? `    ollama: { baseUrl: 'http://localhost:11434' },`
      : `    ${answers.provider}: { apiKey: process.env.${API_KEY_NAMES[answers.provider]} },`;

  const content = `import { Cogitator, Agent } from '@cogitator-ai/core';
import { Gateway, ${channelImports.join(', ')} } from '@cogitator-ai/channels';
import { InMemoryAdapter } from '@cogitator-ai/memory';

const agent = new Agent({
  name: 'assistant',
  model: '${answers.model}',
  instructions: \`You are a helpful personal AI assistant.
Be concise and friendly. Use tools when available.\`,
});

const cogitator = new Cogitator({
  llm: {
    providers: {
${providerConfig}
    },
  },
});

const memory = new InMemoryAdapter();

export const gateway = new Gateway({
  agent,
  cogitator,
  channels: [
${channelSetup.join('\n')}
  ],
  memory,
  session: {
    compaction: { strategy: 'hybrid', threshold: 50, keepRecent: 10 },
  },
  stream: { flushInterval: 500, minChunkSize: 20 },
  onError: (err, msg) => {
    console.error(\`[error] \${msg.channelType}:\${msg.userId} — \${err.message}\`);
  },
});
`;

  writeFileSync(join(projectPath, 'src', 'gateway.ts'), content);
}

function writeAgentFile(projectPath: string, answers: InitAnswers): void {
  const content = `import { gateway } from './gateway.js';

async function main() {
  await gateway.start();

  console.log('Assistant is running!');
  console.log('Connected channels:', gateway.stats.connectedChannels.join(', '));
${answers.channels.includes('webchat') ? `  console.log('WebChat: ws://localhost:18789/ws');\n` : ''}
  process.on('SIGINT', async () => {
    console.log('\\nShutting down...');
    await gateway.stop();
    process.exit(0);
  });
}

main().catch(console.error);
`;

  writeFileSync(join(projectPath, 'src', 'agent.ts'), content);
}
