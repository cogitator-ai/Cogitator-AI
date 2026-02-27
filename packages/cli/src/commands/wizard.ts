import { Command } from 'commander';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import { stringify, parse as parseYaml } from 'yaml';
import type { AssistantConfigOutput } from '@cogitator-ai/config';
import { ModelRegistry } from '@cogitator-ai/models';
import { printBanner } from '../utils/logger.js';

type AssistantConfig = AssistantConfigOutput;

type SelectOption = { label: string; value: string; hint?: string };

const FALLBACK_MODELS: Record<string, SelectOption[]> = {
  anthropic: [
    { label: 'Claude Sonnet 4', value: 'anthropic/claude-sonnet-4-20250514' },
    { label: 'Claude Opus 4', value: 'anthropic/claude-opus-4-20250514' },
    { label: 'Claude Haiku 3.5', value: 'anthropic/claude-3-5-haiku-20241022' },
  ],
  openai: [
    { label: 'GPT-4o', value: 'openai/gpt-4o' },
    { label: 'GPT-4o mini', value: 'openai/gpt-4o-mini' },
    { label: 'o3-mini', value: 'openai/o3-mini' },
  ],
  google: [
    { label: 'Gemini 2.5 Flash', value: 'google/gemini-2.5-flash' },
    { label: 'Gemini 2.5 Pro', value: 'google/gemini-2.5-pro' },
  ],
  ollama: [
    { label: 'Llama 3.1 8B', value: 'ollama/llama3.1:8b' },
    { label: 'Gemma 3 4B', value: 'ollama/gemma3:4b' },
    { label: 'Mistral 7B', value: 'ollama/mistral:7b' },
  ],
};

async function fetchModels(provider: string): Promise<SelectOption[]> {
  try {
    const registry = new ModelRegistry({ fallbackToBuiltin: true });
    await registry.initialize();

    let models = registry.listModels({
      provider,
      supportsTools: true,
      excludeDeprecated: true,
    });

    if (provider === 'google') {
      models = models.filter((m) => m.id.includes('gemini'));
    }

    if (models.length === 0) return FALLBACK_MODELS[provider] ?? [];

    return models.map((m) => ({
      label: m.displayName,
      value: m.id,
    }));
  } catch {
    return FALLBACK_MODELS[provider] ?? [];
  }
}

