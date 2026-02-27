import { Command } from 'commander';
import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import ora from 'ora';
import chalk from 'chalk';
import { parse as parseYaml } from 'yaml';
import { AssistantConfigSchema } from '@cogitator-ai/config';
import { RuntimeBuilder } from '@cogitator-ai/channels';
import { log } from '../utils/logger.js';
import { findDockerCompose, checkDocker } from '../utils/docker.js';

function loadDotenv(env: Record<string, string | undefined>) {
  if (!existsSync('.env')) return;
  const content = readFileSync('.env', 'utf-8');
  for (const line of content.split('\n')) {
    const match = /^([^#=]+)=(.*)$/.exec(line);
    if (match) env[match[1].trim()] = match[2].trim();
  }
}

async function startFromConfig(configPath: string) {
  const raw = parseYaml(readFileSync(configPath, 'utf-8'));
  const config = AssistantConfigSchema.parse(raw);

  const env = { ...process.env } as Record<string, string | undefined>;
  loadDotenv(env);

  log.info(`Loading ${configPath}...`);
  const spinner = ora('Building runtime...').start();

  const builder = new RuntimeBuilder(config, env);
  const runtime = await builder.build();
  spinner.succeed('Runtime built');

  const channelTypes = Object.keys(config.channels).filter(
    (k) => config.channels[k as keyof typeof config.channels] !== undefined
  );

  await runtime.gateway.start();
  if (runtime.scheduler) runtime.scheduler.start();

  console.log();
  log.success(`Assistant "${config.name}" is running`);
  console.log();
  log.dim('  Model:    ' + config.llm.model);
  if (channelTypes.length > 0) {
    log.dim('  Channels: ' + channelTypes.join(', '));
  }
  log.dim('  Memory:   ' + config.memory.adapter);
  console.log();
  log.dim('Press Ctrl+C to stop');

  const shutdown = async () => {
    console.log();
    const stopSpinner = ora('Shutting down...').start();
    await runtime.cleanup();
    stopSpinner.succeed('Stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

export const upCommand = new Command('up')
  .description('Start assistant from cogitator.yml or Docker services')
  .option('-d, --detach', 'Run in background (default)', true)
  .option('--no-detach', 'Run in foreground')
  .option('--pull', 'Pull latest images before starting')
  .action(async (options: { detach: boolean; pull: boolean }) => {
    const configPath = ['cogitator.yml', 'cogitator.yaml'].find((f) => existsSync(f));
    if (configPath) {
      await startFromConfig(configPath);
      return;
    }

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
