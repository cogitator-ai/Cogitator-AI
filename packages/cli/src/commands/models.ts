/**
 * cogitator models - list available models
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { log } from '../utils/logger.js';
import { CommandError, errorMessage, examplesHelp, printJson } from '../utils/cli.js';
import {
  listOllamaModels,
  pullOllamaModel,
  resolveOllamaConnection,
  resolveOllamaUrl,
  type OllamaConnection,
  type OllamaModelInfo,
} from '../utils/ollama.js';

const DAY_MS = 1000 * 60 * 60 * 24;

/**
 * The connection `models` uses when the project config cannot be read: the
 * environment alone, so an unrelated invalid config, a missing config file or a
 * provider key that is not set never stops the command. An explicit `url` is kept.
 */
function environmentConnection(url?: string): OllamaConnection {
  const apiKey = process.env.OLLAMA_API_KEY;
  return { baseUrl: resolveOllamaUrl(process.env, url), ...(apiKey ? { apiKey } : {}) };
}

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

async function listModels(
  baseUrl: string,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
  json: boolean
): Promise<void> {
  const spinner = ora({
    text: `Fetching models from Ollama (${baseUrl})...`,
    isSilent: json,
  }).start();

  let models: OllamaModelInfo[];
  try {
    models = await listOllamaModels(baseUrl, { apiKey, headers });
  } catch (error) {
    spinner.fail('Cannot connect to Ollama');
    throw new CommandError(`Cannot connect to Ollama at ${baseUrl}: ${errorMessage(error)}`, {
      hints: [
        'Start Ollama with: ollama serve (or set OLLAMA_URL)',
        'Or install from: https://ollama.com',
      ],
    });
  }

  spinner.stop();

  if (json) {
    printJson({
      ok: true,
      url: baseUrl,
      models: [...models]
        .sort((a, b) => b.size - a.size)
        .map((model) => ({ name: model.name, size: model.size, modifiedAt: model.modified_at })),
    });
    return;
  }

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

async function pullModel(
  baseUrl: string,
  model: string,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
  json: boolean
) {
  if (!json) {
    log.info(`Pulling model: ${model}`);
    console.log();
  }

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
        if (json || line === lastLine) return;
        lastLine = line;
        if (process.stdout.isTTY) {
          process.stdout.write(`\r${line.padEnd(60)}`);
        } else {
          console.log(line);
        }
      },
      { apiKey, headers }
    );
  } catch (error) {
    if (process.stdout.isTTY && lastLine) console.log();
    throw new CommandError(error instanceof Error ? error.message : String(error), {
      hints: [`Make sure Ollama is reachable at ${baseUrl}`],
    });
  }

  if (json) {
    printJson({ ok: true, url: baseUrl, model, pulled: true });
    return;
  }
  if (process.stdout.isTTY) console.log();
  console.log();
  log.success(`Model ${model} pulled successfully`);
}

export const modelsCommand = new Command('models')
  .description('List available Ollama models')
  .option('--pull <model>', 'Pull a model from Ollama registry')
  .option(
    '--url <url>',
    'Ollama base URL (first in precedence, over cogitator.yml and OLLAMA_BASE_URL, and it never receives the configured server credentials or headers)'
  )
  .option('--json', 'print the models, or the pulled model, as JSON')
  .addHelpText(
    'after',
    examplesHelp([
      ['cogitator models', 'the models your Ollama has'],
      ['cogitator models --pull qwen3.5:4b', 'download a model'],
      ['cogitator models --json', 'the same list for scripts'],
    ])
  )
  .action(async (options: { pull?: string; url?: string; json?: boolean }) => {
    let connection: OllamaConnection;
    try {
      connection = resolveOllamaConnection({ url: options.url });
    } catch (error) {
      log.warn(`Cannot read the Ollama configuration: ${errorMessage(error).split('\n')[0]}`);
      log.dim('Using the environment only (OLLAMA_BASE_URL, OLLAMA_API_KEY)');
      connection = environmentConnection(options.url);
    }

    if (options.pull) {
      await pullModel(
        connection.baseUrl,
        options.pull,
        connection.apiKey,
        connection.headers,
        options.json === true
      );
      return;
    }

    await listModels(
      connection.baseUrl,
      connection.apiKey,
      connection.headers,
      options.json === true
    );
  });
