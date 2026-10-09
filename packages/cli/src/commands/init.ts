import { Command } from 'commander';
import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import {
  detectPackageManager,
  detectPackageManagerSpec,
  firstRunNotice,
  installFailure,
  parseSpec,
  payloadFor,
  scaffold,
  sendTelemetry,
  telemetryDisabledReason,
  validateProjectName,
  type ProjectSpecInput,
  type ScaffoldLogger,
} from 'create-cogitator-app';
import { printBanner } from '../utils/logger.js';
import { errorMessage, EXIT, examplesHelp } from '../utils/cli.js';
import { resolveOllamaUrl } from '../utils/ollama.js';
import {
  API_KEY_ENV,
  fetchOllamaModelOptions,
  fetchProviderModels,
  isSetupProvider,
  type SetupProvider,
} from '../utils/provider-models.js';

export type InitChannel = 'telegram' | 'discord' | 'slack' | 'webchat' | 'bluesky' | 'threads';

const INIT_CHANNELS: readonly InitChannel[] = [
  'telegram',
  'discord',
  'slack',
  'webchat',
  'bluesky',
  'threads',
];
export type InitMemory = 'memory' | 'sqlite' | 'postgres';

export interface InitAnswers {
  projectName: string;
  provider: SetupProvider;
  apiKey: string;
  /** `provider/model`, as the model prompt offers it. */
  model: string;
  channels: InitChannel[];
  telegramToken?: string;
  discordToken?: string;
  slackToken?: string;
  slackSigningSecret?: string;
  slackAppToken?: string;
  blueskyHandle?: string;
  blueskyAppPassword?: string;
  threadsAccessToken?: string;
  memory: InitMemory;
  databaseUrl?: string;
}

export const DEFAULT_POSTGRES_URL = 'postgresql://cogitator:cogitator@localhost:5432/cogitator';

export { validateProjectName };

/**
 * The project `cogitator init` creates: the `channels` preset of
 * create-cogitator-app with the answers, so both commands generate the same
 * code from the same engine.
 */
export function initSpec(
  answers: InitAnswers,
  packageManager = detectPackageManager()
): ProjectSpecInput {
  const prefix = `${answers.provider}/`;
  return {
    name: answers.projectName,
    preset: 'channels',
    app: 'channels',
    channels: answers.channels,
    memory: answers.memory,
    features: [],
    provider: answers.provider,
    model: answers.model.startsWith(prefix) ? answers.model.slice(prefix.length) : answers.model,
    packageManager,
  };
}

/** What `cogitator init` writes to `.env`: the provider key, the channel tokens and a custom database URL. */
export function initSecrets(answers: InitAnswers): Record<string, string> {
  const secrets: Record<string, string> = {};
  if (answers.provider !== 'ollama' && answers.apiKey) {
    secrets[API_KEY_ENV[answers.provider]] = answers.apiKey;
  }
  if (answers.telegramToken) secrets.TELEGRAM_BOT_TOKEN = answers.telegramToken;
  if (answers.discordToken) secrets.DISCORD_BOT_TOKEN = answers.discordToken;
  if (answers.slackToken) secrets.SLACK_BOT_TOKEN = answers.slackToken;
  if (answers.slackSigningSecret) secrets.SLACK_SIGNING_SECRET = answers.slackSigningSecret;
  if (answers.slackAppToken) secrets.SLACK_APP_TOKEN = answers.slackAppToken;
  if (answers.blueskyHandle) secrets.BLUESKY_HANDLE = answers.blueskyHandle;
  if (answers.blueskyAppPassword) secrets.BLUESKY_APP_PASSWORD = answers.blueskyAppPassword;
  if (answers.threadsAccessToken) secrets.THREADS_ACCESS_TOKEN = answers.threadsAccessToken;
  if (
    answers.memory === 'postgres' &&
    answers.databaseUrl &&
    answers.databaseUrl !== DEFAULT_POSTGRES_URL
  ) {
    secrets.DATABASE_URL = answers.databaseUrl;
  }
  return secrets;
}

function cancelled(): never {
  p.cancel('Setup cancelled');
  process.exit(0);
}

