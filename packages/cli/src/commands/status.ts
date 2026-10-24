/**
 * cogitator status - show service status
 */

import { Command } from 'commander';
import { dirname } from 'node:path';
import chalk from 'chalk';
import { log } from '../utils/logger.js';
import { errorMessage, examplesHelp, printJson } from '../utils/cli.js';
import { findDockerCompose, checkDocker, composePs } from '../utils/docker.js';
import {
  listOllamaModels,
  resolveOllamaConnection,
  resolveOllamaUrl,
  type OllamaConnection,
} from '../utils/ollama.js';

/**
 * The connection `status` reports when the project config cannot be read: the
 * environment alone, so an unrelated invalid config, a missing config file or a
 * provider key that is not set never stops the command from reporting what it can.
 */
function environmentConnection(): OllamaConnection {
  const apiKey = process.env.OLLAMA_API_KEY;
  return { baseUrl: resolveOllamaUrl(process.env), ...(apiKey ? { apiKey } : {}) };
}

async function checkOllama(
  baseUrl: string,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined
): Promise<boolean> {
  try {
    await listOllamaModels(baseUrl, {
      apiKey,
      headers,
      timeoutMs: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

export interface ServiceState {
  name: string;
  state: string;
  running: boolean;
  health?: string;
  status: string;
}

/** What `cogitator status` reports, the same data for the terminal and `--json`. */
export interface StatusReport {
  docker: {
    available: boolean;
    compose?: string;
    services: ServiceState[];
    error?: string;
  };
  ollama: { url: string; running: boolean };
}

export async function collectStatus(): Promise<StatusReport> {
  const available = checkDocker();
  const composePath = available ? findDockerCompose() : null;
  const docker: StatusReport['docker'] = { available, services: [] };
  if (composePath) {
    docker.compose = composePath;
    try {
      docker.services = composePs(dirname(composePath)).map((svc) => ({
        name: svc.Name,
        state: svc.State,
        running: svc.State === 'running',
        ...(svc.Health && { health: svc.Health }),
        status: svc.Status,
      }));
    } catch (error) {
      docker.error = errorMessage(error).split('\n')[0];
    }
  }
  let connection: OllamaConnection;
  try {
    connection = resolveOllamaConnection();
  } catch (error) {
    log.warn(`Cannot read the Ollama configuration: ${errorMessage(error).split('\n')[0]}`);
    log.dim('Reporting the environment only (OLLAMA_BASE_URL, OLLAMA_API_KEY)');
    connection = environmentConnection();
  }
  return {
    docker,
    ollama: {
      url: connection.baseUrl,
      running: await checkOllama(connection.baseUrl, connection.apiKey, connection.headers),
    },
  };
}

function printStatus(report: StatusReport): void {
  console.log();
  log.info('Cogitator Services Status');
  console.log();

  if (!report.docker.available) {
    log.warn('Docker is not running, skipping Docker Compose services');
    log.dim('Start Docker Desktop or run: sudo systemctl start docker');
    console.log();
  } else if (report.docker.error) {
    log.warn('Failed to query docker compose services');
    log.dim(report.docker.error);
    console.log();
  } else if (report.docker.compose) {
    if (report.docker.services.length === 0) {
      log.warn('No services running');
      log.dim('Run "cogitator up" to start services');
    } else {
      console.log(chalk.dim('  Docker Compose Services:'));
      console.log();
      for (const svc of report.docker.services) {
        const icon = svc.running ? chalk.green('●') : chalk.red('○');
        const state = svc.running ? chalk.green(svc.state) : chalk.red(svc.state);
        const health = svc.health ? chalk.dim(` (${svc.health})`) : '';
        console.log(`  ${icon} ${svc.name.padEnd(20)} ${state}${health}  ${chalk.dim(svc.status)}`);
      }
      console.log();
    }
  }

  console.log(chalk.dim('  External Services:'));
  console.log();
  const { ollama } = report;
  const icon = ollama.running ? chalk.green('●') : chalk.red('○');
  const state = ollama.running ? chalk.green('running') : chalk.red('stopped');
  console.log(`  ${icon} ${'Ollama'.padEnd(20)} ${state}  ${chalk.dim(ollama.url)}`);
  console.log();
  if (!ollama.running) log.dim('Tip: Start Ollama with "ollama serve" or via Docker');
}

export const statusCommand = new Command('status')
  .alias('ps')
  .description('Show status of Cogitator services')
  .option('--json', 'print the services as JSON')
  .addHelpText(
    'after',
    examplesHelp([
      ['cogitator status', 'Docker Compose services and Ollama'],
      ['cogitator status --json', 'the same for scripts'],
    ])
  )
  .action(async (options: { json?: boolean }) => {
    const report = await collectStatus();
    if (options.json) printJson({ ok: true, ...report });
    else printStatus(report);
  });
