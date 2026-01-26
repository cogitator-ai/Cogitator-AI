/**
 * cogitator run [message] - run agent
 */

import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import chalk from 'chalk';
import { log, printBanner } from '../utils/logger.js';
import { Cogitator, Agent } from '@cogitator-ai/core';
import { loadConfig } from '@cogitator-ai/config';

interface RunOptions {
  config: string;
  model?: string;
  interactive: boolean;
  stream: boolean;
}

interface OllamaModel {
  name: string;
  size: number;
}

async function getOllamaModels(): Promise<string[]> {
  try {
    const res = await fetch('http://localhost:11434/api/tags');
    if (!res.ok) return [];
    const data = (await res.json()) as { models: OllamaModel[] };
    return data.models.map((m) => m.name);
  } catch {
    return [];
  }
}

async function detectModel(): Promise<string | null> {
  const models = await getOllamaModels();
  if (models.length === 0) return null;
  const preferred = ['llama3.1:8b', 'llama3:8b', 'gemma3:4b', 'gemma2:9b', 'mistral:7b'];
  for (const p of preferred) {
    if (models.includes(p)) return `ollama/${p}`;
  }
  return `ollama/${models[0]}`;
}

function findConfig(configPath: string): string | null {
  const envConfig = process.env.COGITATOR_CONFIG;
  if (envConfig && existsSync(envConfig)) {
    return resolve(envConfig);
  }

  if (existsSync(configPath)) {
    return resolve(configPath);
  }

  const names = ['cogitator.yml', 'cogitator.yaml', 'cogitator.json'];
  for (const name of names) {
    if (existsSync(name)) {
      return resolve(name);
    }
  }
  return null;
}

interface InteractiveState {
  model: string;
  threadId: string;
  messageCount: number;
}

async function runInteractive(
  cog: Cogitator,
  initialModel: string,
  stream: boolean
): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const state: InteractiveState = {
    model: initialModel,
    threadId: `thread_${Date.now()}`,
    messageCount: 0,
  };

  let agent = new Agent({
    id: 'cli-agent',
    name: 'CLI Agent',
    model: state.model,
    instructions: 'You are a helpful AI assistant. Respond concisely and accurately.',
  });

  const modelShort = state.model.replace('ollama/', '');
  console.log(chalk.dim(`Model: ${modelShort}`));
  console.log(chalk.dim('Commands: /model <name>, /clear, /help, exit\n'));

  const showPrompt = () => {
    const prefix = state.messageCount > 0 ? `[${state.messageCount}] ` : '';
    rl.question(chalk.cyan(`${prefix}> `), async (input) => {
      await handleInput(input);
    });
  };

  const handleInput = async (input: string) => {
    const trimmed = input.trim();

    if (!trimmed) {
      showPrompt();
      return;
    }

    if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
      console.log(chalk.dim('\nGoodbye!'));
      rl.close();
      await cog.close();
      process.exit(0);
    }

    if (trimmed.startsWith('/')) {
      await handleCommand(trimmed);
      showPrompt();
      return;
    }

    try {
      state.messageCount++;

      if (stream) {
        process.stdout.write(chalk.green('→ '));
        await cog.run(agent, {
          input: trimmed,
          threadId: state.threadId,
          stream: true,
          onToken: (token) => process.stdout.write(token),
        });
        console.log('\n');
      } else {
        const result = await cog.run(agent, { input: trimmed, threadId: state.threadId });
        console.log(chalk.green('→'), result.output);
        console.log();
      }
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
    }

    showPrompt();
  };

  const handleCommand = async (cmd: string) => {
    const parts = cmd.slice(1).split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (command) {
      case 'model':
        if (args.length === 0) {
          console.log(chalk.dim(`Current model: ${state.model}`));
        } else {
          const newModel = args[0].includes('/') ? args[0] : `ollama/${args[0]}`;
          state.model = newModel;
          agent = new Agent({
            id: 'cli-agent',
            name: 'CLI Agent',
            model: state.model,
            instructions: 'You are a helpful AI assistant. Respond concisely and accurately.',
          });
          log.success(`Switched to model: ${newModel}`);
        }
        break;

      case 'clear':
        state.threadId = `thread_${Date.now()}`;
        state.messageCount = 0;
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

  showPrompt();
}

export const runCommand = new Command('run')
  .description('Run agent with a message')
  .argument('[message]', 'Message to send to agent')
  .option('-c, --config <path>', 'Config file path', 'cogitator.yml')
  .option('-m, --model <model>', 'Model to use (e.g. ollama/gemma3:4b)')
  .option('-i, --interactive', 'Interactive mode')
  .option('-s, --stream', 'Stream response tokens', true)
  .option('--no-stream', 'Disable streaming')
  .action(async (message: string | undefined, options: RunOptions) => {
    let config = {};
    const configPath = findConfig(options.config);
    if (configPath) {
      log.dim(`Using config: ${configPath}`);
      try {
        const raw = readFileSync(configPath, 'utf-8');
        if (configPath.endsWith('.json')) {
          config = JSON.parse(raw);
        } else {
          config = loadConfig();
        }
      } catch (err) {
        log.warn(`Failed to load config: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let model: string | undefined = options.model || process.env.COGITATOR_MODEL;

    if (!model) {
      model = (await detectModel()) ?? undefined;
      if (!model) {
        log.error('No model specified and no Ollama models found');
        log.dim('Use -m to specify a model, e.g.: cogitator run -m ollama/gemma3:4b "Hello"');
        log.dim('Or set COGITATOR_MODEL environment variable');
        log.dim('Or start Ollama and pull a model: ollama pull gemma3:4b');
        process.exit(1);
      }
      log.dim(`Auto-detected model: ${model}`);
    }

    const cog = new Cogitator(config);

    if (options.interactive || !message) {
      printBanner();
      await runInteractive(cog, model, options.stream);
      return;
    }

    const agent = new Agent({
      id: 'cli-agent',
      name: 'CLI Agent',
      model,
      instructions: 'You are a helpful AI assistant. Respond concisely and accurately.',
    });

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
      process.exit(1);
    } finally {
      await cog.close();
    }
  });
