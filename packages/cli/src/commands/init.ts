import { Command } from 'commander';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { printBanner } from '../utils/logger.js';
import { formatEnvLine } from '../utils/env.js';
import { DEFAULT_OLLAMA_URL, resolveOllamaUrl } from '../utils/ollama.js';
import {
  API_KEY_ENV,
  fetchOllamaModelOptions,
  fetchProviderModels,
  isSetupProvider,
  type SetupProvider,
} from '../utils/provider-models.js';

export type InitChannel = 'telegram' | 'discord' | 'slack' | 'webchat';
export type InitMemory = 'memory' | 'sqlite' | 'postgres';
export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

export interface InitAnswers {
  projectName: string;
  provider: SetupProvider;
  apiKey: string;
  model: string;
  channels: InitChannel[];
  telegramToken?: string;
  discordToken?: string;
  slackToken?: string;
  slackSigningSecret?: string;
  slackAppToken?: string;
  memory: InitMemory;
  databaseUrl?: string;
}

export interface ScaffoldOptions {
  dependencyVersions: Record<string, string>;
  /** When `pnpm`, a pnpm-workspace.yaml allowing the native dependency builds is generated */
  packageManager?: PackageManager;
  /** `name@version` written to the `packageManager` field, e.g. `pnpm@10.26.0` */
  packageManagerSpec?: string;
}

/** Port the WebChat channel listens on. */
export const WEBCHAT_PORT = 18789;

/**
 * pnpm 10.26+ skips dependency build scripts unless they are allowed, and pnpm 11 fails the
 * install instead. These are the native/binary packages a Cogitator project pulls in.
 */
export const PNPM_ALLOWED_BUILDS = ['better-sqlite3', 'esbuild', 'sharp'] as const;

export const DEFAULT_POSTGRES_URL = 'postgresql://cogitator:cogitator@localhost:5432/cogitator';
const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const COGITATOR_PACKAGES = ['@cogitator-ai/core', '@cogitator-ai/channels', '@cogitator-ai/memory'];

export function validateProjectName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return 'Name is required';
  if (trimmed.length > 214) return 'Name must be 214 characters or fewer';
  if (!PROJECT_NAME.test(trimmed)) {
    return 'Use lowercase letters, digits, ".", "_" or "-" (must start with a letter or digit)';
  }
  return undefined;
}

export function resolveDependencyVersions(
  cliPackageJson: string = join(dirname(fileURLToPath(import.meta.url)), '../../package.json')
): Record<string, string> {
  const versions: Record<string, string> = {};
  let deps: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(cliPackageJson, 'utf-8'));
    if (typeof parsed === 'object' && parsed !== null && 'dependencies' in parsed) {
      const value = parsed.dependencies;
      if (typeof value === 'object' && value !== null)
        deps = Object.fromEntries(Object.entries(value));
    }
  } catch {
    deps = {};
  }

  for (const name of COGITATOR_PACKAGES) {
    const range = deps[name];
    versions[name] =
      typeof range === 'string' && /^\^?~?\d/.test(range)
        ? `^${range.replace(/^[\^~]/, '')}`
        : 'latest';
  }
  return versions;
}

export function detectPackageManager(
  userAgent = process.env.npm_config_user_agent
): PackageManager {
  const name = userAgent?.split('/')[0];
  if (name === 'npm' || name === 'yarn' || name === 'bun' || name === 'pnpm') return name;
  return 'pnpm';
}

/**
 * The `packageManager` field for the pnpm, Yarn or Bun that runs the
 * scaffolder, e.g. `pnpm@10.26.0`, so corepack and the deploy image install
 * with the same version instead of the latest one. Undefined for npm, which
 * corepack leaves alone, and when the version is unknown.
 */
export function detectPackageManagerSpec(
  userAgent = process.env.npm_config_user_agent
): string | undefined {
  const match = /^(pnpm|yarn|bun)\/(\d+\.\d+\.\d+[^\s]*)/.exec(userAgent?.trim() ?? '');
  return match ? `${match[1]}@${match[2]}` : undefined;
}

function runScript(pm: PackageManager, script: string): string {
  return pm === 'npm' ? `npm run ${script}` : `${pm} ${script}`;
}

