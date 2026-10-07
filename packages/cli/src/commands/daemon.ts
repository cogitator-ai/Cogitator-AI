import { Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { log } from '../utils/logger.js';
import { CommandError, exitWithFailure, examplesHelp } from '../utils/cli.js';
import {
  DAEMON_LABEL,
  SYSTEMD_UNIT,
  buildLaunchdPlist,
  buildSystemdUnit,
  isDaemonProcess,
  isProcessAlive,
  readPidRecord,
  resolveDaemonLaunch,
  serializePidRecord,
  type DaemonLaunch,
  type DaemonPidRecord,
} from '../utils/daemon.js';

const STOP_POLL_MS = 500;
const STOP_ATTEMPTS = 20;

function dataDir(): string {
  return resolve(process.cwd(), '.cogitator');
}

function pidFile(): string {
  return resolve(dataDir(), 'daemon.pid');
}

function logFile(): string {
  return resolve(dataDir(), 'daemon.log');
}

function removePidFile(): void {
  if (existsSync(pidFile())) unlinkSync(pidFile());
}

function cliEntry(): string {
  const entry = process.argv[1];
  if (!entry) throw new Error('Cannot determine the cogitator CLI entry point');
  try {
    return realpathSync(entry);
  } catch {
    return resolve(entry);
  }
}

function resolveLaunch(config: string | undefined): DaemonLaunch {
  try {
    return resolveDaemonLaunch({
      cwd: process.cwd(),
      nodePath: process.execPath,
      cliEntry: cliEntry(),
      config,
    });
  } catch (error) {
    throw new CommandError(error instanceof Error ? error.message : String(error), {
      hints: ['Run "cogitator init" or "cogitator wizard" to create a project first'],
    });
  }
}

function runningDaemon(): DaemonPidRecord | null {
  const record = readPidRecord(pidFile());
  if (!record) return null;
  return isDaemonProcess(record) ? record : null;
}

function sendSignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function stopDaemon(record: DaemonPidRecord): Promise<'stopped' | 'killed'> {
  sendSignal(record.pid, 'SIGTERM');

  for (let attempt = 0; attempt < STOP_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, STOP_POLL_MS));
    if (!isProcessAlive(record.pid)) {
      removePidFile();
      return 'stopped';
    }
  }

  sendSignal(record.pid, 'SIGKILL');
  removePidFile();
  return 'killed';
}

function startDaemon(config: string | undefined): void {
  const existing = runningDaemon();
  if (existing) {
    log.warn(`Daemon already running (PID: ${existing.pid})`);
    log.dim('Use "cogitator daemon restart" to restart');
    return;
  }

  const launch = resolveLaunch(config);
  mkdirSync(dataDir(), { recursive: true });

  const out = openSync(logFile(), 'a');
  let pid: number | undefined;
  try {
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: ['ignore', out, out],
      cwd: process.cwd(),
      env: { ...process.env, COGITATOR_DAEMON: '1' },
    });
    child.on('error', (error) => {
      log.error(`Failed to start daemon: ${error.message}`);
      removePidFile();
      process.exitCode = 1;
    });
    pid = child.pid;
    child.unref();
  } finally {
    closeSync(out);
  }

  if (!pid) {
    throw new CommandError('Failed to start daemon');
  }

  writeFileSync(pidFile(), serializePidRecord({ pid, script: launch.args[0] }));
  log.success(`Daemon started (PID: ${pid})`);
  log.dim(`Running ${launch.description}`);
  log.dim(`Logs: ${logFile()}`);
}

function parseLineCount(value: string): string {
  if (/^\d+$/.test(value)) return value;
  throw new InvalidArgumentError('Expected a non-negative number of lines.');
}

function formatRss(kb: number): string {
  if (kb < 1024) return `${kb} KB`;
  return `${(kb / 1024).toFixed(0)} MB`;
}

