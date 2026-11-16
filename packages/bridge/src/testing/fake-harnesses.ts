import { spawn, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export interface FakeCommandRun {
  command: string;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** A call of a tool of an MCP server the session has. */
export interface FakeToolRun {
  /** `<server>.<tool>` */
  tool: string;
  /** The arguments as the scripted model wrote them */
  args: Record<string, unknown>;
  /** The arguments as they reached the server, when a hook of the harness changed them */
  sent?: Record<string, unknown>;
  /** What the tool answered, or why the harness did not call it */
  text: string;
  isError: boolean;
}

export interface FakeTurn {
  turn: number;
  at: string;
  input: string;
  ran: FakeCommandRun[];
  /** The tool calls of the turn, in order */
  tools: FakeToolRun[];
  answer: string;
  wokenBy: 'prompt' | 'user' | 'hook' | 'queue' | 'exec';
}

export interface FakeClaudeSession {
  id?: string;
  sessionId: string;
  name?: string;
  cwd: string;
  kind: 'background' | 'interactive';
  status?: 'busy' | 'idle';
  state?: string;
  pid?: number;
}

export interface FakeRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface FakeRunOptions {
  cwd?: string;
  /** Added to what `env()` gives */
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed */
  input?: string;
}

export interface FakeHarnesses {
  /** The folder holding the `claude` and `codex` executables */
  readonly bin: string;
  /** Where the fakes keep their state */
  readonly home: string;
  /**
   * `base` (default `process.env`) with the fakes first on PATH and their state folder set.
   * Session id variables of a surrounding real harness (`CLAUDE_CODE_SESSION_ID`,
   * `CODEX_THREAD_ID`) are removed. The bridge's folder (`COGITATOR_BRIDGE_HOME`) and Claude
   * Code's (`CLAUDE_CONFIG_DIR`) are those the options name, or `base` when it differs there
   * from the environment of the tests themselves, and never those of the machine: otherwise
   * they are folders inside the fakes' own, so nothing under test reaches a real dispatcher or
   * reads real settings by accident
   */
  env(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /** Marks a folder as one Claude Code trusts */
  trustFolder(folder: string): void;
  /** Runs a fake command to its end */
  run(
    harness: 'claude' | 'codex',
    args: string[],
    options?: FakeRunOptions
  ): Promise<FakeRunResult>;
  /** A Claude Code session sitting idle like an open window */
  openClaudeWindow(options: {
    cwd: string;
    settings?: unknown;
    /** MCP servers of the session, as `--mcp-config` takes them: `{ mcpServers: { ... } }` */
    mcpConfig?: unknown;
    name?: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<string>;
  /** A person types into a Claude Code session */
  say(sessionId: string, text: string): Promise<void>;
  claudeSessions(options?: { all?: boolean }): Promise<FakeClaudeSession[]>;
  /**
   * A Codex thread sitting idle, owned by the stand-in of the desktop app unless `owner` is
   * `none`. With `sandbox` its commands are kept from sockets and from writing outside `cwd`
   */
  openCodexThread(options: {
    cwd: string;
    owner?: 'app' | 'none';
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  }): Promise<string>;
  startCodexApp(): Promise<void>;
  stopCodexApp(): Promise<void>;
  startCodexDaemon(): Promise<void>;
  stopCodexDaemon(): Promise<void>;
  /** The turns a session or thread ran, oldest first */
  transcript(harness: 'claude' | 'codex', id: string): FakeTurn[];
  /** Resolves with the first turn of the session `matches` accepts, rejects after `timeoutMs` (default 10000) naming what it waited for and the turns seen */
  waitForTurn(
    harness: 'claude' | 'codex',
    id: string,
    matches: (turn: FakeTurn) => boolean,
    options?: { timeoutMs?: number; what?: string }
  ): Promise<FakeTurn>;
  /** Stops every process the fakes started and removes the folders this call created */
  cleanup(): Promise<void>;
}

export interface FakeHarnessOptions {
  /** An existing empty folder to work in, a new temp folder by default */
  dir?: string;
  /**
   * Extra environment for every fake process, such as FAKE_CLAUDE_MISSING, or
   * COGITATOR_BRIDGE_HOME for the bridge their sessions call
   */
  env?: NodeJS.ProcessEnv;
}

type Harness = 'claude' | 'codex';

interface Folders {
  bin: string;
  home: string;
  created: string[];
}

/**
 * The value a caller gave a variable on purpose: one in `base` that is not simply what the
 * process running the tests has, as in `env({ ...process.env, COGITATOR_BRIDGE_HOME: mine })`.
 */
function named(base: NodeJS.ProcessEnv | undefined, variable: string): string | undefined {
  const value = base?.[variable];
  return value !== undefined && value !== process.env[variable] ? value : undefined;
}

const HARNESSES: Harness[] = ['claude', 'codex'];
const SURROUNDING_SESSION_VARIABLES = ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID'];
/**
 * Folders code under test would otherwise look for in the home of the person running the tests:
 * the bridge's own, and where Claude Code keeps its settings and the folders it trusts
 */
const OWN_FOLDERS: Record<string, string> = {
  COGITATOR_BRIDGE_HOME: 'bridge',
  CLAUDE_CONFIG_DIR: 'claude-config',
};
const TRANSCRIPT_FOLDERS: Record<Harness, string> = { claude: 'sessions', codex: 'threads' };
const POLL_MS = 20;
const STOP_GRACE_MS = 5_000;
const DEFAULT_TURN_TIMEOUT_MS = 10_000;

/**
 * Installs executable stand-ins of `claude` and `codex` for tests of code that drives the real
 * command lines. Each call gets its own executables and its own state, `cleanup()` ends it.
 */
export function installFakeHarnesses(options: FakeHarnessOptions = {}): FakeHarnesses {
  if (process.platform === 'win32') {
    throw new Error('The fake claude and codex executables need a POSIX shell, win32 has none');
  }
  const { bin, home, created } = createFolders(options.dir);
  for (const harness of HARNESSES) writeWrapper(bin, harness);
  const running = new Set<ChildProcess>();

  const env = (base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
    const merged = { ...withoutSurroundingSession(base ?? process.env), ...options.env };
    return {
      ...merged,
      PATH: [bin, merged.PATH].filter(Boolean).join(delimiter),
      FAKE_HARNESS_HOME: home,
      ...Object.fromEntries(
        Object.entries(OWN_FOLDERS).map(([variable, folder]) => [
          variable,
          options.env?.[variable] ?? named(base, variable) ?? join(home, folder),
        ])
      ),
    };
  };

  const run = (harness: Harness, args: string[], options: FakeRunOptions = {}) =>
    execute(join(bin, harness), args, { ...options, env: { ...env(), ...options.env } }, running);

  const succeed = async (harness: Harness, args: string[], options?: FakeRunOptions) => {
    const { code, stdout, stderr } = await run(harness, args, options);
    if (code === 0) return stdout.trim();
    throw new Error(`fake ${harness} ${args.join(' ')} exited with ${code}: ${stderr.trim()}`);
  };

  const transcript = (harness: Harness, id: string) =>
    readTranscript(join(home, harness, TRANSCRIPT_FOLDERS[harness]), id);

  return {
    bin,
    home,
    env,
    run,
    transcript,
    trustFolder(folder) {
      const file = join(home, 'claude', 'trusted.json');
      const trusted = new Set([...stringsIn(readJson(file)), resolve(folder)]);
      writeJson(file, [...trusted]);
    },
    async openClaudeWindow({ cwd, settings, mcpConfig, name, env: extra }) {
      const args = [
        '__open',
        ...(settings === undefined ? [] : ['--settings', settingsArgument(settings)]),
        ...(mcpConfig === undefined ? [] : ['--mcp-config', settingsArgument(mcpConfig)]),
        ...(name === undefined ? [] : ['--name', name]),
      ];
      return succeed('claude', args, { cwd, env: extra });
    },
    async say(sessionId, text) {
      await succeed('claude', ['__say', sessionId, text]);
    },
    async claudeSessions({ all = false } = {}) {
      const listing = await succeed('claude', ['agents', '--json', ...(all ? ['--all'] : [])]);
      return JSON.parse(listing) as FakeClaudeSession[];
    },
    async openCodexThread({ cwd, owner = 'app', sandbox }) {
      return succeed('codex', [
        '__open',
        '-C',
        cwd,
        '--owner',
        owner,
        ...(sandbox === undefined ? [] : ['--sandbox', sandbox]),
      ]);
    },
    async startCodexApp() {
      await succeed('codex', ['__app', 'start']);
    },
    async stopCodexApp() {
      await succeed('codex', ['__app', 'stop']);
    },
    async startCodexDaemon() {
      await succeed('codex', ['app-server', 'daemon', 'start']);
    },
    async stopCodexDaemon() {
      await succeed('codex', ['app-server', 'daemon', 'stop']);
    },
    async waitForTurn(harness, id, matches, waiting = {}) {
      const { timeoutMs = DEFAULT_TURN_TIMEOUT_MS, what = 'a matching turn' } = waiting;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const turns = transcript(harness, id);
        const found = turns.find(matches);
        if (found) return found;
        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out after ${timeoutMs} ms waiting for ${what} of ${harness} ${id}, ` +
              `turns seen: ${JSON.stringify(turns)}`
          );
        }
        await sleep(POLL_MS);
      }
    },
    async cleanup() {
      const started = [...running].map((child) => child.pid);
      try {
        await stopAll([...recordedPids(home), ...started].filter(isPid));
      } finally {
        for (const folder of created) rmSync(folder, { recursive: true, force: true });
      }
    },
  };
}

/**
 * The folders of one installation. The temp folder sits under `/tmp` where there is one: the
 * temp folder of macOS is too deep for the unix sockets tests create next to it.
 */
function createFolders(dir: string | undefined): Folders {
  if (dir === undefined) {
    const base = existsSync('/tmp') ? '/tmp' : tmpdir();
    const root = mkdtempSync(join(base, 'fake-harness-'));
    return { ...createStateFolders(root), created: [root] };
  }
  const folders = createStateFolders(resolve(dir));
  return { ...folders, created: [folders.bin, folders.home] };
}

function createStateFolders(root: string): Omit<Folders, 'created'> {
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  return { bin, home };
}

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

function writeWrapper(bin: string, harness: Harness): void {
  const script = fileURLToPath(new URL(`../../fakes/${harness}.mjs`, import.meta.url));
  const wrapper = join(bin, harness);
  const command = `exec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"`;
  writeFileSync(wrapper, `#!/bin/sh\n${command}\n`);
  chmodSync(wrapper, 0o755);
}

function withoutSurroundingSession(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = Object.entries(base).filter(
    ([name]) => !SURROUNDING_SESSION_VARIABLES.includes(name)
  );
  return Object.fromEntries(kept);
}

function settingsArgument(settings: unknown): string {
  return typeof settings === 'string' ? settings : JSON.stringify(settings);
}

function execute(
  file: string,
  args: string[],
  options: FakeRunOptions,
  running: Set<ChildProcess>
): Promise<FakeRunResult> {
  const { cwd, env, input } = options;
  return new Promise((resolveRun, rejectRun) => {
    const stdin = input === undefined ? 'ignore' : 'pipe';
    const child = spawn(file, args, { cwd, env, stdio: [stdin, 'pipe', 'pipe'] });
    const output = { stdout: '', stderr: '' };
    running.add(child);
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (output.stdout += chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (output.stderr += chunk));
    child.on('error', (error) => {
      running.delete(child);
      rejectRun(error);
    });
    child.on('close', (code) => {
      running.delete(child);
      resolveRun({ code, ...output });
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const draft = `${file}.${process.pid}.tmp`;
  writeFileSync(draft, JSON.stringify(value, null, 2));
  renameSync(draft, file);
}

function stringsIn(value: unknown): string[] {
  const items: unknown[] = Array.isArray(value) ? value : [];
  return items.filter((item) => typeof item === 'string');
}

function namesIn(folder: string): string[] {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
}

/** The transcript of the session or thread whose id is `id` or starts with it (a short id) */
function readTranscript(folder: string, id: string): FakeTurn[] {
  const name = namesIn(folder).find((entry) => entry.startsWith(id) && entry.endsWith('.jsonl'));
  if (name === undefined) return [];
  try {
    const lines = readFileSync(join(folder, name), 'utf8').split('\n').slice(0, -1);
    return lines.map((line) => JSON.parse(line) as FakeTurn);
  } catch {
    return [];
  }
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 1;
}

function pidsOf(record: unknown): number[] {
  if (typeof record !== 'object' || record === null) return [];
  const { pid, hookPids } = record as { pid?: unknown; hookPids?: unknown };
  const hooks: unknown[] = Array.isArray(hookPids) ? hookPids : [];
  return [pid, ...hooks].filter(isPid);
}

/**
 * The processes the state names: sessions, their running hooks, the daemon, the app and every
 * `codex exec` in the middle of its turn
 */
function recordedPids(home: string): number[] {
  const sessions = join(home, 'claude', 'sessions');
  const threads = join(home, 'codex', 'threads');
  const records = [
    ...namesIn(sessions)
      .filter((name) => name.endsWith('.json'))
      .map((name) => join(sessions, name)),
    join(home, 'codex', 'daemon.json'),
    join(home, 'codex', 'app.json'),
    ...namesIn(threads)
      .filter((name) => name.endsWith('.pid'))
      .map((name) => join(threads, name)),
  ];
  return records.flatMap((file) => pidsOf(readJson(file)));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Signals a process and, when it leads a process group as sessions and hooks do, its group */
function signal(pid: number, name: NodeJS.Signals): void {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, name);
    } catch {}
  }
}

async function allGone(pids: number[]): Promise<boolean> {
  const deadline = Date.now() + STOP_GRACE_MS;
  while (pids.some(isAlive)) {
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
  return true;
}

async function stopAll(pids: number[]): Promise<void> {
  for (const name of ['SIGTERM', 'SIGKILL'] as const) {
    for (const pid of pids.filter(isAlive)) signal(pid, name);
    if (await allGone(pids)) return;
  }
  throw new Error(`Fake harness processes outlived SIGKILL: ${pids.filter(isAlive).join(', ')}`);
}
