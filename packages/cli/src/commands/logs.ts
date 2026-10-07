/**
 * cogitator logs - view service logs
 */

import { Command, InvalidArgumentError } from 'commander';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { CommandError, exitWithFailure, examplesHelp } from '../utils/cli.js';
import { findDockerCompose } from '../utils/docker.js';

interface LogsOptions {
  follow: boolean;
  tail: string;
  timestamps: boolean;
}

export function parseTailOption(value: string): string {
  if (value === 'all' || /^\d+$/.test(value)) return value;
  throw new InvalidArgumentError('Expected a non-negative number of lines or "all".');
}

export const logsCommand = new Command('logs')
  .description('View logs from Docker services')
  .argument('[service]', 'Service name (redis, postgres, ollama)')
  .option('-f, --follow', 'Follow log output', false)
  .option('-n, --tail <lines>', 'Number of lines to show (or "all")', parseTailOption, '100')
  .option('-t, --timestamps', 'Show timestamps', false)
  .addHelpText(
    'after',
    examplesHelp([
      ['cogitator logs', 'the last 100 lines of every service'],
      ['cogitator logs postgres -f', 'follow one service'],
    ])
  )
  .action((service: string | undefined, options: LogsOptions) => {
    const composePath = findDockerCompose();

    if (!composePath) {
      throw new CommandError('No docker-compose.yml found', {
        hints: ['Run "cogitator init <name>" to create a project'],
      });
    }

    const composeDir = dirname(composePath);
    const args = ['compose', 'logs'];

    if (options.follow) args.push('-f');
    args.push('--tail', options.tail);
    if (options.timestamps) args.push('-t');

    if (service) {
      args.push(service);
    }

    const proc = spawn('docker', args, {
      cwd: composeDir,
      stdio: 'inherit',
    });

    proc.on('error', (err) => {
      exitWithFailure(new CommandError(`Failed to run docker compose logs: ${err.message}`));
    });

    proc.on('exit', (code) => {
      process.exit(code ?? 0);
    });
  });
