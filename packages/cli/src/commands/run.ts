/**
 * cogitator run [message] - run agent
 */

import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import chalk from 'chalk';
import { log, printBanner } from '../utils/logger.js';
import { Cogitator, Agent } from '@cogitator/core';
import { loadConfig } from '@cogitator/config';

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
  // Prefer common models
  const preferred = ['llama3.1:8b', 'llama3:8b', 'gemma3:4b', 'gemma2:9b', 'mistral:7b'];
  for (const p of preferred) {
    if (models.includes(p)) return `ollama/${p}`;
  }
  return `ollama/${models[0]}`;
}

function findConfig(configPath: string): string | null {
  // Explicit path
  if (existsSync(configPath)) {
    return resolve(configPath);
  }
  // Check common names
  const names = ['cogitator.yml', 'cogitator.yaml', 'cogitator.json'];
  for (const name of names) {
    if (existsSync(name)) {
      return resolve(name);
    }
  }
  return null;
}

async function runInteractive(cog: Cogitator, agent: Agent, stream: boolean): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const threadId = `thread_${Date.now()}`;

  console.log(chalk.dim('Interactive mode. Type "exit" or Ctrl+C to quit.\n'));

  const prompt = () => {
    rl.question(chalk.cyan('> '), async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
        console.log(chalk.dim('\nGoodbye!'));
        rl.close();
        await cog.close();
        process.exit(0);
      }

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
        log.error(error instanceof Error ? error.message : String(error));
      }

      prompt();
    });
  };

  prompt();
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
    // Load config if exists
    let config = {};
    const configPath = findConfig(options.config);
    if (configPath) {
      log.dim(`Using config: ${configPath}`);
      try {
        const raw = readFileSync(configPath, 'utf-8');
        if (configPath.endsWith('.json')) {
          config = JSON.parse(raw);
        } else {
          config = await loadConfig();
        }
      } catch {
        // Ignore config errors, use defaults
      }
    }

    // Detect model if not specified
    let model: string | undefined = options.model;
    if (!model) {
      model = (await detectModel()) ?? undefined;
      if (!model) {
        log.error('No model specified and no Ollama models found');
        log.dim('Use -m to specify a model, e.g.: cogitator run -m ollama/gemma3:4b "Hello"');
        log.dim('Or start Ollama and pull a model: ollama pull gemma3:4b');
        process.exit(1);
      }
      log.dim(`Auto-detected model: ${model}`);
    }

    // Create cogitator and agent
    const cog = new Cogitator(config);

    const agent = new Agent({
      id: 'cli-agent',
      name: 'CLI Agent',
      model,
      instructions:
        'You are a helpful AI assistant. Respond concisely and accurately.',
    });

    // Interactive mode
    if (options.interactive || !message) {
      printBanner();
      await runInteractive(cog, agent, options.stream);
      return;
    }

    // Single message mode
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
