/**
 * cogitator run [message] - run agent
 */

import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import chalk from 'chalk';
import { parse as parseYaml } from 'yaml';
import { log, printBanner } from '../utils/logger.js';
import { CommandError, examplesHelp } from '../utils/cli.js';
import { Cogitator, Agent } from '@cogitator-ai/core';
import { CONFIG_FILE_NAMES, loadConfig } from '@cogitator-ai/config';
import type { CogitatorConfig } from '@cogitator-ai/types';
import { listOllamaModels, resolveOllamaUrl } from '../utils/ollama.js';
import { loadDotenvInto } from '../utils/env.js';
import { detectConfigKind, type ProjectConfigKind } from '../utils/project-config.js';

interface RunOptions {
  config?: string;
  model?: string;
  interactive?: boolean;
  stream: boolean;
}

const RUN_CONFIG_FILE_NAMES = [...CONFIG_FILE_NAMES, 'cogitator.json'];

const PREFERRED_OLLAMA_MODELS = [
  'qwen3:8b',
  'qwen3.5:9b',
  'llama3.1:8b',
  'llama3:8b',
  'gemma3:4b',
  'gemma2:9b',
  'mistral:7b',
];

const AGENT_INSTRUCTIONS = 'You are a helpful AI assistant. Respond concisely and accurately.';

function createCliAgent(model: string): Agent {
  return new Agent({
    id: 'cli-agent',
    name: 'CLI Agent',
    model,
    instructions: AGENT_INSTRUCTIONS,
  });
}

export function pickOllamaModel(available: readonly string[]): string | null {
  if (available.length === 0) return null;
  const preferred = PREFERRED_OLLAMA_MODELS.find((m) => available.includes(m));
  return `ollama/${preferred ?? available[0]}`;
}

async function detectOllamaModel(baseUrl: string, apiKey?: string): Promise<string | null> {
  try {
    const models = await listOllamaModels(baseUrl, { apiKey, timeoutMs: 3000 });
    return pickOllamaModel(models.map((m) => m.name));
  } catch {
    return null;
  }
}

export function findConfig(
  explicitPath?: string,
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd()
): string | null {
  if (explicitPath) {
    const full = resolve(cwd, explicitPath);
    return existsSync(full) ? full : null;
  }

  const envConfig = env.COGITATOR_CONFIG;
  if (envConfig) {
    const full = resolve(cwd, envConfig);
    return existsSync(full) ? full : null;
  }

  for (const name of RUN_CONFIG_FILE_NAMES) {
    const full = resolve(cwd, name);
    if (existsSync(full)) return full;
  }
  return null;
}

export interface RunConfig {
  config: CogitatorConfig;
  /** What the config file configures, undefined without one */
  kind?: ProjectConfigKind;
  /** `provider/model` of an assistant config, which has no `llm.defaultModel` */
  model?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `llm.provider` and `llm.model` of an assistant config as one model string. */
function assistantModel(document: unknown): string | undefined {
  const llm = isRecord(document) ? document.llm : undefined;
  if (!isRecord(llm) || typeof llm.model !== 'string' || !llm.model.trim()) return undefined;
  const model = llm.model.trim();
  if (model.includes('/') || typeof llm.provider !== 'string') return model;
  return `${llm.provider}/${model}`;
}

/**
 * The runtime config `cogitator run` uses. The `.env` next to the config file
 * (or in `cwd` without one) is loaded first, without overriding variables
 * already set, so API keys reach the env loader. An assistant config from
 * `cogitator wizard` is not a runtime config: only its model is taken, and
 * the rest comes from the environment.
 */
export function loadRunConfig(configPath: string | null, cwd: string = process.cwd()): RunConfig {
  loadDotenvInto(join(configPath ? dirname(configPath) : cwd, '.env'), process.env);
  if (!configPath) return { config: loadConfig({ skipYaml: true }) };

  let document: unknown;
  try {
    document = parseYaml(readFileSync(configPath, 'utf-8'));
  } catch {
    document = undefined;
  }
  if (document !== undefined && detectConfigKind(document) === 'assistant') {
    return {
      config: loadConfig({ skipYaml: true }),
      kind: 'assistant',
      model: assistantModel(document),
    };
  }
  return { config: loadConfig({ configPath }), kind: 'runtime' };
}

export function resolveRunModel(
  flagModel: string | undefined,
  env: Record<string, string | undefined>,
  config: CogitatorConfig,
  configModel?: string
): string | undefined {
  return flagModel || env.COGITATOR_MODEL || config.llm?.defaultModel || configModel || undefined;
}

async function runInteractive(cog: Cogitator, initialModel: string, stream: boolean) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let model = initialModel;
  let agent = createCliAgent(model);
  let threadId = `thread_${Date.now()}`;
  let messageCount = 0;
  let closing = false;

  const close = async (code: number) => {
    if (closing) return;
    closing = true;
    rl.close();
    await cog.close().catch(() => {});
    process.exit(code);
  };

  rl.on('close', () => {
    if (!closing) {
      console.log(chalk.dim('\nGoodbye!'));
      void close(0);
    }
  });

  console.log(chalk.dim(`Model: ${model}`));
  console.log(chalk.dim('Commands: /model <name>, /clear, /help, exit\n'));