export function buildPackageJson(answers: InitAnswers, options: ScaffoldOptions): string {
  const deps: Record<string, string> = {
    ...options.dependencyVersions,
    zod: '^4.0.0',
  };

  if (answers.channels.includes('telegram')) deps.grammy = '^1.20.0';
  if (answers.channels.includes('discord')) deps['discord.js'] = '^14.0.0';
  if (answers.channels.includes('slack')) deps['@slack/bolt'] = '^4.0.0';
  if (answers.channels.includes('webchat')) deps.ws = '^8.18.0';
  if (answers.memory === 'sqlite') deps['better-sqlite3'] = '^11.6.0';
  if (answers.memory === 'postgres') deps.pg = '^8.18.0';

  const sortedDeps = Object.fromEntries(
    Object.entries(deps).sort(([a], [b]) => a.localeCompare(b))
  );

  return (
    JSON.stringify(
      {
        name: answers.projectName,
        version: '0.1.0',
        private: true,
        type: 'module',
        ...(options.packageManagerSpec ? { packageManager: options.packageManagerSpec } : {}),
        engines: { node: '>=22.12.0' },
        scripts: {
          dev: 'tsx watch src/agent.ts',
          start: 'tsx src/agent.ts',
          build: 'tsc',
        },
        dependencies: sortedDeps,
        devDependencies: {
          '@types/node': '^22.0.0',
          tsx: '^4.21.0',
          typescript: '^5.3.0',
        },
      },
      null,
      2
    ) + '\n'
  );
}

export function buildEnvFile(answers: InitAnswers): string | null {
  const lines: string[] = [];

  if (answers.provider !== 'ollama' && answers.apiKey) {
    lines.push(formatEnvLine(API_KEY_ENV[answers.provider], answers.apiKey));
  }
  if (answers.telegramToken) lines.push(formatEnvLine('TELEGRAM_BOT_TOKEN', answers.telegramToken));
  if (answers.discordToken) lines.push(formatEnvLine('DISCORD_BOT_TOKEN', answers.discordToken));
  if (answers.slackToken) lines.push(formatEnvLine('SLACK_BOT_TOKEN', answers.slackToken));
  if (answers.slackSigningSecret) {
    lines.push(formatEnvLine('SLACK_SIGNING_SECRET', answers.slackSigningSecret));
  }
  if (answers.slackAppToken) lines.push(formatEnvLine('SLACK_APP_TOKEN', answers.slackAppToken));
  if (answers.memory === 'postgres') {
    lines.push(formatEnvLine('DATABASE_URL', answers.databaseUrl ?? DEFAULT_POSTGRES_URL));
  }

  return lines.length > 0 ? lines.join('\n') + '\n' : null;
}

function memorySetup(memory: InitMemory): { importName: string; code: string } {
  switch (memory) {
    case 'sqlite':
      return {
        importName: 'SQLiteAdapter',
        code: `mkdirSync('./data', { recursive: true });
const memory = new SQLiteAdapter({ provider: 'sqlite', path: './data/memory.db' });`,
      };
    case 'postgres':
      return {
        importName: 'PostgresAdapter',
        code: `const memory = new PostgresAdapter({
  provider: 'postgres',
  connectionString: requireEnv('DATABASE_URL'),
});`,
      };
    case 'memory':
      return {
        importName: 'InMemoryAdapter',
        code: `const memory = new InMemoryAdapter({ provider: 'memory' });`,
      };
  }
}

