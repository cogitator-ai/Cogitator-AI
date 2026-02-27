import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { log } from '../utils/logger.js';

const DATA_DIR = resolve(process.cwd(), '.cogitator');
const PID_FILE = resolve(DATA_DIR, 'daemon.pid');
const LOG_FILE = resolve(DATA_DIR, 'daemon.log');

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
  if (isNaN(pid)) return null;
  return pid;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getProcessUptime(pid: number): string | null {
  try {
    const output = execSync(`ps -o etime= -p ${pid}`, { encoding: 'utf-8' }).trim();
    return output;
  } catch {
    return null;
  }
}

function getProcessMemory(pid: number): string | null {
  try {
    const rss = execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf-8' }).trim();
    const kb = parseInt(rss, 10);
    if (isNaN(kb)) return null;
    if (kb < 1024) return `${kb} KB`;
    return `${(kb / 1024).toFixed(0)} MB`;
  } catch {
    return null;
  }
}

export const daemonCommand = new Command('daemon').description('Manage background daemon process');

daemonCommand
  .command('start')
  .description('Start the assistant as a background daemon')
  .option('-c, --config <path>', 'Path to gateway config file', 'src/gateway.ts')
  .action(async (options: { config: string }) => {
    const existingPid = readPid();
    if (existingPid && isRunning(existingPid)) {
      log.warn(`Daemon already running (PID: ${existingPid})`);
      log.dim('Use "cogitator daemon restart" to restart');
      return;
    }

    const configPath = resolve(process.cwd(), options.config);
    if (!existsSync(configPath)) {
      log.error(`Config not found: ${configPath}`);
      log.dim('Run "cogitator init" to create a project first');
      process.exit(1);
    }

    ensureDataDir();

    const bundled = resolve(process.cwd(), 'dist/cogitator.mjs');
    const entryPoint = existsSync(bundled) ? bundled : configPath;

    const useTsx = entryPoint.endsWith('.ts');
    const nodeArgs: string[] = [];
    if (useTsx) {
      nodeArgs.push('--import', 'tsx');
    }

    const child = spawn('node', [...nodeArgs, entryPoint], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd(),
      env: { ...process.env, COGITATOR_DAEMON: '1' },
    });

    if (child.stdout && child.stderr) {
      const { createWriteStream } = await import('node:fs');
      const logStream = createWriteStream(LOG_FILE, { flags: 'a' });
      child.stdout.pipe(logStream);
      child.stderr.pipe(logStream);
    }

    child.unref();

    if (child.pid) {
      writeFileSync(PID_FILE, String(child.pid));
      log.success(`Daemon started (PID: ${child.pid})`);
      if (useTsx) {
        log.dim('Using tsx for TypeScript support');
      }
      if (entryPoint === bundled) {
        log.dim('Using bundled version from dist/');
      }
      log.dim(`Logs: ${LOG_FILE}`);
    } else {
      log.error('Failed to start daemon');
      process.exit(1);
    }
  });

daemonCommand
  .command('stop')
  .description('Stop the running daemon')
  .action(() => {
    const pid = readPid();
    if (!pid || !isRunning(pid)) {
      log.warn('Daemon is not running');
      if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
      return;
    }

    process.kill(pid, 'SIGTERM');
    log.success(`Sent SIGTERM to daemon (PID: ${pid})`);

    let attempts = 0;
    const check = setInterval(() => {
      attempts++;
      if (!isRunning(pid)) {
        clearInterval(check);
        if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
        log.success('Daemon stopped');
        return;
      }
      if (attempts >= 10) {
        clearInterval(check);
        log.warn('Daemon did not stop gracefully, sending SIGKILL');
        process.kill(pid, 'SIGKILL');
        if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
        log.success('Daemon killed');
      }
    }, 500);
  });

daemonCommand
  .command('restart')
  .description('Restart the daemon')
  .option('-c, --config <path>', 'Path to gateway config file', 'src/gateway.ts')
  .action(async (options: { config: string }) => {
    const pid = readPid();
    if (pid && isRunning(pid)) {
      process.kill(pid, 'SIGTERM');
      log.step('Stopping current daemon...');

      await new Promise<void>((resolve) => {
        let attempts = 0;
        const check = setInterval(() => {
          attempts++;
          if (!isRunning(pid) || attempts >= 10) {
            clearInterval(check);
            if (attempts >= 10) {
              process.kill(pid, 'SIGKILL');
            }
            resolve();
          }
        }, 500);
      });

      if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    }

    log.step('Starting daemon...');
    const startCmd = daemonCommand.commands.find((c) => c.name() === 'start');
    if (startCmd) {
      await startCmd.parseAsync(['node', 'start', '-c', options.config]);
    }
  });

daemonCommand
  .command('status')
  .description('Show daemon status')
  .action(() => {
    const pid = readPid();
    const running = pid ? isRunning(pid) : false;

    console.log();
    console.log(chalk.cyan('  ╭──────────────────────────────────────────╮'));
    console.log(
      chalk.cyan('  │  ') +
        chalk.bold('Cogitator Daemon') +
        chalk.cyan('                         │')
    );
    console.log(chalk.cyan('  ╰──────────────────────────────────────────╯'));
    console.log();

    if (running && pid) {
      const uptime = getProcessUptime(pid) ?? 'unknown';
      const memory = getProcessMemory(pid) ?? 'unknown';

      console.log(`  ${chalk.bold('Status')}   ${chalk.green('● running')}`);
      console.log(`  ${chalk.bold('PID')}      ${pid}`);
      console.log(`  ${chalk.bold('Uptime')}   ${uptime.trim()}`);
      console.log(`  ${chalk.bold('Memory')}   ${memory}`);
    } else {
      console.log(`  ${chalk.bold('Status')}   ${chalk.red('● stopped')}`);
      if (pid) {
        log.dim(`  Stale PID file found (${pid}), cleaning up`);
        if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
      }
    }

    console.log(`  ${chalk.bold('Logs')}     ${LOG_FILE}`);
    console.log(`  ${chalk.bold('PID file')} ${PID_FILE}`);
    console.log();
  });

