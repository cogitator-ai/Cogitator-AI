import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeHarnesses, type FakeHarnesses } from '@cogitator-ai/bridge/testing';

const CLI = fileURLToPath(new URL('../../../../cli/dist/index.js', import.meta.url));
const posix = process.platform !== 'win32';

let fakes: FakeHarnesses;
let bridgeDir: string;
let project: string;
let personHome: string;
const children: ChildProcess[] = [];

function scratch(prefix: string): string {
  const base = posix && existsSync('/tmp') ? '/tmp' : tmpdir();
  return realpathSync(mkdtempSync(join(base, prefix)));
}

/**
 * The environment of the command line: the stand-ins of the harnesses, the bridge of this test,
 * and a home of its own, so the settings of whoever runs the tests decide nothing here. It
 * names no session: the commands of the person are refused inside one.
 */
function env(): NodeJS.ProcessEnv {
  const {
    CLAUDE_CODE_SESSION_ID: _claude,
    CODEX_THREAD_ID: _codex,
    COGITATOR_BRIDGE_AGENT: _agent,
    ...rest
  } = fakes.env({
    ...process.env,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    COGITATOR_BRIDGE_HOME: bridgeDir,
    HOME: personHome,
  });
  return rest;
}

async function until<T>(
  read: () => Promise<T | undefined | false> | T | undefined | false,
  what: string,
  detail: () => string = () => ''
): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}. ${detail()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function serve(): Promise<() => string> {
  const child = spawn(process.execPath, [CLI, 'bridge', 'serve'], { env: env() });
  children.push(child);
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  await until(
    () => output.includes('Bridge dispatcher running'),
    'the dispatcher to start',
    () => output
  );
  return () => output;
}

function cli(args: string[]) {
  const result = spawnSync(process.execPath, [CLI, 'bridge', ...args], {
    env: env(),
    cwd: project,
    encoding: 'utf-8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The command line as a session runs it: a Codex thread that hands the jobs over. */
function session(args: string[]) {
  const result = spawnSync(process.execPath, [CLI, 'bridge', ...args], {
    env: { ...env(), CODEX_THREAD_ID: 'thread-conductor' },
    cwd: project,
    encoding: 'utf-8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const git = (...args: string[]): string => {
  const result = spawnSync('git', args, { cwd: project, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trimEnd();
};

/** The rules of the project that only the bridge reads: the stand-in of claude goes by `.claude`. */
function bridgeRules(permissions: { allow?: string[]; deny?: string[] }): void {
  mkdirSync(join(project, '.cogitator'), { recursive: true });
  writeFileSync(join(project, '.cogitator', 'settings.json'), JSON.stringify({ permissions }));
}

beforeEach(() => {
  fakes = installFakeHarnesses();
  bridgeDir = scratch('cb-e2e-');
  project = scratch('cb-proj-');
  personHome = scratch('cb-home-');
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  writeFileSync(join(project, 'README.md'), 'demo\n');
  writeFileSync(join(project, '.gitignore'), '.cogitator\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  fakes.trustFolder(project);
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
  await fakes.cleanup();
  for (const dir of [bridgeDir, project, personHome]) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!posix)('a job in a worktree of its own, on the real command line', () => {
  it('is done apart, checked by the bridge, and its work is taken into the checkout', async () => {
    bridgeRules({ allow: ['Bash(test:*)'] });
    const served = await serve();

    const handed = session([
      'delegate',
      'claude',
      '--worktree',
      '--title',
      'Write the notes',
      '--check',
      'test -f notes.txt',
      'Write the notes\nrun: pwd\nedit: notes.txt\ntool: bridge.report {"job":1,"result":"Written"}',
    ]);
    expect(handed.status, handed.stderr).toBe(0);
    expect(handed.stdout).toContain('It is done in a git worktree of its own');
    const worktree = join(project, '.cogitator', 'worktrees', 'job-1-write-the-notes');

    const mail = await until(
      () => {
        const read = session(['inbox']);
        return read.stdout.includes('Written') ? read.stdout : undefined;
      },
      'the report to come with its checks',
      served
    );
    expect(mail).toContain(
      `[agent bridge] Changed in the worktree of the job, ${worktree}: 1 file, +1 -0: notes.txt.`
    );
    expect(mail).toContain('[agent bridge] Checks. Verified: the check passed.');
    expect(existsSync(join(project, 'notes.txt'))).toBe(false);
    expect(existsSync(join(project, '.claude', 'worktrees'))).toBe(false);
    const [started] = await fakes.claudeSessions({ all: true });
    const turn = await fakes.waitForTurn('claude', started.sessionId, () => true);
    expect(turn.ran[0]).toMatchObject({ command: 'pwd', stdout: `${worktree}\n` });

    const seen = session(['diff', '1', '--stat']);
    expect(seen.stdout.split('\n').slice(0, 2)).toEqual([
      `Job #1: 1 file, +1 -0, in ${worktree} (branch cogitator/job-1-write-the-notes)`,
      '  A notes.txt  +1 -0',
    ]);

    const taken = session(['accept', '1']);
    expect(taken.status, taken.stderr).toBe(0);
    expect(taken.stdout).toContain(
      `The work of job #1 is in ${project}: 1 file, +1 -0, staged and not committed`
    );
    expect(readFileSync(join(project, 'notes.txt'), 'utf8')).toBe('edited\n');
    expect(git('status', '--porcelain')).toBe('A  notes.txt');
    expect(existsSync(worktree)).toBe(false);
    expect(git('branch', '--list', 'cogitator/*')).toBe('');

    const log = cli(['log', '--job', '1']).stdout;
    expect(log).toContain(`works in a worktree of its own: ${worktree}`);
    expect(log).toContain('checks confirmed the result');
    expect(log).toContain(`work taken into ${project}`);
  });

  it('leaves out a check the rules of the project do not allow, and the work can be dropped', async () => {
    bridgeRules({ allow: ['Bash(test:*)'], deny: ['Bash(rm:*)'] });
    const served = await serve();

    session([
      'delegate',
      'claude',
      '--worktree',
      '--check',
      'test -f notes.txt',
      '--check',
      'touch ran-unasked',
      '--check',
      'rm -rf notes.txt',
      'Write the notes\nedit: notes.txt\ntool: bridge.report {"job":1,"result":"Written"}',
    ]);
    const mail = await until(
      () => {
        const read = session(['inbox']);
        return read.stdout.includes('Written') ? read.stdout : undefined;
      },
      'the report to come with its checks',
      served
    );

    expect(mail).toContain('[agent bridge] Checks. Not verified: 1 of 3 checks passed.');
    expect(mail).toMatch(/- passed: test -f notes\.txt \(/);
    expect(mail).toMatch(
      /- not run: touch ran-unasked: the rules of \S+ do not allow the command without asking/
    );
    expect(mail).toMatch(/- not run: rm -rf notes\.txt: the rules of \S+ forbid the command/);
    const worktree = join(project, '.cogitator', 'worktrees', 'job-1-write-the-notes');
    expect(existsSync(join(worktree, 'ran-unasked'))).toBe(false);
    expect(existsSync(join(worktree, 'notes.txt'))).toBe(true);

    const dropped = session(['reject', '1', 'Not', 'verified']);
    expect(dropped.status, dropped.stderr).toBe(0);
    expect(existsSync(worktree)).toBe(false);
    expect(git('status', '--porcelain')).toBe('');
    expect(cli(['log', '--job', '1']).stdout).toContain('work dropped: Not verified');
  });
});