export function buildGatewayFile(answers: InitAnswers): string {
  const channelImports: string[] = [];
  const channelSetup: string[] = [];

  for (const ch of answers.channels) {
    switch (ch) {
      case 'telegram':
        channelImports.push('telegramChannel');
        channelSetup.push(`    telegramChannel({ token: requireEnv('TELEGRAM_BOT_TOKEN') }),`);
        break;
      case 'discord':
        channelImports.push('discordChannel');
        channelSetup.push(
          `    discordChannel({ token: requireEnv('DISCORD_BOT_TOKEN'), mentionOnly: true }),`
        );
        break;
      case 'slack':
        channelImports.push('slackChannel');
        channelSetup.push(
          `    slackChannel({\n      token: requireEnv('SLACK_BOT_TOKEN'),\n      signingSecret: requireEnv('SLACK_SIGNING_SECRET'),\n      appToken: process.env.SLACK_APP_TOKEN,\n    }),`
        );
        break;
      case 'webchat':
        channelImports.push('webchatChannel');
        channelSetup.push(`    webchatChannel({ port: ${WEBCHAT_PORT} }),`);
        break;
    }
  }

  const providerConfig =
    answers.provider === 'ollama'
      ? `      ollama: { baseUrl: process.env.OLLAMA_URL ?? '${DEFAULT_OLLAMA_URL}' },`
      : `      ${answers.provider}: { apiKey: requireEnv('${API_KEY_ENV[answers.provider]}') },`;

  const memory = memorySetup(answers.memory);

  const fsImports = answers.memory === 'sqlite' ? 'existsSync, mkdirSync' : 'existsSync';

  return `import { ${fsImports} } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Cogitator, Agent } from '@cogitator-ai/core';
import { Gateway, ${channelImports.join(', ')} } from '@cogitator-ai/channels';
import { ${memory.importName} } from '@cogitator-ai/memory';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(\`Missing environment variable \${name} (see .env)\`);
  return value;
}

const agent = new Agent({
  name: 'assistant',
  model: '${answers.model}',
  instructions: \`You are a helpful personal AI assistant.
Be concise and friendly. Use tools when available.\`,
});

const cogitator = new Cogitator({
  llm: {
    defaultProvider: '${answers.provider}',
    providers: {
${providerConfig}
    },
  },
});

${memory.code}

const connected = await memory.connect();
if (!connected.success) {
  throw new Error(\`Failed to connect memory: \${connected.error}\`);
}

export const gateway = new Gateway({
  agent,
  cogitator,
  channels: [
${channelSetup.join('\n')}
  ],
  memory,
  session: {
    compaction: { strategy: 'hybrid', messageThreshold: 50, keepRecent: 10 },
  },
  stream: { flushInterval: 500, minChunkSize: 20 },
  onError: (err, msg) => {
    console.error(\`[error] \${msg.channelType}:\${msg.userId} — \${err.message}\`);
  },
});
`;
}

export function buildAgentFile(answers: InitAnswers): string {
  const webchatLine = answers.channels.includes('webchat')
    ? `  console.log('WebChat: ws://localhost:${WEBCHAT_PORT}/ws');\n`
    : '';

  return `import { gateway } from './gateway.js';

let stopping = false;

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(\`\\nReceived \${signal}, shutting down...\`);
  await gateway.stop();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await gateway.start();

console.log('Assistant is running!');
console.log('Connected channels:', gateway.stats.connectedChannels.join(', '));
${webchatLine}`;
}

export function buildGitignore(answers: InitAnswers): string {
  const lines = ['node_modules/', 'dist/', '.env', '*.log', '.cogitator/'];
  if (answers.memory === 'sqlite') lines.push('data/');
  return lines.join('\n') + '\n';
}

/** Variables the generated gateway reads, in the order it reads them. */
function channelSecrets(answers: InitAnswers): string[] {
  const secrets: string[] = [];
  if (answers.channels.includes('telegram')) secrets.push('TELEGRAM_BOT_TOKEN');
  if (answers.channels.includes('discord')) secrets.push('DISCORD_BOT_TOKEN');
  if (answers.channels.includes('slack')) {
    secrets.push('SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET');
    if (answers.slackAppToken) secrets.push('SLACK_APP_TOKEN');
  }
  return secrets;
}

function memoryYml(memory: InitMemory): string[] {
  switch (memory) {
    case 'sqlite':
      return ['memory:', '  adapter: sqlite', '  sqlite:', '    path: ./data/memory.db'];
    case 'postgres':
      return [
        'memory:',
        '  adapter: postgres',
        '  postgres:',
        '    connectionString: ${DATABASE_URL}',
      ];
    case 'memory':
      return ['memory:', '  adapter: memory'];
  }
}

/**
 * `cogitator.yml` in the shape `@cogitator-ai/config` loads, read by
 * `cogitator run` and `cogitator deploy`: the provider and model, the memory
 * the gateway uses, and how the project deploys. It runs as a worker (the
 * gateway serves no HTTP health check), publishes the WebChat port, keeps
 * the SQLite database on a volume and needs the API key and channel tokens.
 */
