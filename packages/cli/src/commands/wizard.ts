import { Command } from 'commander';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { stringify, parse as parseYaml } from 'yaml';
import {
  AssistantConfigSchema,
  EMAIL_ADDRESS_PATTERN,
  EMAIL_ALLOW_FROM_PATTERN,
  type AssistantConfigOutput,
} from '@cogitator-ai/channels';
import { printBanner } from '../utils/logger.js';
import { examplesHelp } from '../utils/cli.js';
import { mergeEnvContent, parseDotenv } from '../utils/env.js';
import { DEFAULT_OLLAMA_URL, resolveOllamaUrl } from '../utils/ollama.js';
import {
  API_KEY_ENV,
  fetchOllamaModelOptions,
  fetchProviderModels,
  isSetupProvider,
  withProviderPrefix,
  type SetupProvider,
} from '../utils/provider-models.js';

type AssistantConfig = AssistantConfigOutput;
type ChannelName =
  'telegram' | 'discord' | 'slack' | 'bluesky' | 'threads' | 'github' | 'email' | 'teams';
type Capabilities = AssistantConfig['capabilities'];
type McpServers = NonNullable<AssistantConfig['mcpServers']>;

export const CHANNEL_TOKEN_ENV: Record<ChannelName, string> = {
  telegram: 'TG_TOKEN',
  discord: 'DISCORD_TOKEN',
  slack: 'SLACK_BOT_TOKEN',
  bluesky: 'BLUESKY_APP_PASSWORD',
  threads: 'THREADS_ACCESS_TOKEN',
  github: 'GITHUB_CHANNEL_TOKEN',
  email: 'EMAIL_IMAP_PASSWORD',
  teams: 'TEAMS_APP_PASSWORD',
};

const CHANNEL_LABELS: Record<ChannelName, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  bluesky: 'Bluesky',
  threads: 'Threads',
  github: 'GitHub',
  email: 'Email',
  teams: 'Microsoft Teams',
};

const TOKEN_PROMPTS: Record<ChannelName, string> = {
  telegram: 'Telegram bot token:',
  discord: 'Discord bot token:',
  slack: 'Slack bot token:',
  bluesky: 'Bluesky app password (create it with direct messages allowed):',
  threads: 'Threads long-lived access token:',
  github:
    'GitHub token of a separate bot account, scoped to the repositories it answers in (issues and pull requests write):',
  email: 'IMAP password of the bot mailbox (an app password for Gmail and Outlook):',
  teams: 'Client secret of the Azure Bot app registration (Certificates & secrets):',
};

const OWNER_PROMPTS: Record<ChannelName, string> = {
  telegram: 'Telegram owner user ID(s), comma-separated (for admin commands)',
  discord: 'Discord owner user ID(s), comma-separated (for admin commands)',
  slack: 'Slack owner user ID(s), comma-separated (for admin commands)',
  bluesky: 'Bluesky owner DID(s), comma-separated (did:plc:..., for admin commands)',
  threads: 'Threads owner username(s), comma-separated (for admin commands)',
  github:
    'GitHub owner user ID(s), comma-separated (numbers from api.github.com/users/<login>, for admin commands)',
  email: 'Owner email address(es), comma-separated (always answered, for admin commands)',
  teams:
    'Teams owner Entra object ID(s), comma-separated (Microsoft Entra ID, Users, Object ID, for admin commands)',
};

const CHANNELS: readonly ChannelName[] = [
  'telegram',
  'discord',
  'slack',
  'bluesky',
  'threads',
  'github',
  'email',
  'teams',
];

function isChannelName(value: unknown): value is ChannelName {
  return CHANNELS.some((channel) => channel === value);
}
const DEFAULT_MEMORY_PATH = '~/.cogitator/memory.db';
const NOTE_STYLE = { format: (line: string) => chalk.dim(line) };

export function splitCommandLine(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        current += command[++i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (ch === '\\' && i + 1 < command.length) {
      current += command[++i];
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) parts.push(current);
      current = '';
      hasToken = false;
    } else {
      current += ch;
      hasToken = true;
    }
  }

  if (quote) throw new Error('Unterminated quote in command');
  if (hasToken) parts.push(current);
  return parts;
}