daemonCommand
  .command('logs')
  .description('Tail daemon logs')
  .option('-n, --lines <number>', 'Number of lines to show', '50')
  .option('-f, --follow', 'Follow log output', false)
  .option('--json', 'Output raw JSON logs')
  .action((options: { lines: string; follow: boolean; json: boolean }) => {
    if (!existsSync(LOG_FILE)) {
      log.warn('No log file found');
      log.dim(`Expected at: ${LOG_FILE}`);
      return;
    }

    const args = ['-n', options.lines];
    if (options.follow) args.push('-f');
    args.push(LOG_FILE);

    const tail = spawn('tail', args, { stdio: 'inherit' });
    tail.on('exit', (code) => process.exit(code ?? 0));
  });

daemonCommand
  .command('install')
  .description('Install as system service (launchd on macOS, systemd on Linux)')
  .action(() => {
    const platform = process.platform;

    if (platform === 'darwin') {
      installLaunchd();
    } else if (platform === 'linux') {
      installSystemd();
    } else {
      log.error(`Unsupported platform: ${platform}`);
      log.dim('Manual setup required for Windows');
    }
  });

daemonCommand
  .command('uninstall')
  .description('Remove system service')
  .action(() => {
    const platform = process.platform;

    if (platform === 'darwin') {
      uninstallLaunchd();
    } else if (platform === 'linux') {
      uninstallSystemd();
    } else {
      log.error(`Unsupported platform: ${platform}`);
    }
  });

function installLaunchd(): void {
  const label = 'ai.cogitator.daemon';
  const plistPath = resolve(process.env.HOME ?? '~', `Library/LaunchAgents/${label}.plist`);
  const cwd = process.cwd();
  const nodePath = process.execPath;

  const bundled = resolve(cwd, 'dist/cogitator.mjs');
  const configPath = resolve(cwd, 'src/gateway.ts');
  const entryPoint = existsSync(bundled) ? bundled : configPath;

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${entryPoint}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${cwd}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>COGITATOR_DAEMON</key>
    <string>1</string>
  </dict>
</dict>
</plist>`;

  const plistDir = dirname(plistPath);
  if (!existsSync(plistDir)) {
    mkdirSync(plistDir, { recursive: true });
  }

  writeFileSync(plistPath, plist);
  log.success(`Plist written to ${plistPath}`);

  try {
    execSync(`launchctl load ${plistPath}`);
    log.success('Service installed and loaded');
    log.dim(`Manage: launchctl start/stop ${label}`);
  } catch {
    log.warn('Failed to load service. Load manually:');
    log.dim(`  launchctl load ${plistPath}`);
  }
}

function uninstallLaunchd(): void {
  const label = 'ai.cogitator.daemon';
  const plistPath = resolve(process.env.HOME ?? '~', `Library/LaunchAgents/${label}.plist`);

  if (!existsSync(plistPath)) {
    log.warn('Service not installed');
    return;
  }

  try {
    execSync(`launchctl unload ${plistPath}`);
  } catch {}

  unlinkSync(plistPath);
  log.success('Service removed');
}

function installSystemd(): void {
  const cwd = process.cwd();
  const nodePath = process.execPath;

  const bundled = resolve(cwd, 'dist/cogitator.mjs');
  const configPath = resolve(cwd, 'src/gateway.ts');
  const entryPoint = existsSync(bundled) ? bundled : configPath;

  const unit = `[Unit]
Description=Cogitator AI Assistant
After=network.target

[Service]
Type=simple
WorkingDirectory=${cwd}
ExecStart=${nodePath} ${entryPoint}
Restart=always
RestartSec=5
Environment=COGITATOR_DAEMON=1
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}

[Install]
WantedBy=multi-user.target
`;

  const unitPath = resolve(process.env.HOME ?? '~', '.config/systemd/user/cogitator.service');
  const unitDir = dirname(unitPath);
  if (!existsSync(unitDir)) {
    mkdirSync(unitDir, { recursive: true });
  }

  writeFileSync(unitPath, unit);
  log.success(`Unit file written to ${unitPath}`);

  try {
    execSync('systemctl --user daemon-reload');
    execSync('systemctl --user enable cogitator');
    log.success('Service enabled (starts on login)');
    log.dim('  systemctl --user start cogitator    Start now');
    log.dim('  systemctl --user status cogitator   Check status');
    log.dim('  journalctl --user -u cogitator -f   View logs');
  } catch {
    log.warn('Failed to enable service. Enable manually:');
    log.dim('  systemctl --user daemon-reload');
    log.dim('  systemctl --user enable --now cogitator');
  }
}

function uninstallSystemd(): void {
  const unitPath = resolve(process.env.HOME ?? '~', '.config/systemd/user/cogitator.service');

  if (!existsSync(unitPath)) {
    log.warn('Service not installed');
    return;
  }

  try {
    execSync('systemctl --user stop cogitator');
    execSync('systemctl --user disable cogitator');
  } catch {}

  unlinkSync(unitPath);

  try {
    execSync('systemctl --user daemon-reload');
  } catch {}

  log.success('Service removed');
}
