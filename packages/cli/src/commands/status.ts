/**
 * cogitator status - show service status
 */

import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import chalk from 'chalk';
import { log } from '../utils/logger.js';

interface ServiceStatus {
  Name: string;
  State: string;
  Status: string;
  Health?: string;
}

function findDockerCompose(): string | null {
  if (existsSync('docker-compose.yml')) return resolve('docker-compose.yml');
  if (existsSync('docker-compose.yaml')) return resolve('docker-compose.yaml');

  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
    if (existsSync(resolve(dir, 'docker-compose.yml'))) {
      return resolve(dir, 'docker-compose.yml');
    }
  }
  return null;
}

function checkDocker(): boolean {
  try {
    execSync('docker info', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
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
