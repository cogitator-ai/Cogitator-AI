import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  installFakeHarnesses,
  type FakeClaudeSession,
  type FakeHarnessOptions,
  type FakeHarnesses,
  type FakeRunOptions,
  type FakeTurn,
} from '../testing/fake-harnesses';

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: { id: string; type: string; text: string };
  usage?: Record<string, number>;
}

interface StopHookPayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: string;
  stop_hook_active: boolean;
  last_assistant_message: string;
}

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const CLAUDE_VERSION = '2.1.292';
const CODEX_VERSION = '0.167.0-alpha.4.1';
const LONG_TURN = 'sleep: 60000';
const NOT_TRUSTED =
  'Workspace not trusted. Run claude once in this folder and accept the trust prompt\n';
const GATE_HOOK = 'sh "$CLAUDE_PROJECT_DIR/wait-gate.sh"';
const GATE_HOOK_SCRIPT = [
  'n=$(cat count 2>/dev/null || echo 0)',
  'cat > "payload-$n.json"',
  'echo $((n + 1)) > count',
  'until [ -e "gate-$n" ]; do sleep 0.05; done',
  'echo "say: woken $n" >&2',
  'exit 2',
].join('\n');
const WAIT_FOR_GO = 'run: until [ -e go ]; do sleep 0.05; done';

const installed: FakeHarnesses[] = [];
let fakes: FakeHarnesses;
let work: string;

function install(options?: FakeHarnessOptions): FakeHarnesses {
  const harnesses = installFakeHarnesses(options);
  installed.push(harnesses);
  return harnesses;
}