export function extractMcpName(args: string[]): string {
  const strip = (name: string) =>
    name
      .replace(/@[^@/]*$/, '')
      .replace(/^(?:mcp-|server-)+/, '')
      .replace(/(?:-mcp|-server)+$/, '');

  const pkg = args.find((a) => a.startsWith('@') || (!a.startsWith('-') && a.includes('/')));
  if (pkg) {
    const name = pkg.startsWith('@') ? (pkg.split('/')[1] ?? pkg) : (pkg.split('/').pop() ?? pkg);
    return strip(name) || 'mcp-server';
  }
  const nonFlag = args.find((a) => !a.startsWith('-'));
  if (nonFlag) return strip(nonFlag) || 'mcp-server';
  return 'mcp-server';
}

export function parsePathList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

type EmailChannelConfig = NonNullable<AssistantConfig['channels']['email']>;

/** What the wizard asks about the email channel */
export interface WizardEmailAnswers {
  address: string;
  imapHost: string;
  smtpHost: string;
  ownerIds: string[];
  allowFrom: string[];
  trustedAuthservIds: string[];
}

/**
 * The email channel of `cogitator.yml` after the wizard: the answers replace what the file held
 * for the address, the servers, the owners, `allowFrom` and `trustedAuthservIds` (a blank answer
 * removes the last two), and its other settings stay.
 */
export function emailChannelConfig(
  existing: EmailChannelConfig | undefined,
  answers: WizardEmailAnswers
): EmailChannelConfig {
  const kept: EmailChannelConfig = { ...existing };
  delete kept.allowFrom;
  delete kept.trustedAuthservIds;
  return {
    ...kept,
    address: answers.address,
    imap: { ...existing?.imap, host: answers.imapHost },
    smtp: { ...existing?.smtp, host: answers.smtpHost },
    ownerIds: answers.ownerIds,
    ...(answers.allowFrom.length > 0 && { allowFrom: answers.allowFrom }),
    ...(answers.trustedAuthservIds.length > 0 && {
      trustedAuthservIds: answers.trustedAuthservIds,
    }),
  };
}

/** Channels configured in cogitator.yml that the wizard does not set up, kept on `--edit` */
export function channelsKeptOnEdit(
  channels: AssistantConfig['channels'] | undefined
): AssistantConfig['channels'] {
  return {
    ...(channels?.whatsapp && { whatsapp: channels.whatsapp }),
    ...(channels?.webchat && { webchat: channels.webchat }),
  };
}

/**
 * Memory settings written by the wizard. A postgres config is kept as is (the wizard only
 * sets up SQLite); otherwise SQLite is used with `sqlitePath`.
 */
export function resolveMemoryConfig(
  existing: AssistantConfig['memory'] | undefined,
  sqlitePath: string | undefined
): AssistantConfig['memory'] {
  const memory: AssistantConfig['memory'] = {
    adapter: 'sqlite',
    autoExtract: true,
    knowledgeGraph: true,
    compaction: { threshold: 50 },
    ...existing,
  };
  if (memory.adapter === 'postgres') return memory;
  return { ...memory, adapter: 'sqlite', path: sqlitePath ?? memory.path ?? DEFAULT_MEMORY_PATH };
}

function cancel(): never {
  p.cancel('Setup cancelled');
  process.exit(0);
}

function prompt<T>(result: T | typeof p.CANCEL_SYMBOL): T {
  if (p.isCancel(result)) cancel();
  return result;
}

function loadExistingConfig(configPath: string): Partial<AssistantConfig> {
  try {
    const raw: unknown = parseYaml(readFileSync(configPath, 'utf-8'));
    const parsed = AssistantConfigSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    p.log.warn('Existing config is not valid; known values will be pre-filled where possible');
    const partial = AssistantConfigSchema.partial().safeParse(raw);
    return partial.success ? partial.data : {};
  } catch {
    p.log.warn('Failed to parse existing config, starting fresh');
    return {};
  }
}

async function askSecret(opts: {
  message: string;
  current: string | undefined;
  required: string;
}): Promise<string | undefined> {
  const value = prompt(
    await p.password({
      message: opts.current ? `${opts.message} (leave blank to keep current)` : opts.message,
      validate: (v) => (!opts.current && !v?.trim() ? opts.required : undefined),
    })
  ).trim();
  return value || undefined;
}