function psField(pid: number, field: 'etime' | 'rss'): string | null {
  if (process.platform === 'win32') return null;
  try {
    const output = execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

export const daemonCommand = new Command('daemon')
  .description('Manage background daemon process')
  .addHelpText(
    'after',
    examplesHelp([
      ['cogitator daemon install', 'run the assistant at login (launchd or systemd)'],
      ['cogitator daemon start', 'start it in the background now'],
      ['cogitator daemon logs -f', 'follow its output'],
    ])
  );

daemonCommand
  .command('start')
  .description('Start the assistant as a background daemon')
  .option(
    '-c, --config <path>',
    'Entry to run: cogitator.yml, a gateway module, or a bundle (default: auto-detect)'
  )
  .action((options: { config?: string }) => {
    startDaemon(options.config);
  });

daemonCommand
  .command('stop')
  .description('Stop the running daemon')
  .action(async () => {
    const record = runningDaemon();
    if (!record) {
      log.warn('Daemon is not running');
      removePidFile();
      return;
    }

    log.step(`Sending SIGTERM to daemon (PID: ${record.pid})`);
    const result = await stopDaemon(record);
    if (result === 'stopped') {
      log.success('Daemon stopped');
    } else {
      log.warn('Daemon did not stop gracefully and was killed');
    }
  });

daemonCommand
  .command('restart')
  .description('Restart the daemon')
  .option(
    '-c, --config <path>',
    'Entry to run: cogitator.yml, a gateway module, or a bundle (default: auto-detect)'
  )
  .action(async (options: { config?: string }) => {
    const record = runningDaemon();
    if (record) {
      log.step('Stopping current daemon...');
      await stopDaemon(record);
    } else {
      removePidFile();
    }

    log.step('Starting daemon...');
    startDaemon(options.config);
  });

daemonCommand
  .command('status')
  .description('Show daemon status')
  .action(() => {
    const record = readPidRecord(pidFile());
    const running = record ? isDaemonProcess(record) : false;

    console.log();
    console.log(chalk.cyan('  ╭──────────────────────────────────────────╮'));
    console.log(
      chalk.cyan('  │  ') + chalk.bold('Cogitator Daemon') + chalk.cyan('                        │')
    );
    console.log(chalk.cyan('  ╰──────────────────────────────────────────╯'));
    console.log();

    if (running && record) {
      const rss = Number(psField(record.pid, 'rss'));
      console.log(`  ${chalk.bold('Status')}   ${chalk.green('● running')}`);
      console.log(`  ${chalk.bold('PID')}      ${record.pid}`);
      console.log(`  ${chalk.bold('Uptime')}   ${psField(record.pid, 'etime') ?? 'unknown'}`);
      console.log(
        `  ${chalk.bold('Memory')}   ${Number.isFinite(rss) && rss > 0 ? formatRss(rss) : 'unknown'}`
      );
    } else {
      console.log(`  ${chalk.bold('Status')}   ${chalk.red('● stopped')}`);
      if (record) {
        log.dim(`  Stale PID file found (${record.pid}), cleaning up`);
        removePidFile();
      }
    }

    console.log(`  ${chalk.bold('Logs')}     ${logFile()}`);
    console.log(`  ${chalk.bold('PID file')} ${pidFile()}`);
    console.log();
  });

daemonCommand
  .command('logs')
  .description('Tail daemon logs')
  .option('-n, --lines <number>', 'Number of lines to show', parseLineCount, '50')
  .option('-f, --follow', 'Follow log output', false)
  .action((options: { lines: string; follow: boolean }) => {
    if (!existsSync(logFile())) {
      log.warn('No log file found');
      log.dim(`Expected at: ${logFile()}`);
      return;
    }

    const args = ['-n', options.lines];
    if (options.follow) args.push('-f');
    args.push(logFile());

    const tail = spawn('tail', args, { stdio: 'inherit' });
    tail.on('error', (error) => {
      exitWithFailure(new CommandError(`Failed to run tail: ${error.message}`));
    });
    tail.on('exit', (code) => process.exit(code ?? 0));
  });

daemonCommand
  .command('install')
  .description('Install as a user service (launchd on macOS, systemd on Linux)')
  .option(
    '-c, --config <path>',
    'Entry to run: cogitator.yml, a gateway module, or a bundle (default: auto-detect)'
  )
  .action((options: { config?: string }) => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new CommandError(`Unsupported platform: ${process.platform}`, {
        hints: ['Manual setup required for Windows'],
      });
    }

    const launch = resolveLaunch(options.config);
    mkdirSync(dataDir(), { recursive: true });
    const definition = {
      launch,
      cwd: process.cwd(),
      logFile: logFile(),
      path: process.env.PATH,
    };

    if (process.platform === 'darwin') {
      installLaunchd(buildLaunchdPlist(definition));
    } else {
      installSystemd(buildSystemdUnit(definition));
    }
  });