function folder(...parts: string[]): string {
  const path = join(fakes.home, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readText(...parts: string[]): string {
  const file = join(work, ...parts);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function readNumber(...parts: string[]): number {
  return Number(readText(...parts).trim() || Number.NaN);
}

const saying = (answer: string) => (turn: FakeTurn) => turn.answer === answer;

function stopHooks(...hooks: Record<string, unknown>[]): unknown {
  return { hooks: { Stop: [{ hooks: hooks.map((hook) => ({ type: 'command', ...hook })) }] } };
}

async function background(
  prompt: string,
  { args = [], ...options }: FakeRunOptions & { args?: string[] } = {}
): Promise<string> {
  const result = await fakes.run('claude', ['--bg', ...args, prompt], { cwd: work, ...options });
  expect(result).toMatchObject({ code: 0, stderr: '' });
  return /^backgrounded · ([0-9a-f]{8}) · /.exec(result.stdout)![1];
}

async function sessionOf(ref: string): Promise<FakeClaudeSession> {
  const sessions = await fakes.claudeSessions({ all: true });
  return sessions.find((session) => session.id === ref || session.sessionId === ref)!;
}

function wokenBy(sessionId: string): string[] {
  return fakes.transcript('claude', sessionId).map((turn) => turn.wokenBy);
}

function parseEvents(stdout: string): CodexEvent[] {
  const lines = stdout.split('\n').filter(Boolean);
  return lines.map((line) => JSON.parse(line) as CodexEvent);
}

async function execJson(
  args: string[],
  options: FakeRunOptions = {}
): Promise<{ threadId: string; answer: string; events: CodexEvent[] }> {
  const result = await fakes.run('codex', ['exec', '--json', ...args], { cwd: work, ...options });
  expect(result).toMatchObject({ code: 0, stderr: '' });
  const events = parseEvents(result.stdout);
  return { events, threadId: events[0].thread_id!, answer: events[2].item!.text };
}

function queue(threadId: string, message: string, ...more: string[]) {
  return fakes.run('codex', ['queue', '--thread', threadId, '--message', message, ...more]);
}

function ownerPid(owner: 'daemon' | 'app'): number {
  const record = readFileSync(join(fakes.home, 'codex', `${owner}.json`), 'utf8');
  return (JSON.parse(record) as { pid: number }).pid;
}

function resumeWarning(threadId: string): string {
  return (
    `Warning: message was queued, but could not resume thread ${threadId}: ` +
    'start a local daemon or specify a server with --remote\n'
  );
}

beforeEach(() => {
  fakes = install();
  work = realpathSync(folder('work'));
});

afterEach(async () => {
  await Promise.all(installed.splice(0).map((harnesses) => harnesses.cleanup()));
});

describe('installFakeHarnesses', () => {
  it('puts the fakes first on PATH and keeps a surrounding session out of the environment', () => {
    const env = fakes.env({
      PATH: '/usr/bin:/bin',
      KEPT: 'yes',
      CLAUDE_CODE_SESSION_ID: 'outer-session',
      CODEX_THREAD_ID: 'outer-thread',
    });

    expect(env).toEqual({
      PATH: `${fakes.bin}:/usr/bin:/bin`,
      KEPT: 'yes',
      FAKE_HARNESS_HOME: fakes.home,
      COGITATOR_BRIDGE_HOME: join(fakes.home, 'bridge'),
      CLAUDE_CONFIG_DIR: join(fakes.home, 'claude-config'),
    });
    expect(fakes.env().PATH).toBe(`${fakes.bin}:${process.env.PATH}`);
  });

  it('never points what is under test at the bridge or the Claude Code settings of the machine', () => {
    const before = process.env.COGITATOR_BRIDGE_HOME;
    process.env.COGITATOR_BRIDGE_HOME = '/the/real/bridge';
    try {
      expect(fakes.env().COGITATOR_BRIDGE_HOME).toBe(join(fakes.home, 'bridge'));
      expect(fakes.env({ COGITATOR_BRIDGE_HOME: '/given' }).COGITATOR_BRIDGE_HOME).toBe('/given');
      expect(fakes.env({ CLAUDE_CONFIG_DIR: '/given' }).CLAUDE_CONFIG_DIR).toBe('/given');
      expect(fakes.env({ ...process.env }).COGITATOR_BRIDGE_HOME).toBe(join(fakes.home, 'bridge'));
      expect(
        fakes.env({ ...process.env, COGITATOR_BRIDGE_HOME: '/mine' }).COGITATOR_BRIDGE_HOME
      ).toBe('/mine');
    } finally {
      if (before === undefined) delete process.env.COGITATOR_BRIDGE_HOME;
      else process.env.COGITATOR_BRIDGE_HOME = before;
    }
  });

  it('installs executables a PATH lookup finds', async () => {
    const env = fakes.env();
    const claude = await promisify(execFile)('claude', ['--version'], { env });
    const codex = await promisify(execFile)('codex', ['--version'], { env });

    expect(claude.stdout).toBe(`${CLAUDE_VERSION} (Claude Code)\n`);
    expect(codex.stdout).toBe(`codex-cli ${CODEX_VERSION}\n`);
    expect(statSync(join(fakes.bin, 'claude')).mode & 0o777).toBe(0o755);
    expect(statSync(join(fakes.bin, 'codex')).mode & 0o777).toBe(0o755);
  });

  it('gives every fake process the extra environment of the installation', async () => {
    const old = install({ env: { FAKE_CLAUDE_VERSION: '1.0.0', FAKE_CODEX_VERSION: '0.1.0' } });

    expect((await old.run('claude', ['--version'])).stdout).toBe('1.0.0 (Claude Code)\n');
    expect((await old.run('codex', ['--version'])).stdout).toBe('codex-cli 0.1.0\n');
  });

  it.each([
    { harness: 'claude', start: ['--bg', 'say: hi'] },
    { harness: 'codex', start: ['exec', 'say: hi'] },
  ] as const)('makes $harness refuse every command without FAKE_HARNESS_HOME', async (fake) => {
    const env = { FAKE_HARNESS_HOME: '' };
    fakes.trustFolder(work);

    const version = await fakes.run(fake.harness, ['--version'], { env });
    const started = await fakes.run(fake.harness, [...fake.start], { cwd: work, env });

    for (const result of [version, started]) {
      expect(result).toMatchObject({ code: 2, stdout: '' });
      expect(result.stderr).toContain('FAKE_HARNESS_HOME is not set');
    }
    expect(readdirSync(fakes.home).sort()).toEqual(['claude', 'work']);
    expect(readdirSync(join(fakes.home, 'claude'))).toEqual(['trusted.json']);
  });

  it('works in a given folder and removes only what it created there', async () => {
    const dir = folder('given');
    const second = install({ dir });

    expect(second).toMatchObject({ bin: join(dir, 'bin'), home: join(dir, 'home') });
    expect((await second.run('codex', ['--version'])).code).toBe(0);

    await second.cleanup();

    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses to install on win32', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      expect(() => installFakeHarnesses()).toThrow(/POSIX/);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('names what it waited for and the turns seen when a turn does not come', async () => {
    const { threadId } = await execJson(['say: only']);

    const waiting = fakes.waitForTurn('codex', threadId, saying('other'), {
      timeoutMs: 50,
      what: 'the other answer',
    });

    await expect(waiting).rejects.toThrow(
      /^Timed out after 50 ms waiting for the other answer of codex .*"answer":"only"/
    );
  });

  it('stops every process the fakes started and removes its folder on cleanup', async () => {
    const hook = { command: 'echo $$ > hook.pid; while :; do sleep 0.05; done', asyncRewake: true };
    fakes.trustFolder(work);
    await background(LONG_TURN);
    const windowId = await fakes.openClaudeWindow({ cwd: work, settings: stopHooks(hook) });
    await fakes.say(windowId, 'say: armed');
    await fakes.startCodexDaemon();
    await fakes.startCodexApp();
    const exec = fakes.run('codex', ['exec', 'run: echo $$ > exec.pid; sleep 60'], { cwd: work });
    await until(() => readNumber('hook.pid') > 0 && readNumber('exec.pid') > 0, 'hook and exec');
    const sessions = await fakes.claudeSessions();
    const pids = [
      ...sessions.map((session) => session.pid!),
      ownerPid('daemon'),
      ownerPid('app'),
      readNumber('hook.pid'),
      readNumber('exec.pid'),
    ];
    expect(pids).toHaveLength(6);
    expect(pids.filter(isRunning)).toEqual(pids);

    await fakes.cleanup();

    expect(pids.filter(isRunning)).toEqual([]);
    expect((await exec).code).toBe(143);
    expect(existsSync(dirname(fakes.home))).toBe(false);
  });
});

describe('the scripted model', () => {
  it('runs the run lines in order in the folder and answers with the last say line', async () => {
    const input = [
      'Please do this:',
      '  run: pwd',
      'run: echo out; echo err >&2; exit 3',
      '> run: echo quoted > quoted.txt',
      'run:echo glued > glued.txt',
      'say: first',
      '> say: quoted',
      '\tsay: last  ',
    ].join('\n');

    const { threadId, answer } = await execJson([input]);

    expect(answer).toBe('last');
    expect(existsSync(join(work, 'quoted.txt'))).toBe(false);
    expect(existsSync(join(work, 'glued.txt'))).toBe(false);
    const [turn, ...others] = fakes.transcript('codex', threadId);
    expect(others).toEqual([]);
    expect(turn).toEqual({
      turn: 1,
      at: expect.any(String),
      input,
      ran: [
        { command: 'pwd', code: 0, stdout: `${work}\n`, stderr: '' },
        { command: 'echo out; echo err >&2; exit 3', code: 3, stdout: 'out\n', stderr: 'err\n' },
      ],
      tools: [],
      answer: 'last',
      wokenBy: 'exec',
    });
    expect(new Date(turn.at).toISOString()).toBe(turn.at);
  });

  it('answers ok without a say line and waits out the sleep lines', async () => {
    const startedAt = Date.now();

    const { threadId, answer } = await execJson(['sleep: 150\nsleep: soon\nnothing to say']);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    expect(answer).toBe('ok');
    expect(fakes.transcript('codex', threadId)).toMatchObject([{ ran: [], answer: 'ok' }]);
  });
});

describe('fake claude', () => {
  it('prints the version of Claude Code it stands in for', async () => {
    const result = await fakes.run('claude', ['--version']);

    expect(result).toEqual({ code: 0, stdout: `${CLAUDE_VERSION} (Claude Code)\n`, stderr: '' });
  });

  it('documents the options and commands the adapters look for', async () => {
    const help = await fakes.run('claude', ['--help']);
    const agentsHelp = await fakes.run('claude', ['agents', '--help']);

    for (const mention of [
      '--bg, --background',
      '--settings <file-or-json>',
      '-n, --name <name>',
      '--permission-mode <mode>',
      ' agents ',
      ' attach ',
      ' stop ',
      ' rm ',
    ]) {
      expect(help.stdout).toContain(mention);
    }
    for (const mention of ['--json', '--all', '--cwd <path>']) {
      expect(agentsHelp.stdout).toContain(mention);
    }
  });

  it('imitates a version without --bg', async () => {
    const env = { FAKE_CLAUDE_MISSING: 'bg' };
    fakes.trustFolder(work);

    const help = await fakes.run('claude', ['--help'], { env });
    const start = await fakes.run('claude', ['--bg', 'say: hi'], { cwd: work, env });

    expect(help.stdout).not.toContain('--bg');
    expect(help.stdout).toContain('--settings <file-or-json>');
    expect(start).toEqual({ code: 1, stdout: '', stderr: "error: unknown option '--bg'\n" });
    expect(await fakes.claudeSessions({ all: true })).toEqual([]);
  });

  it('imitates a version without --settings', async () => {
    const env = { FAKE_CLAUDE_MISSING: 'settings' };
    fakes.trustFolder(work);

    const help = await fakes.run('claude', ['--help'], { env });
    const start = await fakes.run('claude', ['--bg', '--settings', '{}', 'say: hi'], {
      cwd: work,
      env,
    });
    const plain = await fakes.run('claude', ['--bg', 'say: hi'], { cwd: work, env });

    expect(help.stdout).not.toContain('--settings');
    expect(help.stdout).toContain('--bg, --background');
    expect(start).toEqual({ code: 1, stdout: '', stderr: "error: unknown option '--settings'\n" });
    expect(plain.code).toBe(0);
  });

  it('imitates a version without agents --json', async () => {
    const env = { FAKE_CLAUDE_MISSING: 'bg, agents-json' };

    const help = await fakes.run('claude', ['agents', '--help'], { env });
    const listing = await fakes.run('claude', ['agents', '--json'], { env });

    expect(help.stdout).not.toContain('--json');
    expect(help.stdout).toContain('--cwd <path>');
    expect(listing).toEqual({ code: 1, stdout: '', stderr: "error: unknown option '--json'\n" });
  });

  it('refuses a background session in a folder nobody trusted', async () => {
    fakes.trustFolder(folder('elsewhere'));

    const result = await fakes.run('claude', ['--bg', 'say: hi'], { cwd: work });

    expect(result).toEqual({ code: 1, stdout: '', stderr: NOT_TRUSTED });
    expect(await fakes.claudeSessions({ all: true })).toEqual([]);
  });

  it('trusts the folders below a trusted one', async () => {
    fakes.trustFolder(join(fakes.home, 'work'));
    fakes.trustFolder(join(fakes.home, 'work'));
    const nested = folder('work', 'packages', 'app');

    const id = await background('say: deep', { cwd: nested });

    await fakes.waitForTurn('claude', id, saying('deep'));
    expect((await sessionOf(id)).cwd).toBe(realpathSync(nested));
  });

  it('returns from --bg at once with the line of a backgrounded session', async () => {
    fakes.trustFolder(work);
    const args = ['--bg', '--name', 'night-shift', '--permission-mode', 'acceptEdits'];

    const result = await fakes.run('claude', [...args, `${LONG_TURN}\nsay: never`], { cwd: work });

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toMatch(/^backgrounded · [0-9a-f]{8} · night-shift\n$/);
    const [session, ...others] = await fakes.claudeSessions();
    expect(others).toEqual([]);
    expect(session).toMatchObject({ name: 'night-shift', status: 'busy', state: 'working' });
    expect(result.stdout).toContain(` · ${session.id} · `);
    expect(session.sessionId).toMatch(UUID);
    expect(fakes.transcript('claude', session.sessionId)).toEqual([]);
  });

  it('names a session after the first three words of its prompt', async () => {
    fakes.trustFolder(work);

    const result = await fakes.run('claude', ['--background', 'Fix  The\nflaky test now'], {
      cwd: work,
    });

    expect(result.stdout).toMatch(/^backgrounded · [0-9a-f]{8} · fix-the-flaky\n$/);
  });

  it('fails a start the way FAKE_CLAUDE_BG_FAIL says', async () => {
    const env = { FAKE_CLAUDE_BG_FAIL: 'Error: credit balance is too low' };

    const result = await fakes.run('claude', ['--bg', 'say: hi'], { cwd: work, env });

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'Error: credit balance is too low\n' });
    expect(await fakes.claudeSessions({ all: true })).toEqual([]);
  });

  it('starts nothing when --settings cannot be read', async () => {
    fakes.trustFolder(work);

    const missing = await fakes.run('claude', ['--bg', '--settings', 'none.json', 'say: hi'], {
      cwd: work,
    });
    const broken = await fakes.run('claude', ['__open', '--settings', '{"hooks":'], { cwd: work });

    for (const result of [missing, broken]) {
      expect(result).toMatchObject({ code: 1, stdout: '' });
      expect(result.stderr).toContain('--settings');
    }
    expect(await fakes.claudeSessions({ all: true })).toEqual([]);
  });

  it('gives the commands of a turn the session id, the project folder and its own environment', async () => {
    fakes.trustFolder(work);
    const print = `run: printf '%s|%s|%s' "$CLAUDE_CODE_SESSION_ID" "$CLAUDE_PROJECT_DIR" "$MARK"`;

    const id = await background(`${print}\nsay: done`, {
      env: { MARK: 'kept', CLAUDE_CODE_SESSION_ID: 'outer-session' },
    });

    const turn = await fakes.waitForTurn('claude', id, saying('done'));
    const { sessionId } = await sessionOf(id);
    expect(turn).toMatchObject({ turn: 1, wokenBy: 'prompt' });
    expect(turn.ran).toMatchObject([{ code: 0, stdout: `${sessionId}|${work}|kept` }]);
    expect(fakes.transcript('claude', sessionId)).toEqual([turn]);
  });

  it('lists live sessions with their status and filters them by folder', async () => {
    const loud = folder('work', 'loud');
    const quiet = folder('work', 'quiet');
    fakes.trustFolder(work);
    const busy = await background(LONG_TURN, { cwd: loud, args: ['-n', 'long'] });
    const done = await background('say: finished', { cwd: quiet });
    const windowId = await fakes.openClaudeWindow({ cwd: quiet, name: 'window' });
    await fakes.waitForTurn('claude', done, saying('finished'));

    const sessions = await fakes.claudeSessions();
    const inQuiet = await fakes.run('claude', ['agents', '--json', '--cwd', quiet]);
    const inWork = await fakes.run('claude', ['agents', '--json', '--all', '--cwd', work]);
    const elsewhere = await fakes.run('claude', ['agents', '--json', '--cwd', `${quiet}er`]);

    expect(sessions).toEqual([
      {
        id: busy,
        sessionId: expect.stringMatching(UUID),
        name: 'long',
        cwd: realpathSync(loud),
        kind: 'background',
        startedAt: expect.any(Number),
        pid: expect.any(Number),
        status: 'busy',
        state: 'working',
      },
      {
        id: done,
        sessionId: expect.stringMatching(UUID),
        name: 'say:-finished',
        cwd: realpathSync(quiet),
        kind: 'background',
        startedAt: expect.any(Number),
        pid: expect.any(Number),
        status: 'idle',
        state: 'done',
      },
      {
        sessionId: windowId,
        name: 'window',
        cwd: realpathSync(quiet),
        kind: 'interactive',
        startedAt: expect.any(Number),
        pid: expect.any(Number),
        status: 'idle',
      },
    ]);
    expect(JSON.parse(inQuiet.stdout)).toEqual(sessions.slice(1));
    expect(JSON.parse(inWork.stdout)).toEqual(sessions);
    expect(JSON.parse(elsewhere.stdout)).toEqual([]);
  });

  it('queues what a person types while a turn is going on', async () => {
    const sessionId = await fakes.openClaudeWindow({ cwd: work });
    await fakes.say(sessionId, `${WAIT_FOR_GO}\nsay: one`);
    await until(async () => (await sessionOf(sessionId)).status === 'busy', 'the turn to start');

    await fakes.say(sessionId, 'say: two');
    await fakes.say(sessionId.slice(0, 8), 'say: three');
    writeFileSync(join(work, 'go'), '');

    await fakes.waitForTurn('claude', sessionId, saying('three'));
    expect(fakes.transcript('claude', sessionId)).toMatchObject([
      { turn: 1, answer: 'one', wokenBy: 'user' },
      { turn: 2, input: 'say: two', answer: 'two', wokenBy: 'user' },
      { turn: 3, input: 'say: three', answer: 'three', wokenBy: 'user' },
    ]);
    expect(await sessionOf(sessionId)).toMatchObject({ status: 'idle' });
  });

  it('stops a session by short id, session id or name and waits until it is gone', async () => {
    fakes.trustFolder(work);
    const byShortId = await background(LONG_TURN);
    const bySessionId = await background(LONG_TURN);
    await background(LONG_TURN, { args: ['--name', 'by-name'] });
    const live = await fakes.claudeSessions();
    const refs = [byShortId, (await sessionOf(bySessionId)).sessionId, 'by-name'];

    for (const ref of refs) {
      expect(await fakes.run('claude', ['stop', ref])).toMatchObject({ code: 0, stderr: '' });
    }

    expect(live.map((session) => isRunning(session.pid!))).toEqual([false, false, false]);
    expect(await fakes.claudeSessions()).toEqual([]);
    const stopped = await fakes.claudeSessions({ all: true });
    expect(stopped).toMatchObject(live.map(({ id }) => ({ id, state: 'stopped' })));
    for (const session of stopped) {
      expect(session).not.toHaveProperty('pid');
      expect(session).not.toHaveProperty('status');
    }
    expect((await fakes.run('claude', ['stop', byShortId])).code).toBe(0);
  });

  it('treats a session whose process died as stopped', async () => {
    fakes.trustFolder(work);
    const id = await background(LONG_TURN);
    const { pid } = await sessionOf(id);

    process.kill(pid!, 'SIGKILL');
    await until(() => !isRunning(pid!), 'the session to die');

    expect(await fakes.claudeSessions()).toEqual([]);
    const session = await sessionOf(id);
    expect(session).toMatchObject({ id, state: 'stopped' });
    expect(session).not.toHaveProperty('pid');
    expect(session).not.toHaveProperty('status');
    const typed = await fakes.run('claude', ['__say', id, 'say: anyone there']);
    expect(typed).toMatchObject({ code: 1, stdout: '' });
  });

  it('removes a session with its record, transcript and spool', async () => {
    fakes.trustFolder(work);
    const id = await background('say: short-lived');
    await fakes.waitForTurn('claude', id, saying('short-lived'));
    const { pid } = await sessionOf(id);

    const removed = await fakes.run('claude', ['rm', id]);

    expect(removed).toMatchObject({ code: 0, stderr: '' });
    expect(isRunning(pid!)).toBe(false);
    expect(await fakes.claudeSessions({ all: true })).toEqual([]);
    expect(fakes.transcript('claude', id)).toEqual([]);
    expect(readdirSync(join(fakes.home, 'claude', 'sessions'))).toEqual([]);
  });

  it('fails stop, rm and __say for a session it does not know', async () => {
    for (const args of [
      ['stop', 'nobody'],
      ['rm', 'nobody'],
      ['__say', 'nobody', 'say: hi'],
    ]) {
      const result = await fakes.run('claude', args);

      expect(result).toEqual({ code: 1, stdout: '', stderr: "No session found for 'nobody'\n" });
    }
  });

  it('rejects what it does not imitate with exit code 64', async () => {
    for (const args of [['attach', 'abc'], ['--frobnicate'], ['say: no flag'], ['agents']]) {
      const result = await fakes.run('claude', args, { cwd: work });

      expect(result).toEqual({
        code: 64,
        stdout: '',
        stderr: `fake claude: unsupported: ${args.join(' ')}\n`,
      });
    }
  });

  it('ends its long-lived processes after FAKE_HARNESS_MAX_LIFE_MS', async () => {
    const brief = install({ env: { FAKE_HARNESS_MAX_LIFE_MS: '300' } });
    brief.trustFolder(work);

    const started = await brief.run('claude', ['--bg', LONG_TURN], { cwd: work });
    await brief.startCodexDaemon();

    expect(started.code).toBe(0);
    await until(async () => (await brief.claudeSessions()).length === 0, 'the session to end');
    expect(await brief.claudeSessions({ all: true })).toMatchObject([{ state: 'stopped' }]);
    await until(
      async () => (await brief.run('codex', ['app-server', 'daemon', 'version'])).code === 1,
      'the daemon to end'
    );
  });
});

describe('fake claude Stop hooks', () => {
  beforeEach(() => {
    writeFileSync(join(work, 'wait-gate.sh'), GATE_HOOK_SCRIPT);
  });

  function openGate(index: number): void {
    writeFileSync(join(work, `gate-${index}`), '');
  }

  function payload(index: number): StopHookPayload {
    return JSON.parse(readText(`payload-${index}.json`)) as StopHookPayload;
  }

  it('wakes an idle session when a rewake hook exits 2 and arms the hook again', async () => {
    const settings = stopHooks({ command: GATE_HOOK, async: true, asyncRewake: true });
    const sessionId = await fakes.openClaudeWindow({ cwd: work, settings });
    await fakes.say(sessionId, 'say: first');
    await until(() => readNumber('count') === 1, 'the hook to wait');
    expect(await sessionOf(sessionId)).toMatchObject({ status: 'idle' });
    expect(wokenBy(sessionId)).toEqual(['user']);

    openGate(0);
    const woken = await fakes.waitForTurn('claude', sessionId, saying('woken 0'));
    openGate(1);
    const wokenAgain = await fakes.waitForTurn('claude', sessionId, saying('woken 1'));

    expect(woken).toMatchObject({ turn: 2, input: 'say: woken 0', wokenBy: 'hook' });
    expect(wokenAgain).toMatchObject({ turn: 3, input: 'say: woken 1', wokenBy: 'hook' });
    expect(payload(0)).toEqual({
      session_id: sessionId,
      transcript_path: join(fakes.home, 'claude', 'sessions', `${sessionId}.jsonl`),
      cwd: work,
      permission_mode: 'default',
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'first',
    });
    expect(payload(1)).toMatchObject({ stop_hook_active: true, last_assistant_message: 'woken 0' });
  });

  it('passes the permission mode of a background session to its hooks', async () => {
    fakes.trustFolder(work);
    const settings = JSON.stringify(stopHooks({ command: GATE_HOOK, asyncRewake: true }));
    const args = ['--settings', settings, '--permission-mode', 'acceptEdits'];

    const id = await background('say: first', { args });
    openGate(0);

    await fakes.waitForTurn('claude', id, saying('woken 0'));
    expect(payload(0)).toMatchObject({ permission_mode: 'acceptEdits', stop_hook_active: false });
  });

  it('runs a typed message while a hook waits and leaves that hook running', async () => {
    const settings = stopHooks({ command: GATE_HOOK, asyncRewake: true });
    const sessionId = await fakes.openClaudeWindow({ cwd: work, settings });
    await fakes.say(sessionId, 'say: first');
    await until(() => readNumber('count') === 1, 'the first hook to wait');

    await fakes.say(sessionId, 'say: typed');
    await until(() => readNumber('count') === 2, 'the second hook to wait');
    openGate(1);
    await fakes.waitForTurn('claude', sessionId, saying('woken 1'));
    openGate(0);
    await fakes.waitForTurn('claude', sessionId, saying('woken 0'));

    expect(fakes.transcript('claude', sessionId)).toMatchObject([
      { answer: 'first', wokenBy: 'user' },
      { answer: 'typed', wokenBy: 'user' },
      { answer: 'woken 1', wokenBy: 'hook' },
      { answer: 'woken 0', wokenBy: 'hook' },
    ]);
  });

  it('kills a hook with SIGTERM when its timeout passes and does nothing else', async () => {
    const command = `trap 'echo over > timed-out; exit 2' TERM; while :; do sleep 0.05; done`;
    const settings = stopHooks({ command, asyncRewake: true, timeout: 1 });
    const sessionId = await fakes.openClaudeWindow({ cwd: work, settings });
    await fakes.say(sessionId, 'say: first');

    await until(() => readText('timed-out') === 'over\n', 'the hook to time out');
    await fakes.say(sessionId, 'say: second');
    await fakes.waitForTurn('claude', sessionId, saying('second'));
    await fakes.say(sessionId, 'say: third');
    await fakes.waitForTurn('claude', sessionId, saying('third'));

    expect(wokenBy(sessionId)).toEqual(['user', 'user', 'user']);
  });

  it('waits for plain hooks from all three settings and starts a turn when one exits 2', async () => {
    const complain =
      'echo project >> order; [ -e complained ] && exit 0; touch complained; echo "say: again" >&2; exit 2';
    const fromFlag = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'prompt', prompt: 'echo never >> order' },
              { type: 'command', command: 'echo flag >> order' },
            ],
          },
        ],
        PreToolUse: [{ hooks: [{ type: 'command', command: 'echo never >> order' }] }],
      },
    };
    writeFileSync(join(work, 'flag-settings.json'), JSON.stringify(fromFlag));
    mkdirSync(join(work, '.claude'));
    writeFileSync(
      join(work, '.claude', 'settings.json'),
      JSON.stringify(stopHooks({ command: complain }))
    );
    writeFileSync(
      join(work, '.claude', 'settings.local.json'),
      JSON.stringify(stopHooks({ command: 'echo local >> order' }))
    );
    const sessionId = await fakes.openClaudeWindow({ cwd: work, settings: 'flag-settings.json' });

    await fakes.say(sessionId, 'say: one');
    await fakes.waitForTurn('claude', sessionId, saying('again'));
    await fakes.say(sessionId, 'say: two');
    await fakes.waitForTurn('claude', sessionId, saying('two'));

    expect(fakes.transcript('claude', sessionId)).toMatchObject([
      { answer: 'one', wokenBy: 'user' },
      { input: 'say: again', answer: 'again', wokenBy: 'hook' },
      { answer: 'two', wokenBy: 'user' },
    ]);
    const firstTwoStops = readText('order').split('\n').slice(0, 6);
    expect(firstTwoStops).toEqual(['flag', 'project', 'local', 'flag', 'project', 'local']);
  });

  it('ignores the result of a hook that is only async', async () => {
    const command = 'echo "say: ignored" >&2; echo ran > async-ran; exit 2';
    const settings = stopHooks({ command, async: true });
    const sessionId = await fakes.openClaudeWindow({ cwd: work, settings });
    await fakes.say(sessionId, 'say: first');

    await until(() => readText('async-ran') === 'ran\n', 'the hook to run');
    await fakes.say(sessionId, 'say: second');
    await fakes.waitForTurn('claude', sessionId, saying('second'));
    await fakes.say(sessionId, 'say: third');
    await fakes.waitForTurn('claude', sessionId, saying('third'));

    expect(wokenBy(sessionId)).toEqual(['user', 'user', 'user']);
  });

  it('ends the waiting hooks of a session that is stopped', async () => {
    const command = `trap 'echo ended > hook-ended; exit 0' TERM; echo $$ > hook.pid; while :; do sleep 0.05; done`;
    const sessionId = await fakes.openClaudeWindow({
      cwd: work,
      settings: stopHooks({ command, asyncRewake: true }),
    });
    await fakes.say(sessionId, 'say: first');
    await until(() => readNumber('hook.pid') > 0, 'the hook to wait');
    const hookPid = readNumber('hook.pid');

    const stopped = await fakes.run('claude', ['stop', sessionId]);

    expect(stopped.code).toBe(0);
    await until(() => !isRunning(hookPid), 'the hook to end');
    expect(readText('hook-ended')).toBe('ended\n');
    expect(await sessionOf(sessionId)).not.toHaveProperty('pid');
  });
});

