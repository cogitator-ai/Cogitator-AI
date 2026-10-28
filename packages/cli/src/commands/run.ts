/**
 * cogitator run [message] - run agent
 */

import { Command } from 'commander';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import chalk from 'chalk';
import { log, printBanner } from '../utils/logger.js';
import { CommandError, examplesHelp } from '../utils/cli.js';
import { Cogitator, Agent } from '@cogitator-ai/core';
import { experimental_mcpConnector } from '@cogitator-ai/mcp';
import type { CogitatorConfig } from '@cogitator-ai/types';
import { listOllamaModels, resolveOllamaUrl } from '../utils/ollama.js';
import { findConfig, loadRunConfig, type RunConfig } from '../utils/run-config.js';
import {
  claimStdout,
  headlessPlan,
  withSessionStore,
  type HeadlessFlags,
  type HeadlessPlan,
} from '../utils/headless.js';
import { runHeadless } from './headless.js';

/**
 * The config with an MCP connector for the servers of plugins, when it has plugins and names no
 * connector: a config file cannot hold one, and plugins of the Claude Code format bring servers
 */
export function withPluginServers(config: CogitatorConfig): CogitatorConfig {
  const plugins = config.experimental_plugins;
  if (!plugins || plugins.mcp) return config;
  return { ...config, experimental_plugins: { ...plugins, mcp: experimental_mcpConnector() } };
}

export { findConfig, loadRunConfig };
export type { RunConfig };

interface RunOptions extends HeadlessFlags {
  config?: string;
  model?: string;
  interactive?: boolean;
  stream: boolean;
}

/** The version of the CLI, as its package.json has it */
export function cliVersion(): string {
  const path = join(dirname(fileURLToPath(import.meta.url)), '../../package.json');
  return (JSON.parse(readFileSync(path, 'utf-8')) as { version: string }).version;
}

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

export function createCliAgent(model: string): Agent {
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

export async function detectOllamaModel(
  baseUrl: string,
  apiKey?: string,
  headers?: Record<string, string>
): Promise<string | null> {
  try {
    const models = await listOllamaModels(baseUrl, { apiKey, headers, timeoutMs: 3000 });
    return pickOllamaModel(models.map((m) => m.name));
  } catch {
    return null;
  }
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

/**
 * The runtime config and the model a run would use: the flags, the config file, else Ollama's
 * models. The model is undefined when none is named and Ollama has none
 */
export async function resolveRunConfig(options: {
  config?: string;
  model?: string;
}): Promise<{ config: CogitatorConfig; model?: string }> {
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

  const model = resolveRunModel(options.model, process.env, config, loaded.model);
  if (model) return { config, model };
  const ollama = config.llm?.providers?.ollama;
  const baseUrl = resolveOllamaUrl(process.env, ollama?.baseUrl);
  const detected = await detectOllamaModel(baseUrl, ollama?.apiKey, ollama?.headers);
  if (detected) log.dim(`Auto-detected model: ${detected}`);
  return { config, ...(detected && { model: detected }) };
}

/** Hints for a run that found no model */
export const NO_MODEL_HINTS = [
  'Use -m to specify a model, e.g.: cogitator run -m ollama/qwen3:8b "Hello"',
  'Or set COGITATOR_MODEL / llm.defaultModel in cogitator.yml',
  'Or start Ollama and pull a model: ollama pull qwen3:8b',
];

/** The runtime config and the model a run uses: the flags, the config file, else Ollama's models */
export async function resolveRunRuntime(options: {
  config?: string;
  model?: string;
}): Promise<{ config: CogitatorConfig; model: string }> {
  const { config, model } = await resolveRunConfig(options);
  if (!model) {
    throw new CommandError('No model specified and no Ollama models found', {
      hints: NO_MODEL_HINTS,
    });
  }
  return { config, model };
}

/** `cogitator run -p`: protocol output alone on stdout, sessions kept unless asked not to */
async function runPrint(
  message: string | undefined,
  options: RunOptions,
  plan: HeadlessPlan
): Promise<void> {
  const stdout = claimStdout();
  try {
    const { config, model } = await resolveRunRuntime(options);
    const stored = withSessionStore(config, plan.persistSessions);
    if (
      stored.memory?.adapter === 'sqlite' &&
      stored.memory.sqlite?.path &&
      !config.memory?.adapter
    ) {
      mkdirSync(dirname(stored.memory.sqlite.path), { recursive: true });
    }
    const cogitator = new Cogitator(withPluginServers(stored));
    try {
      process.exitCode = await runHeadless({
        cogitator,
        agent: createCliAgent(model),
        plan,
        ...(message !== undefined && { message }),
        io: {
          stdout,
          stderr: process.stderr,
          stdin: process.stdin,
          stdinIsTTY: process.stdin.isTTY === true,
        },
        version: cliVersion(),
      });
    } finally {
      await cogitator.close().catch(() => {});
    }
  } finally {
    await stdout.drained();
    stdout.restore();
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
  .option('-p, --print', 'Run without a terminal: print the answer and exit (headless)')
  .option('--output-format <format>', 'With -p: text (default), json or stream-json')
  .option('--input-format <format>', 'With -p: text (default) or stream-json lines on stdin')
  .option('--resume <session-id>', 'With -p: continue a kept session')
  .option('--fork', 'With -p and --resume: continue in a new session forked from it')
  .option('--session-id <id>', 'With -p: the id of the new session')
  .option('--json-schema <schema>', 'With -p: JSON Schema (inline or a file) the answer must match')
  .option('--no-session-persistence', 'With -p: keep the session in this process only')
  .addHelpText(
    'after',
    examplesHelp([
      ['cogitator run "What is RAG?"', 'one answer from the default model'],
      ['cogitator run -m ollama/qwen3.5:4b -i', 'chat with a local model'],
      ['cogitator run -c cogitator.yml --no-stream "Hi"', 'print the whole answer at once'],
      ['cogitator run -p "Name 3 colors" --output-format json', 'one JSON result, for scripts'],
      ['git diff | cogitator run -p "Review this"', 'the prompt from stdin'],
      [
        'cogitator run -p --input-format stream-json --output-format stream-json',
        'many turns as NDJSON on stdin and stdout',
      ],
      ['cogitator run -p --resume <id> --fork "Try again"', 'branch off a kept session'],
    ])
  )
  .action(async (message: string | undefined, options: RunOptions) => {
    const plan = headlessPlan(options);
    if (plan) {
      await runPrint(message, options, plan);
      return;
    }
    const { config, model } = await resolveRunRuntime(options);
    const cog = new Cogitator(withPluginServers(config));

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