  const handleCommand = (cmd: string) => {
    const [rawCommand = '', ...args] = cmd.slice(1).split(/\s+/);
    const command = rawCommand.toLowerCase();

    switch (command) {
      case 'model':
        if (args.length === 0) {
          console.log(chalk.dim(`Current model: ${model}`));
        } else {
          model = args[0];
          agent = createCliAgent(model);
          log.success(`Switched to model: ${model}`);
        }
        break;

      case 'clear':
        threadId = `thread_${Date.now()}`;
        messageCount = 0;
        console.log(chalk.dim('Conversation cleared'));
        break;

      case 'help':
        console.log(chalk.dim('\nAvailable commands:'));
        console.log(chalk.dim('  /model [name]  - Show or change model'));
        console.log(chalk.dim('  /clear         - Clear conversation history'));
        console.log(chalk.dim('  /help          - Show this help'));
        console.log(chalk.dim('  exit           - Exit interactive mode\n'));
        break;

      default:
        log.warn(`Unknown command: /${command}`);
        log.dim('Type /help for available commands');
    }
  };

  const handleInput = async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    const lowered = trimmed.toLowerCase();
    if (lowered === 'exit' || lowered === 'quit') {
      console.log(chalk.dim('\nGoodbye!'));
      await close(0);
      return;
    }

    if (trimmed.startsWith('/')) {
      handleCommand(trimmed);
      return;
    }

    messageCount++;
    try {
      if (stream) {
        process.stdout.write(chalk.green('→ '));
        await cog.run(agent, {
          input: trimmed,
          threadId,
          stream: true,
          onToken: (token) => process.stdout.write(token),
        });
        console.log('\n');
      } else {
        const result = await cog.run(agent, { input: trimmed, threadId });
        console.log(chalk.green('→'), result.output);
        console.log();
      }
    } catch (error) {
      if (stream) console.log();
      log.error(error instanceof Error ? error.message : String(error));
    }
  };

  while (!closing) {
    const prefix = messageCount > 0 ? `[${messageCount}] ` : '';
    const input = await new Promise<string | null>((resolveInput) => {
      const onClose = () => resolveInput(null);
      rl.once('close', onClose);
      rl.question(chalk.cyan(`${prefix}> `), (answer) => {
        rl.off('close', onClose);
        resolveInput(answer);
      });
    });
    if (input === null) return;
    await handleInput(input);
  }
}

export const runCommand = new Command('run')
  .description('Run agent with a message')
  .argument('[message]', 'Message to send to agent')
  .option('-c, --config <path>', 'Config file path (default: ./cogitator.yml)')
  .option('-m, --model <model>', 'Model to use (e.g. ollama/qwen3:8b)')
  .option('-i, --interactive', 'Interactive mode')
  .option('-s, --stream', 'Stream response tokens', true)
  .option('--no-stream', 'Disable streaming')
  .addHelpText(
    'after',
    examplesHelp([
      ['cogitator run "What is RAG?"', 'one answer from the default model'],
      ['cogitator run -m ollama/qwen3.5:4b -i', 'chat with a local model'],
      ['cogitator run -c cogitator.yml --no-stream "Hi"', 'print the whole answer at once'],
    ])
  )
  .action(async (message: string | undefined, options: RunOptions) => {
    const configPath = findConfig(options.config);
    if (options.config && !configPath) {
      throw new CommandError(`Config file not found: ${resolve(options.config)}`);
    }
    if (!options.config && process.env.COGITATOR_CONFIG && !configPath) {
      throw new CommandError(
        `COGITATOR_CONFIG points to a missing file: ${process.env.COGITATOR_CONFIG}`
      );
    }

    let loaded: RunConfig;
    try {
      loaded = loadRunConfig(configPath);
    } catch (error) {
      throw new CommandError(
        `Failed to load config: ${error instanceof Error ? error.message : error}`
      );
    }
    const { config } = loaded;
    if (configPath && loaded.kind === 'assistant') {
      log.dim(
        `Using the model of assistant config ${configPath} (run the assistant itself with "cogitator up")`
      );
    } else if (configPath) {
      log.dim(`Using config: ${configPath}`);
    }

    let model = resolveRunModel(options.model, process.env, config, loaded.model);

    if (!model) {
      const ollama = config.llm?.providers?.ollama;
      const baseUrl = resolveOllamaUrl(process.env, ollama?.baseUrl);
      model =
        (await detectOllamaModel(baseUrl, ollama?.apiKey ?? process.env.OLLAMA_API_KEY)) ??
        undefined;
      if (!model) {
        throw new CommandError('No model specified and no Ollama models found', {
          hints: [
            'Use -m to specify a model, e.g.: cogitator run -m ollama/qwen3:8b "Hello"',
            'Or set COGITATOR_MODEL / llm.defaultModel in cogitator.yml',
            'Or start Ollama and pull a model: ollama pull qwen3:8b',
          ],
        });
      }
      log.dim(`Auto-detected model: ${model}`);
    }

    const cog = new Cogitator(config);

    if (options.interactive || !message) {
      printBanner();
      await runInteractive(cog, model, options.stream);
      return;
    }

    const agent = createCliAgent(model);

    try {
      if (options.stream) {
        await cog.run(agent, {
          input: message,
          stream: true,
          onToken: (token) => process.stdout.write(token),
        });
        console.log();
      } else {
        const result = await cog.run(agent, { input: message });
        console.log(result.output);
      }
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      await cog.close().catch(() => {});
    }
  });
