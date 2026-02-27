import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { log, printBanner } from '../utils/logger.js';

export const assistantCommand = new Command('assistant')
  .description('Start AI assistant with live dashboard')
  .option('-c, --config <path>', 'Path to gateway config file', 'src/gateway.ts')
  .option('-q, --quiet', 'Minimal output')
  .action(async (options: { config: string; quiet: boolean }) => {
    if (!options.quiet) printBanner();

    const configPath = resolve(process.cwd(), options.config);

    if (!existsSync(configPath)) {
      log.error(`Config not found: ${configPath}`);
      log.dim('Run "cogitator init" to create a project first');
      process.exit(1);
    }

    log.info(`Loading config from ${chalk.dim(options.config)}`);

    let gatewayModule: { gateway?: GatewayLike };
    try {
      gatewayModule = await importConfig(configPath);
    } catch (err) {
      log.error(`Failed to load config: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    const gateway = gatewayModule.gateway;
    if (!gateway) {
      log.error('Config file must export a "gateway" instance');
      log.dim('Example: export const gateway = new Gateway({ ... })');
      process.exit(1);
    }

    try {
      await gateway.start();
    } catch (err) {
      log.error(`Failed to start: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    printDashboard(gateway, options.quiet);

    const shutdown = async () => {
      console.log();
      log.info('Shutting down gracefully...');
      await gateway.stop();
      log.success('All channels stopped');
      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());

    if (!options.quiet) {
      startLiveLog(gateway);
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
      chalk.cyan('                               │')
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

  if (!quiet) {
    console.log(
      chalk.dim('  Hotkeys: ') +
        chalk.dim.bold('s') +
        chalk.dim(' sessions  ') +
        chalk.dim.bold('c') +
        chalk.dim(' channels  ') +
        chalk.dim.bold('p') +
        chalk.dim(' pause  ') +
        chalk.dim.bold('q') +
        chalk.dim(' quit')
    );
    console.log(chalk.dim('  ─── Live ─────────────────────────────────────'));
    console.log();
  }
}

let paused = false;

function startHotkeys(gateway: GatewayLike, shutdown: () => Promise<void>): void {
  if (!process.stdin.isTTY) return;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (key: string) => {
    if (key === '\u0003') {
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
        const stats = gateway.stats;
        console.log();
        console.log(chalk.bold('  Channels'));
        for (const ch of stats.connectedChannels) {
          const icon = paused ? chalk.yellow('⏸') : chalk.green('✓');
          console.log(`  ${icon} ${ch}`);
        }
        console.log();
        break;
      }

      case 'p': {
        paused = !paused;
        if (paused) {
          console.log();
          log.warn('Channels paused — incoming messages will be queued');
          console.log();
        } else {
          console.log();
          log.success('Channels resumed');
          console.log();
        }
        break;
      }

      case 'q': {
        void shutdown();
        break;
      }

      case 'h':
      case '?': {
        console.log();
        console.log(chalk.bold('  Hotkeys'));
        console.log(`  ${chalk.bold('s')}  Show sessions`);
        console.log(`  ${chalk.bold('c')}  Show channels`);
        console.log(`  ${chalk.bold('p')}  Pause/resume channels`);
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

function startLiveLog(gateway: GatewayLike): void {
  const startTime = Date.now();

  const statusInterval = setInterval(() => {
    const stats = gateway.stats;
    const uptime = formatUptime(Date.now() - startTime);

    process.stdout.write(`\r${chalk.dim(`  ↑ ${uptime} · ${stats.messagesToday} msgs`)}    `);
  }, 5000);

  process.on('exit', () => clearInterval(statusInterval));
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);

  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

async function importConfig(configPath: string): Promise<{ gateway?: GatewayLike }> {
  if (configPath.endsWith('.ts')) {
    try {
      // @ts-expect-error tsx is an optional runtime loader
      await import('tsx');
    } catch {
      log.warn('tsx not found. Install it for TypeScript config support: pnpm add -D tsx');
    }
  }

  const url = `file://${configPath}`;
  return import(url);
}

interface GatewayLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  stats: {
    uptime: number;
    activeSessions: number;
    totalSessions: number;
    messagesToday: number;
    connectedChannels: string[];
  };
}
