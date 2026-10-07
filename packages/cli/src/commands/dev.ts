import { Command } from 'commander';
import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { startStudio, type StudioHandle } from '@cogitator-ai/studio';
import { examplesHelp, UsageError } from '../utils/cli.js';
import { log } from '../utils/logger.js';

export interface DevFlags {
  port?: string;
  host?: string;
  open?: boolean;
  watch?: boolean;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new UsageError(`--port takes a port number, got "${value}"`);
  return port;
}

/** Opens `url` in the default browser; a failure is only reported. */
export function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => log.dim(`Open ${url} in your browser`));
    child.unref();
  } catch {
    log.dim(`Open ${url} in your browser`);
  }
}

/** Starts Cogitator Studio for the project in `projectDir` and resolves once it listens. */
export async function runDev(projectDir: string, flags: DevFlags): Promise<StudioHandle> {
  const studio = await startStudio({
    projectDir,
    ...(flags.host && { host: flags.host }),
    ...(flags.port !== undefined && { port: parsePort(flags.port), strictPort: true }),
    watch: flags.watch !== false,
    log: (line, stream) => {
      const prefix = chalk.dim('project ›');
      if (stream === 'stderr') console.error(prefix, line);
      else console.log(prefix, line);
    },
  });
  console.log();
  console.log(`  ${chalk.bold('Cogitator Studio')}  ${chalk.cyan(studio.url)}`);
  if (studio.token) {
    console.log(
      chalk.yellow(
        '  Reachable from other machines: share the URL only with people who may run your agents.'
      )
    );
  }
  console.log(
    chalk.dim(
      '  Chat with agents, read traces and costs, approve tool calls, run workflows, fork runs.'
    )
  );
  console.log(chalk.dim('  The project reloads when you save. Ctrl+C stops the studio.'));
  console.log();
  studio.ready().then(
    () => {
      const status = studio.hostStatus();
      if (status.state === 'ready') {
        const { agents, workflows, swarms } = status.registry;
        log.success(
          `Loaded ${agents.length} agent${agents.length === 1 ? '' : 's'}, ${workflows.length} workflow${workflows.length === 1 ? '' : 's'}, ${swarms.length} swarm${swarms.length === 1 ? '' : 's'}`
        );
      }
    },
    (error: unknown) =>
      log.error(
        `The project does not load: ${error instanceof Error ? error.message : String(error)}`
      )
  );
  return studio;
}

export const devCommand = new Command('dev')
  .description(
    'Open Cogitator Studio: chat with agents, traces and costs, approvals, workflow runs and forks'
  )
  .option('-p, --port <port>', 'port to listen on (default 4321, the next free one)')
  .option('--host <host>', 'interface to listen on; anything but localhost needs the printed token')
  .option('--no-open', 'do not open the browser')
  .option('--no-watch', 'do not reload the project when files change')
  .addHelpText(
    'after',
    examplesHelp([
      ['cogitator dev', 'the studio for the project in this directory'],
      ['cogitator dev --port 4400 --no-open', 'a fixed port, no browser'],
      ['cogitator dev --host 0.0.0.0', 'reachable from your network, with a token'],
    ])
  )
  .action(async (flags: DevFlags) => {
    const studio = await runDev(process.cwd(), flags);
    if (flags.open !== false && !process.env.CI) openBrowser(studio.url);
    const stop = () => {
      void studio.close().finally(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