async function fetchOllamaModels(baseUrl: string): Promise<SelectOption[]> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`);
    if (!res.ok) return FALLBACK_MODELS.ollama;

    const data = (await res.json()) as { models?: Array<{ name: string; size: number }> };
    if (!data.models?.length) return FALLBACK_MODELS.ollama;

    return data.models.map((m) => ({
      label: m.name,
      value: `ollama/${m.name}`,
      hint: formatBytes(m.size),
    }));
  } catch {
    return FALLBACK_MODELS.ollama;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function extractMcpName(args: string[]): string {
  const pkg = args.find((a) => a.startsWith('@') || (!a.startsWith('-') && a.includes('/')));
  if (pkg) {
    const name = pkg.split('/').pop() ?? pkg;
    return name.replace(/^server-/, '').replace(/-server$/, '');
  }
  const nonFlag = args.find((a) => !a.startsWith('-'));
  if (nonFlag) return nonFlag.replace(/^server-/, '').replace(/-server$/, '');
  return 'mcp-server';
}

const API_KEY_NAMES: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
};

const CHANNEL_TOKEN_ENV: Record<string, string> = {
  telegram: 'TG_TOKEN',
  discord: 'DISCORD_TOKEN',
  slack: 'SLACK_BOT_TOKEN',
};

function cancel(): never {
  p.cancel('Setup cancelled');
  process.exit(0);
}

function prompt<T>(result: T | symbol): T {
  if (p.isCancel(result)) cancel();
  return result as T;
}

export const wizardCommand = new Command('wizard')
  .description('Interactive assistant setup — generates cogitator.yml + .env')
  .option('--edit', 'Edit existing cogitator.yml')
  .action(async (options: { edit: boolean }) => {
    printBanner();

    const configPath = resolve(process.cwd(), 'cogitator.yml');
    const envPath = resolve(process.cwd(), '.env');

    let existing: Partial<AssistantConfig> = {};
    if (options.edit && existsSync(configPath)) {
      p.intro(chalk.bgCyan(chalk.black(' Cogitator Assistant Setup (editing existing config) ')));
      try {
        existing = parseYaml(readFileSync(configPath, 'utf-8')) as Partial<AssistantConfig>;
      } catch {
        p.log.warn('Failed to parse existing config, starting fresh');
      }
      p.note(`Loaded ${chalk.dim(configPath)}`, 'Existing config found');
    } else {
      p.intro(chalk.bgCyan(chalk.black(' Cogitator Personal Assistant Setup ')));
    }

    const existingUserName = existing.personality?.match(/assistant for (\w+)/)?.[1];

    const userName = prompt(
      await p.text({
        message: "What's your name?",
        placeholder: 'Alex',
        ...(existingUserName ? { initialValue: existingUserName } : {}),
        validate: (v) => (!v.trim() ? 'Name is required' : undefined),
      })
    );

    const assistantName = prompt(
      await p.text({
        message: 'Assistant name',
        placeholder: 'jarvis',
        initialValue: existing.name ?? 'jarvis',
        validate: (v) => (!v.trim() ? 'Name is required' : undefined),
      })
    );

    const provider = prompt(
      await p.select({
        message: 'LLM Provider',
        initialValue: existing.llm?.provider ?? 'google',
        options: [
          { value: 'google', label: 'Google (Gemini)', hint: 'recommended' },
          { value: 'anthropic', label: 'Anthropic (Claude)' },
          { value: 'openai', label: 'OpenAI (GPT-4o)' },
          { value: 'ollama', label: 'Ollama', hint: 'local or cloud' },
        ],
      })
    ) as string;

    let ollamaUrl = 'http://localhost:11434';
    let apiKey = '';

    if (provider === 'ollama') {
      const ollamaMode = prompt(
        await p.select({
          message: 'Ollama deployment',
          initialValue: 'local',
          options: [
            { value: 'local', label: 'Local', hint: 'running on this machine' },
            { value: 'cloud', label: 'Cloud / Remote', hint: 'custom URL + optional API key' },
          ],
        })
      ) as string;

      if (ollamaMode === 'cloud') {
        ollamaUrl = prompt(
          await p.text({
            message: 'Ollama URL',
            placeholder: 'https://ollama.example.com',
            validate: (v) => (!v.trim() ? 'URL is required' : undefined),
          })
        ) as string;

        const ollamaApiKey = prompt(
          await p.text({
            message: 'API key (leave blank if not needed)',
            placeholder: 'optional',
          })
        ) as string;

        if (ollamaApiKey.trim()) {
          apiKey = ollamaApiKey.trim();
        }
      }
    } else {
      apiKey = prompt(
        await p.password({
          message: `${API_KEY_NAMES[provider]}:`,
          validate: (v) => (!v.trim() ? 'API key is required' : undefined),
        })
      ) as string;
    }

    const modelSpinner = p.spinner();
    modelSpinner.start('Fetching available models...');

    const modelOptions =
      provider === 'ollama' ? await fetchOllamaModels(ollamaUrl) : await fetchModels(provider);

    modelSpinner.stop(
      modelOptions.length > 0
        ? `Found ${chalk.cyan(modelOptions.length)} models`
        : 'Using fallback model list'
    );

    const existingModelInList = modelOptions.some((m) => m.value === existing.llm?.model);

    const model = prompt(
      await p.select({
        message: 'Model',
        ...(existingModelInList ? { initialValue: existing.llm!.model } : {}),
        options: modelOptions,
      })
    ) as string;

    const existingChannels = Object.keys(existing.channels ?? {}).filter(
      (k) => (existing.channels as Record<string, unknown>)?.[k] !== undefined
    );

    const selectedChannels = prompt(
      await p.multiselect({
        message: 'Channels (terminal is always available)',
        options: [
          { value: 'telegram', label: 'Telegram' },
          { value: 'discord', label: 'Discord' },
          { value: 'slack', label: 'Slack' },
        ],
        ...(existingChannels.length > 0 ? { initialValues: existingChannels } : {}),
        required: false,
      })
    ) as string[];

    const envLines: string[] = [];

    if (provider === 'ollama') {
      if (ollamaUrl !== 'http://localhost:11434') {
        envLines.push(`OLLAMA_URL=${ollamaUrl}`);
      }
      if (apiKey) {
        envLines.push(`OLLAMA_API_KEY=${apiKey}`);
      }
    } else if (apiKey && API_KEY_NAMES[provider]) {
      envLines.push(`${API_KEY_NAMES[provider]}=${apiKey}`);
    }

    const channelsConfig: AssistantConfig['channels'] = {};

    for (const ch of selectedChannels) {
      const token = prompt(
        await p.password({
          message: `${ch} bot token:`,
          validate: (v) => (!v.trim() ? 'Token is required' : undefined),
        })
      ) as string;

      const ownerId = prompt(
        await p.text({
          message: `${ch} owner user ID (for admin commands)`,
          placeholder: 'your user ID',
          validate: (v) => (!v.trim() ? 'Owner ID is required' : undefined),
        })
      ) as string;

      envLines.push(`${CHANNEL_TOKEN_ENV[ch]}=${token}`);

      if (ch === 'slack') {
        const signingSecret = prompt(
          await p.password({
            message: 'Slack signing secret:',
            validate: (v) => (!v.trim() ? 'Required' : undefined),
          })
        ) as string;
        envLines.push(`SLACK_SIGNING_SECRET=${signingSecret}`);
      }

      channelsConfig[ch as keyof typeof channelsConfig] = { ownerIds: [ownerId] };
    }

    const existingCaps = Object.keys(existing.capabilities ?? {}).filter((k) => {
      const val = (existing.capabilities as Record<string, unknown>)?.[k];
      return val === true || (typeof val === 'object' && val !== null);
    });

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
    ) as string[];

    const capabilities: AssistantConfig['capabilities'] = {};

    for (const cap of selectedCapabilities) {
      if (cap === 'fileSystem') {
        const existingFsPaths = existing.capabilities?.fileSystem?.paths?.join(', ');
        const pathsRaw = prompt(
          await p.text({
            message: 'Paths to allow for file system access',
            placeholder: '~/Documents, ~/Projects',
            ...(existingFsPaths ? { initialValue: existingFsPaths } : {}),
            validate: (v) => (!v.trim() ? 'At least one path is required' : undefined),
          })
        ) as string;
        capabilities.fileSystem = {
          paths: pathsRaw.split(',').map((s) => s.trim()),
        };
      } else if (cap === 'browser') {
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
            required: false,
          })
        ) as string[];

        if (browserOpts.includes('visible') || browserOpts.includes('stealth')) {
          capabilities.browser = {
            headless: !browserOpts.includes('visible'),
            stealth: browserOpts.includes('stealth'),
          };
        } else {
          capabilities.browser = true;
        }
      } else if (cap === 'rag') {
        const existingRagPaths = existing.capabilities?.rag?.paths?.join(', ');
        const pathsRaw = prompt(
          await p.text({
            message: 'Paths to index for RAG',
            placeholder: '~/Documents/notes, ~/wiki',
            ...(existingRagPaths ? { initialValue: existingRagPaths } : {}),
            validate: (v) => (!v.trim() ? 'At least one path is required' : undefined),
          })
        ) as string;
        capabilities.rag = {
          paths: pathsRaw.split(',').map((s) => s.trim()),
        };
      } else {
        (capabilities as Record<string, boolean>)[cap] = true;
      }
    }

    const mcpServers: Record<string, { command: string; args: string[] }> = {};
    const existingMcpNames = Object.keys(existing.mcpServers ?? {});

    const addMcp = prompt(
      await p.confirm({
        message: 'Add MCP servers?',
        initialValue: existingMcpNames.length > 0,
      })
    );

    if (addMcp) {
      let addMore = true;
      while (addMore) {
        const fullCommand = prompt(
          await p.text({
            message: 'Full command to start MCP server',
            placeholder: 'npx -y @modelcontextprotocol/server-filesystem /home',
            validate: (v) => (!v.trim() ? 'Command is required' : undefined),
          })
        ) as string;

        const parts = fullCommand
          .trim()
          .split(/\s+/)
          .filter((s) => s.length > 0);
        const command = parts[0];
        const args = parts.slice(1);

        const detectedName = extractMcpName(args);

        const name = prompt(
          await p.text({
            message: 'Server name',
            initialValue: detectedName,
            validate: (v) => (!v.trim() ? 'Name is required' : undefined),
          })
        ) as string;

        mcpServers[name] = { command, args };

        p.log.success(`Added MCP server: ${chalk.cyan(name)}`);

        addMore = prompt(
          await p.confirm({
            message: 'Add another MCP server?',
            initialValue: false,
          })
        );
      }
    }

    const memoryAdapter = prompt(
      await p.select({
        message: 'Memory',
        initialValue: existing.memory?.adapter ?? 'sqlite',
        options: [
          { value: 'sqlite', label: 'SQLite (recommended)', hint: 'zero config, file-based' },
          { value: 'postgres', label: 'PostgreSQL', hint: 'production-grade' },
        ],
      })
    ) as 'sqlite' | 'postgres';

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
      })
    ) as string;

    const config: AssistantConfig = {
      name: assistantName as string,
      personality,
      llm: {
        provider: provider as AssistantConfig['llm']['provider'],
        model,
      },
      channels: channelsConfig,
      capabilities,
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      memory: {
        adapter: memoryAdapter,
        path: memoryAdapter === 'sqlite' ? '~/.cogitator/memory.db' : undefined,
        autoExtract: true,
        knowledgeGraph: true,
        compaction: { threshold: 50 },
      },
      stream: { flushInterval: 600, minChunkSize: 30 },
    };

    writeFileSync(configPath, stringify(config, { lineWidth: 120 }));

    if (envLines.length > 0) {
      const existing = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
      const merged = mergeEnvLines(existing, envLines);
      writeFileSync(envPath, merged);
    }

    p.note(
      [
        `${chalk.dim('Config:')} cogitator.yml`,
        envLines.length > 0 ? `${chalk.dim('Env:')}    .env` : '',
        '',
        `${chalk.dim('Next:')}   cogitator up`,
      ]
        .filter(Boolean)
        .join('\n'),
      'Files written'
    );

    p.outro(chalk.green('Setup complete! Run: cogitator up'));
  });

function mergeEnvLines(existing: string, newLines: string[]): string {
  const lines = existing.split('\n').filter(Boolean);
  const map = new Map<string, string>();

  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq > 0) map.set(line.slice(0, eq), line);
  }

  for (const line of newLines) {
    const eq = line.indexOf('=');
    if (eq > 0) map.set(line.slice(0, eq), line);
  }

  return [...map.values()].join('\n') + '\n';
}
