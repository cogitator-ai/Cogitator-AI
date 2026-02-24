/**
 * cogitator status - show service status
 */

import { Command } from 'commander';
import { execSync } from 'node:child_process';
import { dirname } from 'node:path';
import chalk from 'chalk';
import { log } from '../utils/logger.js';
import { findDockerCompose, checkDocker } from '../utils/docker.js';

interface ServiceStatus {
  Name: string;
  State: string;
  Status: string;
  Health?: string;
}

async function checkOllama(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:11434/api/tags');
    return res.ok;
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

    if (!checkDocker()) {
      log.error('Docker is not running');
      log.dim('Start Docker Desktop or run: sudo systemctl start docker');
      process.exit(1);
    }

    const composePath = findDockerCompose();

    if (composePath) {
      const composeDir = dirname(composePath);

      try {
        const output = execSync('docker compose ps --format json', {
          cwd: composeDir,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const services = output
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as ServiceStatus);

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
            console.log(`  ${icon} ${name} ${state}  ${chalk.dim(svc.Status)}`);
          }
          console.log();
        }
      } catch {
        log.dim('No docker-compose services found');
      }
    }

    console.log(chalk.dim('  External Services:'));
    console.log();

    const ollamaRunning = await checkOllama();
    const ollamaIcon = ollamaRunning ? chalk.green('●') : chalk.red('○');
    const ollamaState = ollamaRunning ? chalk.green('running') : chalk.red('stopped');
    console.log(
      `  ${ollamaIcon} ${'Ollama'.padEnd(20)} ${ollamaState}  ${chalk.dim('localhost:11434')}`
    );

    console.log();

    if (!ollamaRunning) {
      log.dim('Tip: Start Ollama with "ollama serve" or via Docker');
    }
  });
