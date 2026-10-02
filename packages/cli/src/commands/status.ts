/**
 * cogitator status - show service status
 */

import { Command } from 'commander';
import { dirname } from 'node:path';
import chalk from 'chalk';
import { log } from '../utils/logger.js';
import { findDockerCompose, checkDocker, composePs } from '../utils/docker.js';
import { listOllamaModels, resolveOllamaUrl } from '../utils/ollama.js';

async function checkOllama(baseUrl: string): Promise<boolean> {
  try {
    await listOllamaModels(baseUrl, { apiKey: process.env.OLLAMA_API_KEY, timeoutMs: 3000 });
    return true;
  } catch {
    return false;
  }
}

export const statusCommand = new Command('status')
  .alias('ps')
  .description('Show status of Cogitator services')
  .action(async () => {
    console.log();
    log.info('Cogitator Services Status');
    console.log();

    const dockerAvailable = checkDocker();
    if (!dockerAvailable) {
      log.warn('Docker is not running — skipping Docker Compose services');
      log.dim('Start Docker Desktop or run: sudo systemctl start docker');
      console.log();
    }

    const composePath = dockerAvailable ? findDockerCompose() : null;

    if (composePath) {
      const composeDir = dirname(composePath);

      try {
        const services = composePs(composeDir);

        if (services.length === 0) {
          log.warn('No services running');
          log.dim('Run "cogitator up" to start services');
        } else {
          console.log(chalk.dim('  Docker Compose Services:'));
          console.log();

          for (const svc of services) {
            const isRunning = svc.State === 'running';
            const icon = isRunning ? chalk.green('●') : chalk.red('○');
            const name = svc.Name.padEnd(20);
            const state = isRunning ? chalk.green(svc.State) : chalk.red(svc.State);
            const health = svc.Health ? chalk.dim(` (${svc.Health})`) : '';
            console.log(`  ${icon} ${name} ${state}${health}  ${chalk.dim(svc.Status)}`);
          }
          console.log();
        }
      } catch (error) {
        log.warn('Failed to query docker compose services');
        log.dim(error instanceof Error ? error.message.split('\n')[0] : String(error));
        console.log();
      }
    }

    console.log(chalk.dim('  External Services:'));
    console.log();

    const ollamaUrl = resolveOllamaUrl();
    const ollamaRunning = await checkOllama(ollamaUrl);
    const ollamaIcon = ollamaRunning ? chalk.green('●') : chalk.red('○');
    const ollamaState = ollamaRunning ? chalk.green('running') : chalk.red('stopped');
    console.log(`  ${ollamaIcon} ${'Ollama'.padEnd(20)} ${ollamaState}  ${chalk.dim(ollamaUrl)}`);

    console.log();

    if (!ollamaRunning) {
      log.dim('Tip: Start Ollama with "ollama serve" or via Docker');
    }
  });
