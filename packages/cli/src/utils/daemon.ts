import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export const DAEMON_LABEL = 'ai.cogitator.daemon';
export const SYSTEMD_UNIT = 'cogitator';
export const BUNDLED_ENTRY = 'dist/cogitator.mjs';
export const BUNDLE_MARKER = '__cogitatorCreateRequire';
const ASSISTANT_CONFIGS = ['cogitator.yml', 'cogitator.yaml'];
const DEFAULT_GATEWAY = 'src/gateway.ts';

export interface DaemonLaunch {
  command: string;
  args: string[];
  description: string;
}

export interface DaemonPidRecord {
  pid: number;
  script?: string;
}

export interface ResolveLaunchOptions {
  cwd: string;
  nodePath: string;
  cliEntry: string;
  config?: string;
}

export function isCogitatorBundle(path: string): boolean {
  if (!/\.[cm]?js$/i.test(path)) return false;
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(512);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString('utf-8').includes(BUNDLE_MARKER);
  } finally {
    closeSync(fd);
  }
}

function isAssistantConfig(path: string): boolean {
  return /\.ya?ml$/i.test(path);
}

function launchFor(path: string, opts: ResolveLaunchOptions): DaemonLaunch {
  if (isAssistantConfig(path)) {
    return {
      command: opts.nodePath,
      args: [opts.cliEntry, 'up', '--config', path],
      description: `assistant config ${path}`,
    };
  }
  if (isCogitatorBundle(path)) {
    return { command: opts.nodePath, args: [path], description: `bundle ${path}` };
  }
  return {
    command: opts.nodePath,
    args: [opts.cliEntry, 'assistant', '--quiet', '--config', path],
    description: `gateway config ${path}`,
  };
}

export function resolveDaemonLaunch(opts: ResolveLaunchOptions): DaemonLaunch {
  if (opts.config) {
    const explicit = isAbsolute(opts.config) ? opts.config : resolve(opts.cwd, opts.config);
    if (!existsSync(explicit)) {
      throw new Error(`Config not found: ${explicit}`);
    }
    return launchFor(explicit, opts);
  }

  const candidates = [
    resolve(opts.cwd, BUNDLED_ENTRY),
    ...ASSISTANT_CONFIGS.map((name) => resolve(opts.cwd, name)),
    resolve(opts.cwd, DEFAULT_GATEWAY),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `Nothing to run in ${opts.cwd}: expected ${BUNDLED_ENTRY}, cogitator.yml or ${DEFAULT_GATEWAY}`
    );
  }
  return launchFor(found, opts);
}

export function parsePidRecord(content: string): DaemonPidRecord | null {
  const trimmed = content.trim();
  if (/^\d+$/.test(trimmed)) {
    const pid = Number(trimmed);
    return pid > 0 ? { pid } : null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== 'object' || parsed === null || !('pid' in parsed)) return null;
    const pid = parsed.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
    const script =
      'script' in parsed && typeof parsed.script === 'string' ? parsed.script : undefined;
    return { pid, script };
  } catch {
    return null;
  }
}

export function readPidRecord(pidFile: string): DaemonPidRecord | null {
  if (!existsSync(pidFile)) return null;
  return parsePidRecord(readFileSync(pidFile, 'utf-8'));
}

export function serializePidRecord(record: DaemonPidRecord): string {
  return JSON.stringify(record) + '\n';
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function processCommandLine(pid: number): string | null {
  if (process.platform === 'win32') return null;
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function isDaemonProcess(record: DaemonPidRecord): boolean {
  if (!isProcessAlive(record.pid)) return false;
  if (!record.script) return true;
  const commandLine = processCommandLine(record.pid);
  return commandLine === null || commandLine.includes(record.script);
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface ServiceDefinition {
  launch: DaemonLaunch;
  cwd: string;
  logFile: string;
  path?: string;
}

export function buildLaunchdPlist(def: ServiceDefinition): string {
  const programArgs = [def.launch.command, ...def.launch.args]
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join('\n');
  const pathEntry = def.path
    ? `\n    <key>PATH</key>\n    <string>${escapeXml(def.path)}</string>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(def.cwd)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(def.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(def.logFile)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>COGITATOR_DAEMON</key>
    <string>1</string>${pathEntry}
  </dict>
</dict>
</plist>
`;
}

export function quoteSystemdArg(arg: string): string {
  if (/^[A-Za-z0-9_@+=:,./-]+$/.test(arg)) return arg;
  return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

function systemdPathValue(path: string): string {
  return path.replace(/%/g, '%%');
}

export function buildSystemdUnit(def: ServiceDefinition): string {
  const execStart = [def.launch.command, ...def.launch.args].map(quoteSystemdArg).join(' ');
  const pathEnv = def.path ? `\nEnvironment=${quoteSystemdArg(`PATH=${def.path}`)}` : '';

  return `[Unit]
Description=Cogitator AI Assistant
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${quoteSystemdArg(def.cwd)}
ExecStart=${execStart}
Restart=always
RestartSec=5
Environment=COGITATOR_DAEMON=1${pathEnv}
StandardOutput=append:${systemdPathValue(def.logFile)}
StandardError=append:${systemdPathValue(def.logFile)}

[Install]
WantedBy=default.target
`;
}