export function buildCogitatorYml(answers: InitAnswers): string {
  const secrets = [
    ...(answers.provider === 'ollama' ? [] : [API_KEY_ENV[answers.provider]]),
    ...channelSecrets(answers),
  ];
  const lines = [
    '# Read by `cogitator run` and `cogitator deploy`. src/gateway.ts configures the',
    '# assistant itself, so change the provider, model or memory in both places.',
    '',
    'llm:',
    `  defaultProvider: ${answers.provider}`,
    `  defaultModel: ${JSON.stringify(answers.model)}`,
    ...(answers.provider === 'ollama'
      ? ['  providers:', '    ollama:', `      baseUrl: \${OLLAMA_URL:-${DEFAULT_OLLAMA_URL}}`]
      : []),
    '',
    ...memoryYml(answers.memory),
    '',
    'deploy:',
    '  kind: worker',
    ...(answers.channels.includes('webchat') ? [`  port: ${WEBCHAT_PORT}`] : []),
    ...(secrets.length > 0
      ? ['  secrets:', ...secrets.map((name) => `    - ${name}`)]
      : ['  secrets: []']),
    '',
  ];
  return lines.join('\n');
}

export const TSCONFIG = {
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
};

export function buildProjectFiles(
  answers: InitAnswers,
  options: ScaffoldOptions
): Record<string, string> {
  const files: Record<string, string> = {
    'package.json': buildPackageJson(answers, options),
    'tsconfig.json': JSON.stringify(TSCONFIG, null, 2) + '\n',
    'src/gateway.ts': buildGatewayFile(answers),
    'src/agent.ts': buildAgentFile(answers),
    'cogitator.yml': buildCogitatorYml(answers),
    '.gitignore': buildGitignore(answers),
  };
  const env = buildEnvFile(answers);
  if (env) files['.env'] = env;
  if (options.packageManager === 'pnpm') {
    files['pnpm-workspace.yaml'] = [
      'allowBuilds:',
      ...PNPM_ALLOWED_BUILDS.map((name) => `  ${name}: true`),
      '',
    ].join('\n');
  }
  return files;
}

export function writeProjectFiles(projectPath: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(projectPath, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, relativePath === '.env' ? { mode: 0o600 } : undefined);
  }
}

function cancelled(): never {
  p.cancel('Setup cancelled');
  process.exit(0);
}

function answer<T>(result: T | typeof p.CANCEL_SYMBOL): T {
  if (p.isCancel(result)) cancelled();
  return result;
}

async function askSecret(message: string, emptyMessage: string): Promise<string> {
  return answer(
    await p.password({ message, validate: (v) => (!v?.trim() ? emptyMessage : undefined) })
  ).trim();
}

