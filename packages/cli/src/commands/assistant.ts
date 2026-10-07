import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { log, printBanner } from '../utils/logger.js';
import { CommandError, exitWithFailure, examplesHelp } from '../utils/cli.js';
import { importUserModule } from '../utils/module-loader.js';
import { loadDotenvInto } from '../utils/env.js';

export interface GatewayLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly stats: {
    uptime: number;
    activeSessions: number;
    totalSessions: number;
    messagesToday: number;
    connectedChannels: string[];
  };
}

export function isGatewayLike(value: unknown): value is GatewayLike {
  if (typeof value !== 'object' || value === null) return false;
  if (!('start' in value) || typeof value.start !== 'function') return false;
  if (!('stop' in value) || typeof value.stop !== 'function') return false;
  if (!('stats' in value)) return false;
  const stats = value.stats;
  return (
    typeof stats === 'object' &&
    stats !== null &&
    'connectedChannels' in stats &&
    Array.isArray(stats.connectedChannels)
  );
}

export const assistantCommand = new Command('assistant')
  .description('Start AI assistant with live dashboard')
  .option('-c, --config <path>', 'Path to gateway config file', 'src/gateway.ts')
  .option('-q, --quiet', 'Minimal output (no banner, live status or hotkeys)')
  .addHelpText(
    'after',
    examplesHelp([
      ['cogitator assistant', 'start src/gateway.ts with the live dashboard'],
      ['cogitator assistant -c src/bot.ts -q', 'another config, plain output'],
    ])
  )
  .action(async (options: { config: string; quiet?: boolean }) => {
    const quiet = options.quiet ?? false;
    if (!quiet) printBanner();

    const configPath = resolve(process.cwd(), options.config);

    if (!existsSync(configPath)) {
      throw new CommandError(`Config not found: ${configPath}`, {
        hints: ['Run "cogitator init" to create a project first'],
      });
    }

    log.info(`Loading config from ${chalk.dim(options.config)}`);
    loadDotenvInto(resolve(process.cwd(), '.env'), process.env);

    let gatewayExport: unknown;
    try {
      const mod = await importUserModule(configPath, process.cwd());
      gatewayExport = mod.gateway;
    } catch (err) {
      throw new CommandError(
        `Failed to load config: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!isGatewayLike(gatewayExport)) {
      throw new CommandError('Config file must export a "gateway" instance', {
        hints: ['Example: export const gateway = new Gateway({ ... })'],
      });
    }
    const gateway = gatewayExport;

    try {
      await gateway.start();
    } catch (err) {
      throw new CommandError(
        `Failed to start: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    printDashboard(gateway, quiet);

    let stopping = false;
    let stopLiveLog: (() => void) | null = null;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      stopLiveLog?.();
      restoreTerminal();
      console.log();
      log.info('Shutting down gracefully...');
      try {
        await gateway.stop();
        log.success('All channels stopped');
        process.exit(0);
      } catch (err) {
        exitWithFailure(
          new CommandError(`Shutdown failed: ${err instanceof Error ? err.message : String(err)}`)
        );
      }
    };

    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());

    if (!quiet) {
      stopLiveLog = startLiveLog(gateway);
      startHotkeys(gateway, shutdown);
    }
  });

function printDashboard(gateway: GatewayLike, quiet: boolean): void {
  const stats = gateway.stats;

  console.log();
  console.log(chalk.cyan('  ╭─────────────────────────────────────────────────╮'));
  console.log(
    chalk.cyan('  │  ') +
      chalk.bold('Cogitator Assistant') +
      chalk.cyan('                            │')
  );
  console.log(chalk.cyan('  ╰─────────────────────────────────────────────────╯'));
  console.log();

  console.log(chalk.bold('  Channels'));
  for (const ch of stats.connectedChannels) {
    console.log(`  ${chalk.green('✓')} ${ch}`);
  }

  console.log();
  console.log(
    chalk.dim(`  Sessions: ${stats.activeSessions} active · ${stats.totalSessions} total`)
  );
  console.log(chalk.dim(`  Messages: ${stats.messagesToday} today`));
  console.log();

  if (!quiet && process.stdin.isTTY) {
    console.log(
      chalk.dim('  Hotkeys: ') +
        chalk.dim.bold('s') +
        chalk.dim(' sessions  ') +
        chalk.dim.bold('c') +
        chalk.dim(' channels  ') +
        chalk.dim.bold('h') +
        chalk.dim(' help  ') +
        chalk.dim.bold('q') +
        chalk.dim(' quit')
    );
    console.log(chalk.dim('  ─── Live ─────────────────────────────────────'));
    console.log();
  }
}

function restoreTerminal(): void {
  if (process.stdin.isTTY && process.stdin.isRaw) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
}

function startHotkeys(gateway: GatewayLike, shutdown: () => Promise<void>): void {
  if (!process.stdin.isTTY) return;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (key: string) => {
    if (key === '\u0003' || key === 'q') {
      void shutdown();
      return;
    }

    clearLine();

    switch (key) {
      case 's': {
        const stats = gateway.stats;
        console.log();
        console.log(chalk.bold('  Sessions'));
        console.log(`  ${chalk.cyan('Active')}   ${stats.activeSessions}`);
        console.log(`  ${chalk.dim('Total')}    ${stats.totalSessions}`);
        console.log(`  ${chalk.dim('Messages')} ${stats.messagesToday} today`);
        console.log();
        break;
      }

      case 'c': {
        console.log();
        console.log(chalk.bold('  Channels'));
        for (const ch of gateway.stats.connectedChannels) {
          console.log(`  ${chalk.green('✓')} ${ch}`);
        }
        console.log();
        break;
      }

      case 'h':
      case '?': {
        console.log();
        console.log(chalk.bold('  Hotkeys'));
        console.log(`  ${chalk.bold('s')}  Show sessions`);
        console.log(`  ${chalk.bold('c')}  Show channels`);
        console.log(`  ${chalk.bold('q')}  Graceful shutdown`);
        console.log(`  ${chalk.bold('h')}  This help`);
        console.log();
        break;
      }
    }
  });
}

function clearLine(): void {
  process.stdout.write('\r\x1b[K');
}

function startLiveLog(gateway: GatewayLike): () => void {
  if (!process.stdout.isTTY) return () => {};

  const startTime = Date.now();
  const statusInterval = setInterval(() => {
    const uptime = formatUptime(Date.now() - startTime);
    process.stdout.write(
      `\r${chalk.dim(`  ↑ ${uptime} · ${gateway.stats.messagesToday} msgs`)}    `
    );
  }, 5000);
  statusInterval.unref();

  return () => clearInterval(statusInterval);
}

export function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);

  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