export const wizardCommand = new Command('wizard')
  .description('Interactive assistant setup — generates cogitator.yml + .env')
  .option('--edit', 'Edit existing cogitator.yml')
  .addHelpText(
    'after',
    examplesHelp([
      ['cogitator wizard', 'write cogitator.yml and .env step by step'],
      ['cogitator wizard --edit', 'change the existing cogitator.yml'],
    ])
  )
  .action(async (options: { edit?: boolean }) => {
    printBanner();

    const configPath = resolve(process.cwd(), 'cogitator.yml');
    const envPath = resolve(process.cwd(), '.env');
    const existingEnvContent = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
    const existingEnv = parseDotenv(existingEnvContent);
    const editing = options.edit === true && existsSync(configPath);

    if (!options.edit && existsSync(configPath)) {
      const overwrite = prompt(
        await p.confirm({
          message: 'cogitator.yml already exists. Overwrite it? (use --edit to modify instead)',
          initialValue: false,
        })
      );
      if (!overwrite) cancel();
    }

    let existing: Partial<AssistantConfig> = {};
    if (editing) {
      p.intro(chalk.bgCyan(chalk.black(' Cogitator Assistant Setup (editing existing config) ')));
      existing = loadExistingConfig(configPath);
      p.note(`Loaded ${chalk.dim(configPath)}`, 'Existing config found', NOTE_STYLE);
    } else {
      p.intro(chalk.bgCyan(chalk.black(' Cogitator Personal Assistant Setup ')));
    }

    const envUpdates = new Map<string, string>();
    const existingUserName = existing.personality?.match(/assistant for ([^.\n]+)\./)?.[1];

    const userName = prompt(
      await p.text({
        message: "What's your name?",
        placeholder: 'Alex',
        ...(existingUserName ? { initialValue: existingUserName } : {}),
        validate: (v) => (!v?.trim() ? 'Name is required' : undefined),
      })
    ).trim();

    const assistantName = prompt(
      await p.text({
        message: 'Assistant name',
        placeholder: 'jarvis',
        initialValue: existing.name ?? 'jarvis',
        validate: (v) => (!v?.trim() ? 'Name is required' : undefined),
      })
    ).trim();

    const providerChoice = prompt(
      await p.select({
        message: 'LLM Provider',
        initialValue: existing.llm?.provider ?? 'google',
        options: [
          { value: 'google', label: 'Google (Gemini)', hint: 'recommended' },
          { value: 'anthropic', label: 'Anthropic (Claude)' },
          { value: 'openai', label: 'OpenAI (GPT)' },
          { value: 'ollama', label: 'Ollama', hint: 'local or cloud' },
        ],
      })
    );
    if (!isSetupProvider(providerChoice)) cancel();
    const provider: SetupProvider = providerChoice;

    let ollamaUrl = DEFAULT_OLLAMA_URL;
    let ollamaApiKey: string | undefined;

    if (provider === 'ollama') {
      const currentUrl = resolveOllamaUrl(existingEnv);
      const ollamaMode = prompt(
        await p.select({
          message: 'Ollama deployment',
          initialValue: currentUrl === DEFAULT_OLLAMA_URL ? 'local' : 'cloud',
          options: [
            { value: 'local', label: 'Local', hint: 'running on this machine' },
            { value: 'cloud', label: 'Cloud / Remote', hint: 'custom URL + optional API key' },
          ],
        })
      );

      if (ollamaMode === 'cloud') {
        const rawUrl = prompt(
          await p.text({
            message: 'Ollama URL',
            placeholder: 'https://ollama.com',
            ...(currentUrl !== DEFAULT_OLLAMA_URL ? { initialValue: currentUrl } : {}),
            validate: (v) => {
              const url = v?.trim();
              if (!url) return 'URL is required';
              try {
                new URL(url);
                return undefined;
              } catch {
                return 'Enter a valid URL, e.g. https://ollama.com';
              }
            },
          })
        );
        ollamaUrl = resolveOllamaUrl({}, rawUrl);
        envUpdates.set('OLLAMA_URL', ollamaUrl);

        const key = prompt(
          await p.password({
            message: existingEnv.OLLAMA_API_KEY
              ? 'API key (leave blank to keep current)'
              : 'API key (leave blank if not needed)',
          })
        ).trim();
        if (key) envUpdates.set('OLLAMA_API_KEY', key);
        ollamaApiKey = key || existingEnv.OLLAMA_API_KEY;
      } else if (existingEnv.OLLAMA_URL) {
        envUpdates.set('OLLAMA_URL', DEFAULT_OLLAMA_URL);
      }
    } else {
      const keyName = API_KEY_ENV[provider];
      const key = await askSecret({
        message: `${keyName}:`,
        current: existingEnv[keyName] ?? process.env[keyName],
        required: 'API key is required',
      });
      if (key) envUpdates.set(keyName, key);
    }

    const modelSpinner = p.spinner();
    modelSpinner.start('Fetching available models...');
    const modelOptions =
      provider === 'ollama'
        ? await fetchOllamaModelOptions(ollamaUrl, ollamaApiKey)
        : await fetchProviderModels(provider);
    modelSpinner.stop(`Found ${chalk.cyan(modelOptions.length)} models`);

    const existingModel =
      existing.llm?.model && existing.llm.provider === provider
        ? withProviderPrefix(provider, existing.llm.model)
        : undefined;

    const model = prompt(
      await p.select({
        message: 'Model',
        ...(existingModel && modelOptions.some((m) => m.value === existingModel)
          ? { initialValue: existingModel }
          : {}),
        options: modelOptions,
      })
    );

    const existingChannels = CHANNELS.filter((ch) => existing.channels?.[ch] !== undefined);

    const selectedChannels = prompt(
      await p.multiselect({
        message: 'Channels (terminal is always available)',
        options: CHANNELS.map((value) => ({ value, label: CHANNEL_LABELS[value] })),
        ...(existingChannels.length > 0 ? { initialValues: existingChannels } : {}),
        required: false,
      })
    ).filter(isChannelName);

    const channelsConfig = channelsKeptOnEdit(existing.channels);

    for (const ch of selectedChannels) {
      const tokenEnv = CHANNEL_TOKEN_ENV[ch];
      if (ch === 'bluesky') {
        const handle = prompt(
          await p.text({
            message: 'Bluesky handle of the bot account',
            placeholder: 'yourbot.bsky.social',
            ...(existingEnv.BLUESKY_HANDLE ? { initialValue: existingEnv.BLUESKY_HANDLE } : {}),
            validate: (v) => (!v?.trim() ? 'Handle is required' : undefined),
          })
        ).trim();
        envUpdates.set('BLUESKY_HANDLE', handle);
      }

      let emailServer: { address: string; imapHost: string } | undefined;
      if (ch === 'email') {
        const current = existing.channels?.email;
        const currentAddress = current?.address ?? existingEnv.EMAIL_ADDRESS;
        const address = prompt(
          await p.text({
            message: 'Address of the bot mailbox',
            placeholder: 'assistant@example.com',
            ...(currentAddress ? { initialValue: currentAddress } : {}),
            validate: (v) =>
              EMAIL_ADDRESS_PATTERN.test(v?.trim() ?? '') ? undefined : 'Not an email address',
          })
        )
          .trim()
          .toLowerCase();
        const currentImap = current?.imap?.host ?? existingEnv.EMAIL_IMAP_HOST;
        const imapHost = prompt(
          await p.text({
            message: 'IMAP server it reads mail from',
            placeholder: 'imap.gmail.com',
            ...(currentImap ? { initialValue: currentImap } : {}),
            validate: (v) => (!v?.trim() ? 'IMAP server is required' : undefined),
          })
        ).trim();
        emailServer = { address, imapHost };
      }

      if (ch === 'teams') {
        for (const [name, message] of [
          ['TEAMS_APP_ID', 'Microsoft App ID of the Azure Bot'],
          ['TEAMS_TENANT_ID', 'Tenant ID of its app registration (the tenant it answers)'],
        ] as const) {
          const value = prompt(
            await p.text({
              message,
              placeholder: '00000000-0000-0000-0000-000000000000',
              ...(existingEnv[name] ? { initialValue: existingEnv[name] } : {}),
              validate: (v) => (!v?.trim() ? 'Required' : undefined),
            })
          ).trim();
          envUpdates.set(name, value);
        }
      }

      const token = await askSecret({
        message: TOKEN_PROMPTS[ch],
        current: existingEnv[tokenEnv],
        required: 'Token is required',
      });
      if (token) envUpdates.set(tokenEnv, token);

      const existingOwners = existing.channels?.[ch]?.ownerIds?.join(', ');
      const ownerIdsRaw = prompt(
        await p.text({
          message: OWNER_PROMPTS[ch],
          placeholder: 'your user ID',
          ...(existingOwners ? { initialValue: existingOwners } : {}),
          validate: (v) => {
            const owners = parsePathList(v ?? '');
            if (owners.length === 0) return 'Owner ID is required';
            if (ch === 'email' && owners.some((owner) => !EMAIL_ADDRESS_PATTERN.test(owner))) {
              return 'Owners are email addresses';
            }
            return undefined;
          },
        })
      );

      if (ch === 'slack') {
        const signingSecret = await askSecret({
          message: 'Slack signing secret:',
          current: existingEnv.SLACK_SIGNING_SECRET,
          required: 'Required',
        });
        if (signingSecret) envUpdates.set('SLACK_SIGNING_SECRET', signingSecret);

        const appToken = prompt(
          await p.password({
            message: existingEnv.SLACK_APP_TOKEN
              ? 'Slack app token for Socket Mode (leave blank to keep current)'
              : 'Slack app token for Socket Mode (xapp-..., leave blank for HTTP mode)',
          })
        ).trim();
        if (appToken) envUpdates.set('SLACK_APP_TOKEN', appToken);
      }

      if (ch === 'github') {
        const webhookSecret = await askSecret({
          message: 'GitHub webhook secret (the same as on the repository webhook):',
          current: existingEnv.GITHUB_WEBHOOK_SECRET,
          required: 'Required',
        });
        if (webhookSecret) envUpdates.set('GITHUB_WEBHOOK_SECRET', webhookSecret);
      }

      let emailAnswers: Omit<WizardEmailAnswers, 'ownerIds'> | undefined;
      if (ch === 'email' && emailServer) {
        const current = existing.channels?.email;
        const currentSmtp = current?.smtp?.host ?? existingEnv.EMAIL_SMTP_HOST;
        const smtpHost = prompt(
          await p.text({
            message: 'SMTP server it sends mail through',
            placeholder: 'smtp.gmail.com',
            ...(currentSmtp ? { initialValue: currentSmtp } : {}),
            validate: (v) => (!v?.trim() ? 'SMTP server is required' : undefined),
          })
        ).trim();
        const smtpPassword = await askSecret({
          message: 'SMTP password (often the same app password):',
          current: existingEnv.EMAIL_SMTP_PASSWORD,
          required: 'Required',
        });
        if (smtpPassword) envUpdates.set('EMAIL_SMTP_PASSWORD', smtpPassword);
        const currentAllowFrom = current?.allowFrom?.join(', ');
        const allowFrom = parsePathList(
          prompt(
            await p.text({
              message:
                'Who else may write to it: addresses or domains, comma-separated (blank for the owners only)',
              placeholder: 'example.com, ann@example.org',
              ...(currentAllowFrom ? { initialValue: currentAllowFrom } : {}),
              validate: (v) =>
                parsePathList(v ?? '').every((entry) => EMAIL_ALLOW_FROM_PATTERN.test(entry))
                  ? undefined
                  : 'Each entry is an address, a domain, *.domain or *',
            })
          ) ?? ''
        );
        const currentTrusted =
          current?.trustedAuthservIds?.join(', ') ??
          (/gmail|google/i.test(emailServer.imapHost) ? 'mx.google.com' : undefined);
        const trustedAuthservIds = parsePathList(
          prompt(
            await p.text({
              message:
                'Server id the mailbox host writes in Authentication-Results, so forged senders are caught (mx.google.com for Gmail, blank to skip)',
              placeholder: 'mx.google.com',
              ...(currentTrusted ? { initialValue: currentTrusted } : {}),
            })
          ) ?? ''
        );
        emailAnswers = { ...emailServer, smtpHost, allowFrom, trustedAuthservIds };
      }

      const ownerIds = parsePathList(ownerIdsRaw);
      if (ch === 'bluesky') channelsConfig.bluesky = { ...existing.channels?.bluesky, ownerIds };
      else if (ch === 'threads')
        channelsConfig.threads = { ...existing.channels?.threads, ownerIds };
      else if (ch === 'github')
        channelsConfig.github = {
          ...existing.channels?.github,
          webhook: existing.channels?.github?.webhook ?? { port: 8787 },
          ownerIds,
        };
      else if (ch === 'teams')
        channelsConfig.teams = {
          ...existing.channels?.teams,
          webhook: existing.channels?.teams?.webhook ?? { port: 3978 },
          ownerIds,
        };
      else if (ch === 'email' && emailAnswers)
        channelsConfig.email = emailChannelConfig(existing.channels?.email, {
          ...emailAnswers,
          ownerIds: ownerIds.map((owner) => owner.toLowerCase()),
        });
      else channelsConfig[ch] = { ownerIds };
    }

    const existingCaps = Object.entries(existing.capabilities ?? {})
      .filter(([, value]) => value === true || (typeof value === 'object' && value !== null))
      .map(([key]) => key);

    const selectedCapabilities = prompt(
      await p.multiselect({
        message: 'Capabilities',
        options: [
          { value: 'webSearch', label: 'Web Search', hint: 'search the internet' },
          { value: 'fileSystem', label: 'File System', hint: 'read/write local files' },
          { value: 'github', label: 'GitHub', hint: 'interact with GitHub API' },
          { value: 'deviceTools', label: 'Device Tools', hint: 'system info, clipboard, etc.' },
          { value: 'browser', label: 'Browser', hint: 'browse websites via Playwright' },
          { value: 'scheduler', label: 'Scheduler', hint: 'schedule reminders and tasks' },
          { value: 'rag', label: 'RAG', hint: 'index and search local documents' },
          { value: 'selfConfig', label: 'Self-Config', hint: 'agent can modify its own config' },
          {
            value: 'selfTools',
            label: 'Self-Tools',
            hint: 'agent can create new tools at runtime',
          },
        ],
        ...(existingCaps.length > 0 ? { initialValues: existingCaps } : {}),
        required: false,
      })
    );

    const capabilities: Capabilities = {};

    for (const cap of selectedCapabilities) {
      switch (cap) {
        case 'fileSystem': {
          const existingFsPaths = existing.capabilities?.fileSystem?.paths?.join(', ');
          const pathsRaw = prompt(
            await p.text({
              message: 'Paths to allow for file system access',
              placeholder: '~/Documents, ~/Projects',
              ...(existingFsPaths ? { initialValue: existingFsPaths } : {}),
              validate: (v) =>
                parsePathList(v ?? '').length === 0 ? 'At least one path is required' : undefined,
            })
          );
          capabilities.fileSystem = { paths: parsePathList(pathsRaw) };
          break;
        }
        case 'browser': {
          const current = existing.capabilities?.browser;
          const currentOpts =
            typeof current === 'object'
              ? [...(current.headless ? [] : ['visible']), ...(current.stealth ? ['stealth'] : [])]
              : [];
          const browserOpts = prompt(
            await p.multiselect({
              message: 'Browser options',
              options: [
                { value: 'visible', label: 'Visible window', hint: 'see what the agent does' },
                {
                  value: 'stealth',
                  label: 'Stealth mode',
                  hint: 'anti-detection, human-like behavior',
                },
              ],
              ...(currentOpts.length > 0 ? { initialValues: currentOpts } : {}),
              required: false,
            })
          );
          capabilities.browser =
            browserOpts.length > 0
              ? {
                  headless: !browserOpts.includes('visible'),
                  stealth: browserOpts.includes('stealth'),
                }
              : true;
          break;
        }
        case 'rag': {
          const existingRagPaths = existing.capabilities?.rag?.paths?.join(', ');
          const pathsRaw = prompt(
            await p.text({
              message: 'Paths to index for RAG',
              placeholder: '~/Documents/notes, ~/wiki',
              ...(existingRagPaths ? { initialValue: existingRagPaths } : {}),
              validate: (v) =>
                parsePathList(v ?? '').length === 0 ? 'At least one path is required' : undefined,
            })
          );
          capabilities.rag = { paths: parsePathList(pathsRaw) };
          break;
        }
        case 'github': {
          const ghToken = await askSecret({
            message: 'GitHub Personal Access Token (for GitHub API):',
            current: existingEnv.GITHUB_TOKEN,
            required: 'Token is required for GitHub capability',
          });
          if (ghToken) envUpdates.set('GITHUB_TOKEN', ghToken);
          capabilities.github = true;
          break;
        }
        case 'selfTools':
          capabilities.selfTools = existing.capabilities?.selfTools ?? true;
          break;
        case 'webSearch':
        case 'deviceTools':
        case 'scheduler':
        case 'selfConfig':
          capabilities[cap] = true;
          break;
      }
    }

    const mcpServers: McpServers = { ...(existing.mcpServers ?? {}) };
    const existingMcpNames = Object.keys(mcpServers);
    if (existingMcpNames.length > 0) {
      p.log.info(`Keeping MCP servers: ${existingMcpNames.join(', ')}`);
    }

    let addMore = prompt(
      await p.confirm({
        message: existingMcpNames.length > 0 ? 'Add more MCP servers?' : 'Add MCP servers?',
        initialValue: false,
      })
    );

    while (addMore) {
      const fullCommand = prompt(
        await p.text({
          message: 'Full command to start MCP server',
          placeholder: 'npx -y @modelcontextprotocol/server-filesystem /home',
          validate: (v) => {
            if (!v?.trim()) return 'Command is required';
            try {
              splitCommandLine(v);
              return undefined;
            } catch (error) {
              return error instanceof Error ? error.message : 'Invalid command';
            }
          },
        })
      );

      const [command, ...args] = splitCommandLine(fullCommand);
      const name = prompt(
        await p.text({
          message: 'Server name',
          initialValue: extractMcpName(args),
          validate: (v) => (!v?.trim() ? 'Name is required' : undefined),
        })
      ).trim();

      mcpServers[name] = { command, args };
      p.log.success(`Added MCP server: ${chalk.cyan(name)}`);

      addMore = prompt(
        await p.confirm({ message: 'Add another MCP server?', initialValue: false })
      );
    }

    let sqlitePath: string | undefined;
    if (existing.memory?.adapter === 'postgres') {
      p.log.info('Keeping postgres memory');
    } else {
      sqlitePath = prompt(
        await p.text({
          message: 'SQLite memory database path',
          initialValue: existing.memory?.path ?? DEFAULT_MEMORY_PATH,
          validate: (v) => (!v?.trim() ? 'Path is required' : undefined),
        })
      ).trim();
    }

    const defaultPersonality = [
      `You are ${assistantName}, a personal AI assistant for ${userName}.`,
      `Be concise, friendly, and proactive. Use tools when they can help.`,
      `Remember important things about ${userName} using memory tools.`,
    ].join('\n');

    const personality = prompt(
      await p.text({
        message: 'Assistant personality',
        placeholder: 'Describe how the assistant should behave...',
        initialValue: existing.personality ?? defaultPersonality,
        validate: (v) => (!v?.trim() ? 'Personality is required' : undefined),
      })
    );

    const config: AssistantConfig = {
      ...existing,
      name: assistantName,
      personality,
      llm: { provider, model },
      channels: channelsConfig,
      capabilities,
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : { mcpServers: undefined }),
      memory: resolveMemoryConfig(existing.memory, sqlitePath),
      stream: existing.stream ?? { flushInterval: 600, minChunkSize: 30 },
    };

    const validated = AssistantConfigSchema.parse(config);
    writeFileSync(configPath, stringify(validated, { lineWidth: 120 }));

    if (envUpdates.size > 0) {
      writeFileSync(envPath, mergeEnvContent(existingEnvContent, envUpdates), { mode: 0o600 });
    }

    p.note(
      [
        `${chalk.dim('Config:')} cogitator.yml`,
        envUpdates.size > 0 ? `${chalk.dim('Env:')}    .env` : '',
        '',
        `${chalk.dim('Next:')}   cogitator up`,
      ]
        .filter(Boolean)
        .join('\n'),
      'Files written',
      NOTE_STYLE
    );

    p.outro(chalk.green('Setup complete! Run: cogitator up'));
  });
