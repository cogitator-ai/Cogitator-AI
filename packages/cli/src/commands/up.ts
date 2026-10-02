import { Command } from 'commander';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname, resolve as resolvePath } from 'node:path';
import ora from 'ora';
import chalk from 'chalk';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  AssistantConfigSchema,
  RuntimeBuilder,
  type AssistantConfigOutput,
  type BuiltRuntime,
} from '@cogitator-ai/channels';
import { log } from '../utils/logger.js';
import { findDockerCompose, checkDocker, composePs, type ComposeService } from '../utils/docker.js';
import { loadDotenvInto } from '../utils/env.js';

export const RESTART_EXIT_CODE = 78;
const ASSISTANT_CONFIG_FILES = ['cogitator.yml', 'cogitator.yaml'];

export function findAssistantConfig(cwd: string = process.cwd()): string | null {
  for (const name of ASSISTANT_CONFIG_FILES) {
    const full = resolvePath(cwd, name);
    if (existsSync(full)) return full;
  }
  return null;
}

export function loadAssistantConfig(configPath: string): AssistantConfigOutput {
  const raw: unknown = parseYaml(readFileSync(configPath, 'utf-8'));
  const result = AssistantConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid assistant config in ${configPath}:\n${issues}`);
  }
  return result.data;
}

function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal) return 128 + (osConstants.signals[signal] ?? 0);
  return 0;
}

async function startFromConfig(configPath: string): Promise<void> {
  const config = loadAssistantConfig(configPath);

  const env: Record<string, string | undefined> = { ...process.env };
  loadDotenvInto(resolvePath(dirname(configPath), '.env'), env);

  log.info(`Loading ${configPath}...`);
  const spinner = ora('Building runtime...').start();

  let runtime: BuiltRuntime;
  try {
    const builder = new RuntimeBuilder(config, env, {
      configPath,
      configHelpers: {
        parseYaml,
        stringifyYaml: (o: unknown) => stringifyYaml(o, { lineWidth: 120 }),
        validateConfig: (o: unknown) => AssistantConfigSchema.parse(o),
      },
    });
    runtime = await builder.build();
  } catch (error) {
    spinner.fail('Failed to build runtime');
    throw error;
  }
  spinner.succeed('Runtime built');

  let stopping = false;
  const shutdown = async (exitCode: number) => {
    if (stopping) return;
    stopping = true;
    console.log();
    const stopSpinner = ora('Shutting down...').start();
    try {
      await runtime.cleanup();
      stopSpinner.succeed('Stopped');
    } catch (error) {
      stopSpinner.fail(`Shutdown error: ${error instanceof Error ? error.message : String(error)}`);
      exitCode = exitCode || 1;
    }
    process.exit(exitCode);
  };

  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  try {
    await runtime.gateway.start();
  } catch (error) {
    log.error(`Failed to start channels: ${error instanceof Error ? error.message : error}`);
    await shutdown(1);
    return;
  }

  const channelTypes = Object.entries(config.channels)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);

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
}

function startWithAutoRestart(configPath: string): void {
  let child: ChildProcess | null = null;
  let stopping = false;

  const forward = (signal: NodeJS.Signals) => {
    stopping = true;
    if (child?.exitCode === null) child.kill(signal);
    else process.exit(0);
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  const launch = () => {
    child = spawn(
      process.execPath,
      [process.argv[1], 'up', '--no-restart-loop', '--config', configPath],
      { stdio: 'inherit', env: process.env }
    );

    child.on('error', (error) => {
      log.error(`Failed to start assistant process: ${error.message}`);
      process.exit(1);
    });

    child.on('exit', (code, signal) => {
      if (!stopping && code === RESTART_EXIT_CODE) {
        log.info('Restarting with updated config...');
        console.log();
        launch();
        return;
      }
      process.exit(exitCodeFor(code, signal));
    });
  };

  launch();
}

async function startAssistant(configPath: string, restartLoop: boolean): Promise<void> {
  try {
    if (!restartLoop) {
      await startFromConfig(configPath);
      return;
    }
    const config = loadAssistantConfig(configPath);
    if (config.capabilities.selfConfig) {
      startWithAutoRestart(configPath);
    } else {
      await startFromConfig(configPath);
    }
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function printComposeServices(composeDir: string): void {
  let services: ComposeService[];
  try {
    services = composePs(composeDir);
  } catch (error) {
    log.warn('Could not read service status');
    log.dim(error instanceof Error ? error.message.split('\n')[0] : String(error));
    return;
  }

  console.log();
  log.success('Cogitator services are running:');
  console.log();

  for (const svc of services) {
    const stateIcon = svc.State === 'running' ? chalk.green('●') : chalk.yellow('○');
    const ports = svc.ports.length > 0 ? chalk.dim(`  ${svc.ports.join(', ')}`) : '';
    console.log(`  ${stateIcon} ${svc.Name} - ${svc.Status}${ports}`);
  }
}

async function startComposeServices(options: { detach: boolean; pull?: boolean }) {
  log.info('Starting Cogitator services...');

  if (!checkDocker()) {
    log.error('Docker is not installed or not running');
    log.dim('Install Docker: https://docs.docker.com/get-docker/');
    process.exit(1);
  }

  const composePath = findDockerCompose();
  if (!composePath) {
    log.error('No cogitator.yml or docker-compose.yml found');
    log.dim('Run "cogitator wizard" to create an assistant config');
    process.exit(1);
  }

  const composeDir = dirname(composePath);
  log.dim(`Using: ${composePath}`);

  if (options.pull) {
    const pullSpinner = ora('Pulling latest images...').start();
    try {
      execFileSync('docker', ['compose', 'pull'], { cwd: composeDir, stdio: 'pipe' });
      pullSpinner.succeed('Images pulled');
    } catch (error) {
      pullSpinner.fail('Failed to pull images');
      log.error(error instanceof Error ? error.message : String(error));
    }
  }

  if (!options.detach) {
    const proc = spawn('docker', ['compose', 'up'], { cwd: composeDir, stdio: 'inherit' });
    proc.on('error', (error) => {
      log.error(`Failed to run docker compose up: ${error.message}`);
      process.exit(1);
    });
    proc.on('exit', (code, signal) => process.exit(exitCodeFor(code, signal)));
    return;
  }

  const spinner = ora('Starting services...').start();
  try {
    execFileSync('docker', ['compose', 'up', '-d'], { cwd: composeDir, stdio: 'pipe' });
    spinner.succeed('Services started');
  } catch (error) {
    spinner.fail('Failed to start services');
    log.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  printComposeServices(composeDir);

  console.log();
  log.dim('Commands:');
  console.log('  cogitator status   - Show service status');
  console.log('  cogitator logs -f  - Follow service logs');
  console.log('  cogitator down     - Stop services');
  console.log();
}

export const upCommand = new Command('up')
  .description('Start assistant from cogitator.yml, or Docker Compose services')
  .option('-c, --config <path>', 'Assistant config file (default: ./cogitator.yml)')
  .option('-d, --detach', 'Run Docker services in background (default)', true)
  .option('--no-detach', 'Run Docker services in foreground')
  .option('--pull', 'Pull latest images before starting')
  .option('--no-restart-loop', 'Do not supervise the assistant for self-config restarts')
  .action(
    async (options: { config?: string; detach: boolean; pull?: boolean; restartLoop: boolean }) => {
      if (options.config) {
        const explicit = resolvePath(process.cwd(), options.config);
        if (!existsSync(explicit)) {
          log.error(`Config not found: ${explicit}`);
          process.exit(1);
        }
        await startAssistant(explicit, options.restartLoop);
        return;
      }

      const configPath = findAssistantConfig();
      if (configPath) {
        await startAssistant(configPath, options.restartLoop);
        return;
      }

      await startComposeServices(options);
    }
  );

export const downCommand = new Command('down')
  .description('Stop Docker services')
  .option('-v, --volumes', 'Remove volumes (deletes data)')
  .action((options: { volumes?: boolean }) => {
    const composePath = findDockerCompose();
    if (!composePath) {
      log.error('No docker-compose.yml found');
      process.exit(1);
    }

    const composeDir = dirname(composePath);
    const spinner = ora('Stopping services...').start();

    try {
      const args = ['compose', 'down'];
      if (options.volumes) args.push('-v');
      execFileSync('docker', args, { cwd: composeDir, stdio: 'pipe' });
      spinner.succeed('Services stopped');
    } catch (error) {
      spinner.fail('Failed to stop services');
      log.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
