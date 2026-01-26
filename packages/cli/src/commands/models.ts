/**
 * cogitator models - list available models
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { log } from '../utils/logger.js';

interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
  digest: string;
}

interface OllamaResponse {
  models: OllamaModel[];
}

function formatSize(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

function formatDate(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

export const modelsCommand = new Command('models')
  .description('List available Ollama models')
  .option('--pull <model>', 'Pull a model from Ollama registry')
  .action(async (options: { pull?: string }) => {
    if (options.pull) {
      await pullModel(options.pull);
      return;
    }

    const spinner = ora('Fetching models from Ollama...').start();

    try {
      const res = await fetch('http://localhost:11434/api/tags');

      if (!res.ok) {
        spinner.fail('Failed to connect to Ollama');
        log.dim('Make sure Ollama is running: ollama serve');
        process.exit(1);
      }

      const data = (await res.json()) as OllamaResponse;
      spinner.stop();

      if (data.models.length === 0) {
        log.warn('No models installed');
        console.log();
        log.dim('Pull a model with: cogitator models --pull llama3.1:8b');
        log.dim('Or directly: ollama pull llama3.1:8b');
        return;
      }

      console.log();
      log.success(`Found ${data.models.length} model(s)`);
      console.log();

      const sorted = data.models.sort((a, b) => b.size - a.size);

      for (const model of sorted) {
        const name = model.name.padEnd(25);
        const size = formatSize(model.size).padStart(8);
        const updated = formatDate(model.modified_at);

        console.log(`  ${chalk.cyan(name)} ${chalk.dim(size)}  ${chalk.dim(updated)}`);
      }

      console.log();
      log.dim('Use with: cogitator run -m ollama/<model> "message"');
    } catch {
      spinner.fail('Cannot connect to Ollama');
      log.dim('Start Ollama with: ollama serve');
      log.dim('Or install from: https://ollama.ai');
      process.exit(1);
    }
  });

async function pullModel(model: string): Promise<void> {
  log.info(`Pulling model: ${model}`);
  console.log();

  try {
    const res = await fetch('http://localhost:11434/api/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
    });

    if (!res.ok) {
      log.error('Failed to start pull');
      process.exit(1);
    }

    const reader = res.body?.getReader();
    if (!reader) {
      log.error('No response body');
      process.exit(1);
    }

    const decoder = new TextDecoder();
    let lastStatus = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const data = JSON.parse(line) as { status: string; completed?: number; total?: number };

          if (data.status !== lastStatus) {
            if (data.completed && data.total) {
              const pct = Math.round((data.completed / data.total) * 100);
              process.stdout.write(`\r  ${data.status} ${pct}%`.padEnd(60));
            } else {
              process.stdout.write(`\r  ${data.status}`.padEnd(60));
            }
            lastStatus = data.status;
          }
        } catch {}
      }
    }

    console.log();
    console.log();
    log.success(`Model ${model} pulled successfully`);
  } catch {
    log.error('Cannot connect to Ollama');
    log.dim('Make sure Ollama is running: ollama serve');
    process.exit(1);
  }
}
