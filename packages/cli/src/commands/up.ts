/**
 * cogitator up - start Docker services
 */

import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import ora from 'ora';
import chalk from 'chalk';
import { log } from '../utils/logger.js';

function findDockerCompose(): string | null {
  if (existsSync('docker-compose.yml')) {
    return resolve('docker-compose.yml');
  }
  if (existsSync('docker-compose.yaml')) {
    return resolve('docker-compose.yaml');
  }
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
    execSync('docker --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export const upCommand = new Command('up')
  .description('Start Docker services (Redis, Postgres, Ollama)')
  .option('-d, --detach', 'Run in background (default)', true)
  .option('--no-detach', 'Run in foreground')
  .option('--pull', 'Pull latest images before starting')
  .action(async (options: { detach: boolean; pull: boolean }) => {
    log.info('Starting Cogitator services...');

    if (!checkDocker()) {
      log.error('Docker is not installed or not running');
      log.dim('Install Docker: https://docs.docker.com/get-docker/');
      process.exit(1);
    }

    const composePath = findDockerCompose();
    if (!composePath) {
      log.error('No docker-compose.yml found');
      log.dim('Run "cogitator init <name>" to create a project with Docker setup');
      process.exit(1);
    }

    const composeDir = dirname(composePath);
    log.dim(`Using: ${composePath}`);

    if (options.pull) {
      const pullSpinner = ora('Pulling latest images...').start();
      try {
        execSync('docker compose pull', { cwd: composeDir, stdio: 'pipe' });
        pullSpinner.succeed('Images pulled');
      } catch (error) {
        pullSpinner.fail('Failed to pull images');
        log.error(error instanceof Error ? error.message : String(error));
      }
    }

    const spinner = ora('Starting services...').start();

    try {
      const args = ['compose', 'up'];
      if (options.detach) {
        args.push('-d');
      }

      if (options.detach) {
        execSync(['docker', ...args].join(' '), { cwd: composeDir, stdio: 'pipe' });
        spinner.succeed('Services started');

        await new Promise((r) => setTimeout(r, 2000));

        const status = execSync('docker compose ps --format json', {
          cwd: composeDir,
          encoding: 'utf-8',
        });

        console.log();
        log.success('Cogitator services are running:');
        console.log();

        try {
          const services = status
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { Name: string; State: string; Status: string });

          for (const svc of services) {
            const stateIcon = svc.State === 'running' ? chalk.green('●') : chalk.yellow('○');
            console.log(`  ${stateIcon} ${svc.Name} - ${svc.Status}`);
          }
        } catch {
          console.log(status);
        }

        console.log();
        log.dim('Connection info:');
        console.log('  Redis:    redis://localhost:6379');
        console.log('  Postgres: postgresql://cogitator:cogitator@localhost:5432/cogitator');
        console.log('  Ollama:   http://localhost:11434');
        console.log();
        log.dim('Commands:');
        console.log('  cogitator down   - Stop services');
        console.log('  docker compose logs -f   - View logs');
        console.log();
      } else {
        spinner.stop();
        const proc = spawn('docker', args, {
          cwd: composeDir,
          stdio: 'inherit',
        });
        proc.on('exit', (code) => process.exit(code ?? 0));
      }
    } catch (error) {
      spinner.fail('Failed to start services');
      log.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

export const downCommand = new Command('down')
  .description('Stop Docker services')
  .option('-v, --volumes', 'Remove volumes (deletes data)')
  .action((options: { volumes: boolean }) => {
    const composePath = findDockerCompose();
    if (!composePath) {
      log.error('No docker-compose.yml found');
      process.exit(1);
    }

    const composeDir = dirname(composePath);
    const spinner = ora('Stopping services...').start();

    try {
      const args = ['compose', 'down'];
      if (options.volumes) {
        args.push('-v');
      }
      execSync(['docker', ...args].join(' '), { cwd: composeDir, stdio: 'pipe' });
      spinner.succeed('Services stopped');
    } catch (error) {
      spinner.fail('Failed to stop services');
      log.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