function answer<T>(result: T): Exclude<T, symbol> {
  if (p.isCancel(result)) cancelled();
  return result as Exclude<T, symbol>;
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
        { value: 'bluesky', label: 'Bluesky', hint: 'mentions, replies and DMs' },
        { value: 'threads', label: 'Threads', hint: 'replies and mentions' },
      ],
      required: false,
    })
  );
  const channels = channelChoice.filter((c): c is InitChannel =>
    INIT_CHANNELS.some((channel) => channel === c)
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

  const blueskyHandle = channels.includes('bluesky')
    ? answer(
        await p.text({
          message: 'Bluesky handle of the bot account:',
          placeholder: 'yourbot.bsky.social',
          validate: (v) => (!v?.trim() ? 'Handle is required' : undefined),
        })
      ).trim()
    : undefined;
  const blueskyAppPassword = channels.includes('bluesky')
    ? await askSecret(
        'Bluesky app password (Settings, Privacy and security, App passwords; allow direct messages):',
        'App password is required'
      )
    : undefined;
  const threadsAccessToken = channels.includes('threads')
    ? await askSecret('Threads long-lived access token:', 'Token is required')
    : undefined;

  const memoryChoice = answer(
    await p.select({
      message: 'Memory adapter',
      options: [
        { value: 'sqlite', label: 'SQLite (recommended)', hint: 'zero config, file-based' },
        { value: 'memory', label: 'In-memory', hint: 'no persistence, for testing' },
        { value: 'postgres', label: 'PostgreSQL', hint: 'production-grade, runs in Docker' },
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
    blueskyHandle,
    blueskyAppPassword,
    threadsAccessToken,
    memory,
    databaseUrl,
  };
}

function clackLogger(): ScaffoldLogger {
  const spinner = p.spinner();
  return {
    start: (message) => spinner.start(message),
    done: (message) => spinner.stop(message),
    fail: (message) => spinner.error(message),
    warn: (message) => p.log.warn(message),
  };
}

export const initCommand = new Command('init')
  .description(
    'Create a messaging assistant project (Telegram, Discord, Slack, WebChat, Bluesky, Threads)'
  )
  .argument('[name]', 'Project name')
  .option('--no-install', 'Skip dependency installation')
  .option('--no-git', 'Skip creating a git repository')
  .option('--no-telemetry', 'Send no anonymous usage event')
  .addHelpText(
    'after',
    examplesHelp([
      ['cogitator init my-bot', 'a messaging assistant, asked step by step'],
      ['cogitator init my-bot --no-install', 'write the files, install later'],
    ])
  )
  .action(
    async (
      nameArg: string | undefined,
      options: { install: boolean; git: boolean; telemetry: boolean }
    ) => {
      printBanner();
      p.intro(chalk.bgCyan(chalk.black(' cogitator init ')));
      const telemetry = telemetryDisabledReason({ flag: options.telemetry }) === undefined;
      if (telemetry) {
        const notice = firstRunNotice();
        if (notice) p.log.info(chalk.dim(notice));
      }

      if (nameArg !== undefined) {
        const error = validateProjectName(nameArg);
        if (error) {
          p.cancel(`Invalid project name "${nameArg}": ${error}`);
          process.exitCode = EXIT.usage;
          return;
        }
      }

      const answers = await collectAnswers(nameArg?.trim());
      const directory = resolve(process.cwd(), answers.projectName);
      const spec = initSpec(answers);

      let result;
      try {
        result = await scaffold(spec, {
          directory,
          secrets: initSecrets(answers),
          packageManagerSpec: detectPackageManagerSpec(detectPackageManager()),
          install: options.install,
          git: options.git,
          log: clackLogger(),
        });
      } catch (error) {
        if (telemetry) await sendTelemetry(payloadFor(parseSpec(spec), { step: 'create', error }));
        p.cancel(errorMessage(error));
        process.exitCode = EXIT.failed;
        return;
      }
      if (telemetry) await sendTelemetry(payloadFor(result.plan.spec, installFailure(result)));

      const steps = result.plan.nextSteps({
        directory: answers.projectName,
        installed: result.install.status === 'done',
        keyWritten: true,
        modelReady: answers.provider !== 'ollama',
      });
      p.note(
        steps.map((step) => `${step.command}${step.note ? `  # ${step.note}` : ''}`).join('\n'),
        'Next steps',
        { format: (line) => chalk.dim(line) }
      );

      p.outro(
        `${chalk.green('Your assistant is ready!')} Channels: ${chalk.cyan(answers.channels.join(', '))}`
      );
    }
  );