async function collectAnswers(nameArg?: string): Promise<InitAnswers> {
  const projectName =
    nameArg ??
    answer(
      await p.text({
        message: 'Project name',
        placeholder: 'my-assistant',
        validate: (v) => validateProjectName(v ?? ''),
      })
    ).trim();

  const providerChoice = answer(
    await p.select({
      message: 'Which LLM provider?',
      options: [
        { value: 'anthropic', label: 'Anthropic (Claude)', hint: 'recommended' },
        { value: 'openai', label: 'OpenAI (GPT)' },
        { value: 'google', label: 'Google (Gemini)' },
        { value: 'ollama', label: 'Ollama (local, free)', hint: 'no API key needed' },
      ],
    })
  );
  if (!isSetupProvider(providerChoice)) cancelled();
  const provider: SetupProvider = providerChoice;

  const apiKey =
    provider === 'ollama'
      ? ''
      : await askSecret(`${API_KEY_ENV[provider]}:`, 'API key is required');

  const spinner = p.spinner();
  spinner.start('Fetching available models...');
  const modelOptions =
    provider === 'ollama'
      ? await fetchOllamaModelOptions(resolveOllamaUrl(), process.env.OLLAMA_API_KEY)
      : await fetchProviderModels(provider);
  spinner.stop(`Found ${modelOptions.length} models`);

  const model = answer(await p.select({ message: 'Default model', options: modelOptions }));

  const channelChoice = answer(
    await p.multiselect({
      message: 'Which channels to connect?',
      options: [
        { value: 'telegram', label: 'Telegram' },
        { value: 'discord', label: 'Discord' },
        { value: 'slack', label: 'Slack' },
        { value: 'webchat', label: 'WebChat (localhost)', hint: 'no setup needed' },
      ],
      required: false,
    })
  );
  const channels = channelChoice.filter(
    (c): c is InitChannel => c === 'telegram' || c === 'discord' || c === 'slack' || c === 'webchat'
  );

  const telegramToken = channels.includes('telegram')
    ? await askSecret('Telegram bot token (from @BotFather):', 'Token is required')
    : undefined;
  const discordToken = channels.includes('discord')
    ? await askSecret('Discord bot token:', 'Token is required')
    : undefined;
  const slackToken = channels.includes('slack')
    ? await askSecret('Slack bot token (xoxb-...):', 'Token is required')
    : undefined;
  const slackSigningSecret = channels.includes('slack')
    ? await askSecret('Slack signing secret:', 'Signing secret is required')
    : undefined;
  const slackAppToken = channels.includes('slack')
    ? answer(
        await p.password({
          message: 'Slack app token for Socket Mode (xapp-..., leave blank for HTTP mode):',
        })
      ).trim() || undefined
    : undefined;

  const memoryChoice = answer(
    await p.select({
      message: 'Memory adapter',
      options: [
        { value: 'sqlite', label: 'SQLite (recommended)', hint: 'zero config, file-based' },
        { value: 'memory', label: 'In-memory', hint: 'no persistence, for testing' },
        { value: 'postgres', label: 'PostgreSQL', hint: 'production-grade' },
      ],
    })
  );
  const memory: InitMemory =
    memoryChoice === 'memory' || memoryChoice === 'postgres' ? memoryChoice : 'sqlite';

  const databaseUrl =
    memory === 'postgres'
      ? answer(
          await p.text({
            message: 'PostgreSQL connection string',
            initialValue: DEFAULT_POSTGRES_URL,
            validate: (v) =>
              !/^postgres(ql)?:\/\//.test(v?.trim() ?? '') ? 'Expected postgres://...' : undefined,
          })
        ).trim()
      : undefined;

  return {
    projectName,
    provider,
    apiKey,
    model,
    channels: channels.length > 0 ? channels : ['webchat'],
    telegramToken,
    discordToken,
    slackToken,
    slackSigningSecret,
    slackAppToken,
    memory,
    databaseUrl,
  };
}

export const initCommand = new Command('init')
  .description('Create a new Cogitator AI assistant project')
  .argument('[name]', 'Project name')
  .option('--no-install', 'Skip dependency installation')
  .action(async (nameArg: string | undefined, options: { install: boolean }) => {
    printBanner();
    p.intro(chalk.bgCyan(chalk.black(' cogitator init ')));

    if (nameArg !== undefined) {
      const error = validateProjectName(nameArg);
      if (error) {
        p.cancel(`Invalid project name "${nameArg}": ${error}`);
        process.exit(1);
      }
    }

    const answers = await collectAnswers(nameArg?.trim());
    const projectPath = resolve(process.cwd(), answers.projectName);

    if (existsSync(projectPath)) {
      p.cancel(`Directory "${answers.projectName}" already exists`);
      process.exit(1);
    }

    const pm = detectPackageManager();
    const files = buildProjectFiles(answers, {
      dependencyVersions: resolveDependencyVersions(),
      packageManager: pm,
      packageManagerSpec: detectPackageManagerSpec(),
    });
    let installed = false;

    await p.tasks([
      {
        title: 'Creating project structure',
        task: () => {
          writeProjectFiles(projectPath, files);
          return 'Project files created';
        },
      },
      {
        title: `Installing dependencies with ${pm}`,
        enabled: options.install,
        task: () => {
          try {
            execFileSync(pm, ['install'], { cwd: projectPath, stdio: 'pipe' });
            installed = true;
            return 'Dependencies installed';
          } catch {
            return `Install failed — run "${pm} install" manually`;
          }
        },
      },
    ]);

    p.note(
      [
        `cd ${answers.projectName}`,
        installed ? '' : `${pm} install`,
        `${runScript(pm, 'dev')}        # start with hot reload`,
        `cogitator assistant   # or run with the live dashboard`,
      ]
        .filter(Boolean)
        .join('\n'),
      'Next steps',
      { format: (line) => chalk.dim(line) }
    );

    p.outro(
      `${chalk.green('Your assistant is ready!')} Channels: ${chalk.cyan(answers.channels.join(', '))}`
    );
  });
