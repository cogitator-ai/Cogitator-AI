/**
 * cogitator logs - view service logs
 */

import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { log } from '../utils/logger.js';
import { findDockerCompose } from '../utils/docker.js';

interface LogsOptions {
  follow: boolean;
  tail: string;
  timestamps: boolean;
}

export const logsCommand = new Command('logs')
  .description('View logs from Docker services')
  .argument('[service]', 'Service name (redis, postgres, ollama)')
  .option('-f, --follow', 'Follow log output', false)
  .option('-n, --tail <lines>', 'Number of lines to show', '100')
  .option('-t, --timestamps', 'Show timestamps', false)
  .action((service: string | undefined, options: LogsOptions) => {
    const composePath = findDockerCompose();

    if (!composePath) {
      log.error('No docker-compose.yml found');
      log.dim('Run "cogitator init <name>" to create a project');
      process.exit(1);
    }

    const composeDir = dirname(composePath);
    const args = ['compose', 'logs'];

    if (options.follow) args.push('-f');
    if (options.tail) args.push('--tail', options.tail);
    if (options.timestamps) args.push('-t');

    if (service) {
      args.push(service);
    }

    const proc = spawn('docker', args, {
      cwd: composeDir,
      stdio: 'inherit',
    });

    proc.on('error', (err) => {
      log.error(`Failed to run docker compose logs: ${err.message}`);
      process.exit(1);
    });

    proc.on('exit', (code) => {
      process.exit(code ?? 0);
    });
  });