describe('fake claude permission dialogs', () => {
  const settings = (value: Record<string, unknown>, file = 'settings.json') => {
    mkdirSync(join(work, '.claude'), { recursive: true });
    writeFileSync(join(work, '.claude', file), JSON.stringify(value));
  };
  const first = async (sessionId: string) =>
    (await fakes.waitForTurn('claude', sessionId, () => true)).ran;

  it('runs a command of its shell tool that a rule allows, and none that a rule denies', async () => {
    settings({ permissions: { allow: ['Bash(echo *)', 'Bash(pwd)'], deny: ['Bash(rm:*)'] } });
    const sessionId = await fakes.openClaudeWindow({ cwd: work });

    await fakes.say(sessionId, 'bash: echo hello\nbash: pwd\nbash: rm -rf build\nrun: echo free');

    expect(await first(sessionId)).toEqual([
      { command: 'echo hello', code: 0, stdout: 'hello\n', stderr: '' },
      { command: 'pwd', code: 0, stdout: `${work}\n`, stderr: '' },
      {
        command: 'rm -rf build',
        code: null,
        stdout: '',
        stderr: 'Permission to use Bash has been denied.',
        denied: true,
      },
      { command: 'echo free', code: 0, stdout: 'free\n', stderr: '' },
    ]);
  });

  it('shows a dialog for a command no rule settles, and goes by what the person answers', async () => {
    const sessionId = await fakes.openClaudeWindow({ cwd: work });

    await fakes.say(sessionId, 'bash: echo one\nbash: echo two');
    await until(
      async () => (await sessionOf(sessionId)).waitingFor === 'permission prompt',
      'the dialog'
    );
    expect(await sessionOf(sessionId)).toMatchObject({ status: 'waiting' });
    expect(fakes.transcript('claude', sessionId)).toEqual([]);

    await fakes.answerPermission(sessionId, 'allow');
    await until(
      async () =>
        existsSync(join(fakes.home, 'claude', 'sessions', `${sessionId}.answer`)) === false,
      'the answer to be taken'
    );
    await until(
      async () => (await sessionOf(sessionId)).waitingFor === 'permission prompt',
      'the second dialog'
    );
    await fakes.answerPermission(sessionId, 'deny');

    expect((await first(sessionId)).map((run) => [run.command, run.code, run.stderr])).toEqual([
      ['echo one', 0, ''],
      ['echo two', null, "The user doesn't want to proceed with this tool use."],
    ]);
    expect(await sessionOf(sessionId)).not.toHaveProperty('waitingFor');
    await expect(fakes.answerPermission(sessionId, 'allow')).rejects.toThrow(
      /shows no permission dialog/
    );
  });

  it('lists a background session with an open dialog as blocked on a permission prompt', async () => {
    fakes.trustFolder(work);
    const id = await background('bash: echo hi\nsay: done');

    await until(async () => (await sessionOf(id)).state === 'blocked', 'the dialog');
    expect(await sessionOf(id)).toMatchObject({
      state: 'blocked',
      status: 'waiting',
      waitingFor: 'permission prompt',
    });
    await fakes.answerPermission(id, 'allow');
    const turn = await fakes.waitForTurn('claude', (await sessionOf(id)).sessionId, saying('done'));

    expect(turn.ran[0]).toMatchObject({ code: 0, stdout: 'hi\n' });
    expect(await sessionOf(id)).toMatchObject({ state: 'done', status: 'idle' });
  });

  it('follows the mode: bypassPermissions runs everything a rule does not deny, dontAsk refuses what would ask', async () => {
    fakes.trustFolder(work);
    settings({ permissions: { deny: ['Bash(rm *)'] } });
    const bypass = await background('bash: echo hi\nbash: rm -rf build', {
      args: ['--permission-mode', 'bypassPermissions'],
    });
    const strict = await background('bash: echo hi', { args: ['--permission-mode', 'dontAsk'] });

    expect(
      (await first((await sessionOf(bypass)).sessionId)).map((run) => run.denied ?? false)
    ).toEqual([false, true]);
    expect(await first((await sessionOf(strict)).sessionId)).toEqual([
      {
        command: 'echo hi',
        code: null,
        stdout: '',
        stderr: 'Permission to use Bash has been denied.',
        denied: true,
      },
    ]);
  });

  it('changes a file inside its folder without asking in acceptEdits mode, and asks for one outside', async () => {
    fakes.trustFolder(work);
    const outside = join(fakes.home, 'elsewhere.txt');
    const id = await background(`edit: src/a.txt\nedit: ${outside}\nsay: done`, {
      args: ['--permission-mode', 'acceptEdits'],
    });

    await until(
      async () => (await sessionOf(id)).state === 'blocked',
      'the dialog for the file outside'
    );
    expect(readText('src', 'a.txt')).toBe('edited\n');
    await fakes.answerPermission(id, 'deny');
    const turn = await fakes.waitForTurn('claude', (await sessionOf(id)).sessionId, saying('done'));

    expect(turn.ran.map((run) => [run.command, run.code, run.denied ?? false])).toEqual([
      ['edit src/a.txt', 0, false],
      [`edit ${outside}`, null, true],
    ]);
    expect(existsSync(outside)).toBe(false);
  });

  it('asks before it changes a file in the default mode, and a thread of codex has no such tool', async () => {
    const sessionId = await fakes.openClaudeWindow({ cwd: work });
    await fakes.say(sessionId, 'edit: notes.txt');
    await until(
      async () => (await sessionOf(sessionId)).waitingFor === 'permission prompt',
      'the dialog'
    );
    await fakes.answerPermission(sessionId, 'allow');
    expect((await first(sessionId))[0]).toMatchObject({ command: 'edit notes.txt', code: 0 });
    expect(readText('notes.txt')).toBe('edited\n');

    const { threadId } = await execJson(['edit: notes.txt']);
    expect(fakes.transcript('codex', threadId)[0].ran[0]).toMatchObject({
      code: 1,
      stderr: 'this stand-in has no edit tool of its own',
    });
  });

  it('lets a PermissionRequest hook that matches the tool decide instead of the dialog', async () => {
    const decide =
      'input=$(cat); echo "$input" > asked.json; case "$input" in *"echo yes"*) echo \'{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\';; *"echo no"*) echo \'{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Not this one"}}}\';; esac';
    settings({
      hooks: {
        PermissionRequest: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: decide }] },
          { matcher: 'Edit', hooks: [{ type: 'command', command: 'touch never' }] },
        ],
      },
    });
    const sessionId = await fakes.openClaudeWindow({ cwd: work });

    await fakes.say(sessionId, 'bash: echo yes\nbash: echo no\nbash: echo maybe');
    await until(
      async () => (await sessionOf(sessionId)).waitingFor === 'permission prompt',
      'the dialog for what the hook left open'
    );
    await fakes.answerPermission(sessionId, 'allow');

    expect((await first(sessionId)).map((run) => [run.command, run.code, run.stderr])).toEqual([
      ['echo yes', 0, ''],
      ['echo no', null, 'Not this one'],
      ['echo maybe', 0, ''],
    ]);
    expect(JSON.parse(readText('asked.json'))).toEqual({
      session_id: sessionId,
      transcript_path: expect.stringContaining(`${sessionId}.jsonl`),
      cwd: work,
      permission_mode: 'default',
      tool_name: 'Bash',
      tool_input: { command: 'echo maybe' },
      hook_event_name: 'PermissionRequest',
    });
    expect(existsSync(join(work, 'never'))).toBe(false);
  });

  it('tells the Notification hooks for permission prompts that a dialog opened', async () => {
    settings({
      hooks: {
        Notification: [
          {
            matcher: 'permission_prompt',
            hooks: [{ type: 'command', command: 'cat > told.json' }],
          },
          { matcher: 'idle_prompt', hooks: [{ type: 'command', command: 'touch never' }] },
          { hooks: [{ type: 'command', command: 'touch every' }] },
        ],
      },
    });
    const sessionId = await fakes.openClaudeWindow({ cwd: work });

    await fakes.say(sessionId, 'bash: echo hi');
    await until(
      () => existsSync(join(work, 'told.json')) && existsSync(join(work, 'every')),
      'the hooks'
    );
    await fakes.answerPermission(sessionId, 'deny');
    await first(sessionId);

    expect(JSON.parse(readText('told.json'))).toEqual({
      session_id: sessionId,
      transcript_path: expect.stringContaining(`${sessionId}.jsonl`),
      cwd: work,
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
      title: 'Permission needed',
      notification_type: 'permission_prompt',
    });
    expect(existsSync(join(work, 'never'))).toBe(false);
  });
});