daemonCommand
  .command('uninstall')
  .description('Remove the user service')
  .action(() => {
    if (process.platform === 'darwin') {
      uninstallLaunchd();
    } else if (process.platform === 'linux') {
      uninstallSystemd();
    } else {
      throw new CommandError(`Unsupported platform: ${process.platform}`);
    }
  });

function launchdPlistPath(): string {
  return resolve(homedir(), 'Library/LaunchAgents', `${DAEMON_LABEL}.plist`);
}

function systemdUnitPath(): string {
  return resolve(homedir(), '.config/systemd/user', `${SYSTEMD_UNIT}.service`);
}

function tryExec(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function installLaunchd(plist: string): void {
  const plistPath = launchdPlistPath();
  mkdirSync(dirname(plistPath), { recursive: true });

  if (existsSync(plistPath)) tryExec('launchctl', ['unload', plistPath]);
  writeFileSync(plistPath, plist);
  log.success(`Plist written to ${plistPath}`);

  if (tryExec('launchctl', ['load', '-w', plistPath])) {
    log.success('Service installed and loaded');
    log.dim(`Manage: launchctl start/stop ${DAEMON_LABEL}`);
    log.dim(`Logs:   ${logFile()}`);
  } else {
    log.warn('Failed to load service. Load manually:');
    log.dim(`  launchctl load -w "${plistPath}"`);
  }
}

function uninstallLaunchd(): void {
  const plistPath = launchdPlistPath();

  if (!existsSync(plistPath)) {
    log.warn('Service not installed');
    return;
  }

  tryExec('launchctl', ['unload', '-w', plistPath]);
  unlinkSync(plistPath);
  log.success('Service removed');
}

function installSystemd(unit: string): void {
  const unitPath = systemdUnitPath();
  mkdirSync(dirname(unitPath), { recursive: true });

  writeFileSync(unitPath, unit);
  log.success(`Unit file written to ${unitPath}`);

  if (
    tryExec('systemctl', ['--user', 'daemon-reload']) &&
    tryExec('systemctl', ['--user', 'enable', SYSTEMD_UNIT])
  ) {
    log.success('Service enabled (starts on login)');
    log.dim(`  systemctl --user start ${SYSTEMD_UNIT}    Start now`);
    log.dim(`  systemctl --user status ${SYSTEMD_UNIT}   Check status`);
    log.dim(`  Logs: ${logFile()}`);
    log.dim('  Run "loginctl enable-linger" to keep it running after logout');
  } else {
    log.warn('Failed to enable service. Enable manually:');
    log.dim('  systemctl --user daemon-reload');
    log.dim(`  systemctl --user enable --now ${SYSTEMD_UNIT}`);
  }
}

function uninstallSystemd(): void {
  const unitPath = systemdUnitPath();

  if (!existsSync(unitPath)) {
    log.warn('Service not installed');
    return;
  }

  tryExec('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
  unlinkSync(unitPath);
  tryExec('systemctl', ['--user', 'daemon-reload']);

  log.success('Service removed');
}
