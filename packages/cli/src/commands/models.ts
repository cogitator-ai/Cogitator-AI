/**
 * cogitator models - list available models
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { log } from '../utils/logger.js';
import {
  listOllamaModels,
  pullOllamaModel,
  resolveOllamaUrl,
  type OllamaModelInfo,
} from '../utils/ollama.js';

const DAY_MS = 1000 * 60 * 60 * 24;

export function formatSize(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'} ago`;
}

export function formatDate(isoDate: string, now: Date = new Date()): string {
  const time = new Date(isoDate).getTime();
  if (Number.isNaN(time)) return 'unknown';

  const days = Math.max(0, Math.floor((now.getTime() - time) / DAY_MS));

  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return plural(days, 'day');
  if (days < 30) return plural(Math.floor(days / 7), 'week');
  if (days < 365) return plural(Math.floor(days / 30), 'month');
  return plural(Math.floor(days / 365), 'year');
}

async function listModels(baseUrl: string, apiKey: string | undefined): Promise<void> {
  const spinner = ora(`Fetching models from Ollama (${baseUrl})...`).start();

  let models: OllamaModelInfo[];
  try {
    models = await listOllamaModels(baseUrl, { apiKey });
  } catch (error) {
    spinner.fail('Cannot connect to Ollama');
    log.dim(error instanceof Error ? error.message : String(error));
    log.dim('Start Ollama with: ollama serve (or set OLLAMA_URL)');
    log.dim('Or install from: https://ollama.com');
    process.exit(1);
  }

  spinner.stop();

  if (models.length === 0) {
    log.warn('No models installed');
    console.log();
    log.dim('Pull a model with: cogitator models --pull qwen3:8b');
    log.dim('Or directly: ollama pull qwen3:8b');
    return;
  }

  console.log();
  log.success(`Found ${models.length} model(s)`);
  console.log();

  const sorted = [...models].sort((a, b) => b.size - a.size);
  const width = Math.max(25, ...sorted.map((m) => m.name.length + 2));

  for (const model of sorted) {
    const name = model.name.padEnd(width);
    const size = formatSize(model.size).padStart(8);
    const updated = formatDate(model.modified_at);
    console.log(`  ${chalk.cyan(name)} ${chalk.dim(size)}  ${chalk.dim(updated)}`);
  }

  console.log();
  log.dim('Use with: cogitator run -m ollama/<model> "message"');
}

async function pullModel(baseUrl: string, model: string, apiKey: string | undefined) {
  log.info(`Pulling model: ${model}`);
  console.log();

  let lastLine = '';
  try {
    await pullOllamaModel(
      baseUrl,
      model,
      (progress) => {
        const pct =
          progress.completed !== undefined && progress.total
            ? ` ${Math.round((progress.completed / progress.total) * 100)}%`
            : '';
        const line = `  ${progress.status}${pct}`;
        if (line === lastLine) return;
        lastLine = line;
        if (process.stdout.isTTY) {
          process.stdout.write(`\r${line.padEnd(60)}`);
        } else {
          console.log(line);
        }
      },
      { apiKey }
    );
  } catch (error) {
    if (process.stdout.isTTY && lastLine) console.log();
    log.error(error instanceof Error ? error.message : String(error));
    log.dim(`Make sure Ollama is reachable at ${baseUrl}`);
    process.exit(1);
  }

  if (process.stdout.isTTY) console.log();
  console.log();
  log.success(`Model ${model} pulled successfully`);
}

export const modelsCommand = new Command('models')
  .description('List available Ollama models')
  .option('--pull <model>', 'Pull a model from Ollama registry')
  .option('--url <url>', 'Ollama base URL (default: $OLLAMA_URL or http://localhost:11434)')
  .action(async (options: { pull?: string; url?: string }) => {
    const baseUrl = resolveOllamaUrl(process.env, options.url);
    const apiKey = process.env.OLLAMA_API_KEY;

    if (options.pull) {
      await pullModel(baseUrl, options.pull, apiKey);
      return;
    }

    await listModels(baseUrl, apiKey);
  });