describe('fake codex', () => {
  it('prints the version of the Codex command line it stands in for', async () => {
    const result = await fakes.run('codex', ['--version']);

    expect(result).toEqual({ code: 0, stdout: `codex-cli ${CODEX_VERSION}\n`, stderr: '' });
  });

  it('documents the commands and options the adapters look for', async () => {
    const help = await fakes.run('codex', ['--help']);
    const execHelp = await fakes.run('codex', ['exec', '--help']);
    const queueHelp = await fakes.run('codex', ['queue', '--help']);

    for (const command of [' exec ', ' queue ', ' app-server ', ' delete ']) {
      expect(help.stdout).toContain(command);
    }
    for (const mention of [
      '--json',
      '-C, --cd <DIR>',
      '-s, --sandbox <SANDBOX_MODE>',
      '--skip-git-repo-check',
    ]) {
      expect(execHelp.stdout).toContain(mention);
    }
    for (const mention of ['--thread <THREAD>', '--message <TEXT>', '--resume']) {
      expect(queueHelp.stdout).toContain(mention);
    }
  });

  it('imitates a version without queue', async () => {
    const env = { FAKE_CODEX_MISSING: 'queue' };
    const threadId = await fakes.openCodexThread({ cwd: work });

    const help = await fakes.run('codex', ['--help'], { env });
    const queued = await fakes.run(
      'codex',
      ['queue', '--thread', threadId, '--message', 'say: hi'],
      { env }
    );

    expect(help.stdout).not.toContain('queue');
    expect(help.stdout).toContain(' exec ');
    expect(queued).toEqual({
      code: 2,
      stdout: '',
      stderr: "error: unrecognized subcommand 'queue'\n",
    });
  });

  it('imitates a version without exec --json', async () => {
    const env = { FAKE_CODEX_MISSING: 'exec-json' };

    const help = await fakes.run('codex', ['exec', '--help'], { env });
    const json = await fakes.run('codex', ['exec', '--json', 'say: hi'], { cwd: work, env });
    const plain = await fakes.run('codex', ['exec', 'say: hi'], { cwd: work, env });

    expect(help.stdout).not.toContain('--json');
    expect(help.stdout).toContain('-C, --cd <DIR>');
    expect(json).toEqual({
      code: 2,
      stdout: '',
      stderr: "error: unexpected argument '--json' found\n",
    });
    expect(plain).toEqual({ code: 0, stdout: 'hi\n', stderr: '' });
  });

  it('prints thread.started before the turn runs and the rest when it is over', async () => {
    const child = spawn(
      join(fakes.bin, 'codex'),
      ['exec', '--json', '--skip-git-repo-check', '-C', work, `${WAIT_FOR_GO}\nsay: through`],
      { env: fakes.env(), stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));

    try {
      await until(() => parseEvents(stdout).length === 2 && stdout.endsWith('\n'), 'two events');
      const early = parseEvents(stdout);
      const threadId = early[0].thread_id!;
      expect(early).toEqual([
        { type: 'thread.started', thread_id: expect.stringMatching(UUID) },
        { type: 'turn.started' },
      ]);
      expect(fakes.transcript('codex', threadId)).toEqual([]);

      writeFileSync(join(work, 'go'), '');

      expect(await closed).toBe(0);
      expect(parseEvents(stdout).slice(2)).toEqual([
        {
          type: 'item.completed',
          item: { id: 'item_0', type: 'agent_message', text: 'through' },
        },
        {
          type: 'turn.completed',
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
        },
      ]);
      expect(fakes.transcript('codex', threadId)).toMatchObject([{ turn: 1, answer: 'through' }]);
    } finally {
      child.kill();
    }
  });

  it('gives the commands of a turn the thread id, the sandbox mode and its own environment', async () => {
    const print = `run: printf '%s|%s|%s' "$CODEX_THREAD_ID" "$FAKE_CODEX_SANDBOX" "$MARK"`;
    const env = { MARK: 'kept', CODEX_THREAD_ID: 'outer-thread' };

    const sandboxed = await execJson(['--sandbox', 'read-only', '-m', 'gpt-5', print], { env });
    const free = await execJson(['-c', 'model_reasoning_effort=low', print], { env });

    expect(fakes.transcript('codex', sandboxed.threadId)[0].ran).toMatchObject([
      { stdout: `${sandboxed.threadId}|read-only|kept` },
    ]);
    expect(fakes.transcript('codex', free.threadId)[0].ran).toMatchObject([
      { stdout: `${free.threadId}|read-only|kept` },
    ]);
  });

  it('prints only the answer without --json and works in the folder of -C', async () => {
    const elsewhere = folder('elsewhere');

    const result = await fakes.run('codex', ['exec', '--cd', elsewhere, 'run: pwd\nsay: here']);

    expect(result).toEqual({ code: 0, stdout: 'here\n', stderr: '' });
    const [threadFile] = readdirSync(join(fakes.home, 'codex', 'threads')).filter((name) =>
      name.endsWith('.jsonl')
    );
    const [turn] = fakes.transcript('codex', threadFile.replace('.jsonl', ''));
    expect(turn.ran).toMatchObject([{ stdout: `${realpathSync(elsewhere)}\n` }]);
  });

  it('reads the prompt from stdin when it is absent or a dash', async () => {
    const absent = await fakes.run('codex', ['exec'], { cwd: work, input: 'say: piped\n' });
    const dash = await fakes.run('codex', ['exec', '-'], { cwd: work, input: 'say: dashed' });
    const empty = await fakes.run('codex', ['exec'], { cwd: work });

    expect(absent).toEqual({ code: 0, stdout: 'piped\n', stderr: '' });
    expect(dash).toEqual({ code: 0, stdout: 'dashed\n', stderr: '' });
    expect(empty).toMatchObject({ code: 1, stdout: '' });
  });

  it('runs one more turn on a thread with exec resume', async () => {
    const first = await execJson(['run: pwd\nsay: one']);

    const second = await execJson(['resume', first.threadId, 'run: pwd\nsay: two'], {
      cwd: folder('elsewhere'),
    });
    const piped = await fakes.run('codex', ['exec', 'resume', first.threadId], {
      input: 'say: three',
    });
    const unknown = await fakes.run('codex', ['exec', 'resume', 'no-such-thread', 'say: hi']);

    expect(second).toMatchObject({ threadId: first.threadId, answer: 'two' });
    expect(piped).toEqual({ code: 0, stdout: 'three\n', stderr: '' });
    expect(fakes.transcript('codex', first.threadId)).toMatchObject([
      { turn: 1, answer: 'one', wokenBy: 'exec', ran: [{ stdout: `${work}\n` }] },
      { turn: 2, answer: 'two', wokenBy: 'exec', ran: [{ stdout: `${work}\n` }] },
      { turn: 3, answer: 'three', wokenBy: 'exec' },
    ]);
    expect(unknown).toEqual({
      code: 1,
      stdout: '',
      stderr: "Error: no session found for 'no-such-thread'\n",
    });
  });

  it('fails exec the way FAKE_CODEX_EXEC_FAIL says and creates no thread', async () => {
    const env = { FAKE_CODEX_EXEC_FAIL: 'Error: usage limit reached' };

    const result = await fakes.run('codex', ['exec', '--json', 'say: hi'], { cwd: work, env });

    expect(result).toEqual({ code: 1, stdout: '', stderr: 'Error: usage limit reached\n' });
    expect(existsSync(join(fakes.home, 'codex', 'threads'))).toBe(false);
  });

  it('fails a turn the way FAKE_CODEX_TURN_FAIL says, once the thread has started', async () => {
    const env = { FAKE_CODEX_TURN_FAIL: 'Error: usage limit reached' };

    const result = await fakes.run('codex', ['exec', '--json', 'say: hi'], { cwd: work, env });

    expect(result).toMatchObject({ code: 1, stderr: 'Error: usage limit reached\n' });
    const events = parseEvents(result.stdout);
    expect(events.map((event) => event.type)).toEqual(['thread.started', 'turn.started']);
    expect(fakes.transcript('codex', events[0].thread_id!)).toEqual([]);
    const next = await fakes.run('codex', ['exec', '--json', 'say: hi'], { cwd: work });
    expect(next).toMatchObject({ code: 0, stderr: '' });
  });

  it('queues a message for a thread and warns when no daemon can resume it', async () => {
    const threadId = await fakes.openCodexThread({ cwd: work });

    const queued = await queue(threadId, 'say: later');
    const resumed = await queue(threadId, '- say: a list item', '--resume', '-C', work);
    const unknown = await queue('no-such-thread', 'say: hi', '--resume');

    const stdout = expect.stringMatching(
      new RegExp(`^Queued message [0-9a-f-]{36} for thread ${threadId}\\.\\n$`)
    ) as unknown as string;
    expect(queued).toEqual({ code: 0, stdout, stderr: '' });
    expect(resumed).toEqual({ code: 0, stdout, stderr: resumeWarning(threadId) });
    expect(unknown).toEqual({
      code: 1,
      stdout: '',
      stderr: "Error: no session found for 'no-such-thread'\n",
    });
    expect(fakes.transcript('codex', threadId)).toEqual([]);
  });

  it('resumes without a warning only when the daemon runs, whoever has the thread open', async () => {
    const owned = await fakes.openCodexThread({ cwd: work });
    const ownerless = await fakes.openCodexThread({ cwd: work, owner: 'none' });

    await fakes.startCodexApp();
    const ownedWithApp = await queue(owned, 'say: one', '--resume');
    const ownerlessWithApp = await queue(ownerless, 'say: one', '--resume');
    await fakes.stopCodexApp();
    await fakes.startCodexDaemon();
    const ownedWithDaemon = await queue(owned, 'say: two', '--resume');
    const ownerlessWithDaemon = await queue(ownerless, 'say: two', '--resume');

    expect(ownedWithApp).toMatchObject({ code: 0, stderr: resumeWarning(owned) });
    expect(ownerlessWithApp).toMatchObject({ code: 0, stderr: resumeWarning(ownerless) });
    expect(ownedWithDaemon).toMatchObject({ code: 0, stderr: '' });
    expect(ownerlessWithDaemon).toMatchObject({ code: 0, stderr: '' });
  });

  it('lets the daemon run the messages queued before it started, in order', async () => {
    const { threadId } = await execJson(['say: zero']);
    for (const message of ['say: one', 'run: echo $CODEX_THREAD_ID\nsay: two', 'say: three']) {
      await queue(threadId, message, '--resume');
    }

    await fakes.startCodexDaemon();

    await fakes.waitForTurn('codex', threadId, saying('three'));
    expect(fakes.transcript('codex', threadId)).toMatchObject([
      { turn: 1, answer: 'zero', wokenBy: 'exec' },
      { turn: 2, input: 'say: one', answer: 'one', wokenBy: 'queue' },
      { turn: 3, answer: 'two', wokenBy: 'queue', ran: [{ stdout: `${threadId}\n` }] },
      { turn: 4, answer: 'three', wokenBy: 'queue' },
    ]);
  });

  it('lets the app run only the threads it owns', async () => {
    const owned = await fakes.openCodexThread({ cwd: work });
    const ownerless = await fakes.openCodexThread({ cwd: work, owner: 'none' });
    await queue(ownerless, 'say: for the daemon');

    await fakes.startCodexApp();
    await queue(owned, 'say: one');
    await fakes.waitForTurn('codex', owned, saying('one'));
    await queue(owned, 'say: two');
    await fakes.waitForTurn('codex', owned, saying('two'));

    expect(fakes.transcript('codex', ownerless)).toEqual([]);

    await fakes.startCodexDaemon();
    const taken = await fakes.waitForTurn('codex', ownerless, saying('for the daemon'));

    expect(taken).toMatchObject({ turn: 1, wokenBy: 'queue' });
  });

  it('runs one turn at a time per thread when the daemon and the app both serve it', async () => {
    const threadId = await fakes.openCodexThread({ cwd: work });
    const answers = ['one', 'two', 'three', 'four', 'five', 'six'];
    await fakes.startCodexDaemon();
    await fakes.startCodexApp();

    for (const answer of answers) {
      await queue(threadId, `run: echo start >> turns; echo end >> turns\nsay: ${answer}`);
    }

    await fakes.waitForTurn('codex', threadId, saying('six'));
    const turns = fakes.transcript('codex', threadId);
    expect(turns.map((turn) => turn.answer)).toEqual(answers);
    expect(turns.map((turn) => turn.turn)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(readText('turns')).toBe('start\nend\n'.repeat(6));
  });

  it('answers daemon version only while the daemon runs', async () => {
    const version = () => fakes.run('codex', ['app-server', 'daemon', 'version']);
    const notConnected = {
      code: 1,
      stdout: '',
      stderr: `Error: failed to connect to ${fakes.home}/codex/app-server-control/app-server-control.sock\n`,
    };

    expect(await version()).toEqual(notConnected);

    const started = await fakes.run('codex', ['app-server', 'daemon', 'start']);
    const startedAgain = await fakes.run('codex', ['app-server', 'daemon', 'start']);
    const running = await version();

    expect(started).toEqual({ code: 0, stdout: 'started\n', stderr: '' });
    expect(startedAgain).toEqual({ code: 0, stdout: 'already running\n', stderr: '' });
    expect(running).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(running.stdout)).toEqual({
      cliVersion: CODEX_VERSION,
      appServerVersion: CODEX_VERSION,
    });

    await fakes.stopCodexDaemon();

    expect(await version()).toEqual(notConnected);
  });

  it('deletes a thread with its transcript and queue, only with --force', async () => {
    const { threadId } = await execJson(['say: doomed']);
    await queue(threadId, 'say: never');

    const careful = await fakes.run('codex', ['delete', threadId]);
    const kept = fakes.transcript('codex', threadId);
    const forced = await fakes.run('codex', ['delete', '--force', threadId]);
    const again = await fakes.run('codex', ['delete', '--force', threadId]);

    expect(careful).toMatchObject({ code: 2, stdout: '' });
    expect(careful.stderr).toContain('--force');
    expect(kept).toHaveLength(1);
    expect(forced).toMatchObject({ code: 0, stderr: '' });
    expect(readdirSync(join(fakes.home, 'codex', 'threads'))).toEqual([]);
    expect(fakes.transcript('codex', threadId)).toEqual([]);
    expect(again).toMatchObject({ code: 1, stderr: `Error: no session found for '${threadId}'\n` });
  });

  it('rejects what it does not imitate with exit code 64', async () => {
    for (const args of [
      ['resume', '--last'],
      ['exec', '--frobnicate', 'say: hi'],
      ['app-server', 'daemon', 'restart'],
      ['queue', '--message', 'say: no thread'],
      [],
    ]) {
      const result = await fakes.run('codex', args, { cwd: work });

      expect(result).toEqual({
        code: 64,
        stdout: '',
        stderr: `fake codex: unsupported: ${args.join(' ')}\n`,
      });
    }
  });
});
