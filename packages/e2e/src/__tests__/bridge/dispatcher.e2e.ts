import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BridgeClient,
  bridgePaths,
  callerFromEnv,
  type CallerIdentity,
  type JournalEntry,
} from '@cogitator-ai/bridge';
import { installFakeHarnesses, type FakeHarnesses } from '@cogitator-ai/bridge/testing';

const CLI = fileURLToPath(new URL('../../../../cli/dist/index.js', import.meta.url));

let bridgeDir: string;
let projectDir: string;
/** Stand-ins of Claude Code and Codex, so the dispatcher's adapters never run the real ones */
let fakes: FakeHarnesses | undefined;
const children: ChildProcess[] = [];
const clients: BridgeClient[] = [];

function env(): NodeJS.ProcessEnv {
  const base = {
    ...process.env,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    COGITATOR_BRIDGE_HOME: bridgeDir,
  };
  return fakes ? fakes.env(base) : base;
}

interface Dispatcher {
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
}

async function until(
  condition: () => boolean | Promise<boolean>,
  what: string,
  detail: () => string = () => ''
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}. ${detail()}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** `cogitator bridge serve` in its own process, resolved once it listens */
async function serve(): Promise<Dispatcher> {
  const child = spawn(process.execPath, [CLI, 'bridge', 'serve'], { env: env() });
  children.push(child);
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  await until(
    () => output.includes('Bridge dispatcher running'),
    'the dispatcher to start',
    () => output
  );
  return { child, output: () => output, exited };
}

function cli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, 'bridge', ...args], {
    env: env(),
    encoding: 'utf-8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A session of a harness, known to the bridge by the environment its harness gives it */
function session(
  variable: 'CLAUDE_CODE_SESSION_ID' | 'CODEX_THREAD_ID',
  id: string
): CallerIdentity {
  const caller = callerFromEnv({ [variable]: id }, projectDir);
  if (!caller) throw new Error('The environment named no session');
  return caller;
}

async function connect(caller?: CallerIdentity): Promise<BridgeClient> {
  const client = await BridgeClient.connect({
    socketPath: bridgePaths({ home: bridgeDir }).socket,
    ...(caller && { caller }),
  });
  clients.push(client);
  return client;
}

function scratch(prefix: string): string {
  const base = process.platform !== 'win32' && existsSync('/tmp') ? '/tmp' : tmpdir();
  return mkdtempSync(join(base, prefix));
}

beforeEach(() => {
  bridgeDir = scratch('cb-e2e-');
  projectDir = scratch('cb-proj-');
  fakes = process.platform === 'win32' ? undefined : installFakeHarnesses();
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
  }
  await fakes?.cleanup();
  rmSync(bridgeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe('bridge dispatcher', () => {
  it('carries a job between two sessions that only know each other by name', async () => {
    await serve();
    const claude = await connect(session('CLAUDE_CODE_SESSION_ID', 'claude-session-1'));
    const codex = await connect(session('CODEX_THREAD_ID', 'codex-thread-1'));
    const label = basename(projectDir);
    expect(claude.agent?.name).toBe(`claude@${label}`);
    expect(codex.agent?.name).toBe(`codex@${label}`);

    const { job } = await claude.createJob({
      to: 'codex',
      body: 'Write the tests for the rate limiter',
      checks: [{ command: 'pnpm test' }],
    });
    expect(job).toMatchObject({ number: 1, state: 'submitted', to: `codex@${label}` });
    expect(basename(job.cwd)).toBe(label);

    const [task] = await codex.inbox();
    expect(task.text.split('\n')[0]).toContain('not typed by the user');
    const question = await codex.send({
      job: 1,
      kind: 'question',
      body: 'Mock Redis or run a real one?',
    });
    expect(question.job.state).toBe('input-required');

    const [asked] = await claude.inbox();
    expect(asked.body).toBe('Mock Redis or run a real one?');
    await claude.send({ job: 1, kind: 'answer', body: 'Mock it' });
    expect((await codex.inbox())[0].body).toBe('Mock it');
    await codex.send({ job: 1, kind: 'report', body: 'Done: 14 tests pass' });

    expect(await claude.job(1)).toMatchObject({ state: 'completed', lettersUsed: 4 });
    expect((await claude.inbox())[0]).toMatchObject({ kind: 'report', outcome: 'completed' });
    expect((await claude.job(1)).verification).toBeUndefined();
  });

  it('shows the same exchange through the command line', async () => {
    await serve();
    const claude = await connect(session('CLAUDE_CODE_SESSION_ID', 'claude-session-1'));
    const codex = await connect(session('CODEX_THREAD_ID', 'codex-thread-1'));
    await claude.createJob({ to: 'codex', body: 'Write the tests' });
    await codex.inbox();

    const status = cli('status', '--json');
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ running: true, agents: 2, activeJobs: 1 });

    const second = cli('serve');
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('already running');

    await codex.send({ job: 1, kind: 'report', body: 'Done' });
    const log = cli('log', '--job', '1', '--json');
    expect(log.status).toBe(0);
    const entries = log.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as JournalEntry);
    expect(entries.map((entry) => entry.type)).toEqual([
      'job.created',
      'letter.queued',
      'letter.read',
      'job.state',
      'letter.queued',
      'job.state',
      'letter.handled',
    ]);
    expect(cli('log', '--job', '1').stdout).toContain('job is completed (was working)');
  });

  it('stops on SIGTERM, frees the socket and keeps the journal readable', async () => {
    const dispatcher = await serve();
    const claude = await connect(session('CLAUDE_CODE_SESSION_ID', 'claude-session-1'));
    await connect(session('CODEX_THREAD_ID', 'codex-thread-1'));
    await claude.createJob({ to: 'codex', body: 'Write the tests' });

    dispatcher.child.kill('SIGTERM');

    expect(await dispatcher.exited).toBe(0);
    expect(dispatcher.output()).toContain('Bridge dispatcher stopped');
    if (process.platform !== 'win32') {
      expect(existsSync(bridgePaths({ home: bridgeDir }).socket)).toBe(false);
    }
    expect(cli('status').status).toBe(1);
    expect(cli('log').stdout).toContain('task from claude@');
  });

  it('survives a crash: the next dispatcher takes over at once and the job goes on', async () => {
    const first = await serve();
    const claude = await connect(session('CLAUDE_CODE_SESSION_ID', 'claude-session-1'));
    const codex = await connect(session('CODEX_THREAD_ID', 'codex-thread-1'));
    await claude.createJob({ to: 'codex', body: 'Write the tests' });
    await codex.send({ job: 1, kind: 'question', body: 'Mock Redis?' });

    first.child.kill('SIGKILL');
    await first.exited;
    await until(() => claude.closed && codex.closed, 'the clients to notice the crash');
    await expect(claude.job(1)).rejects.toMatchObject({ code: 'not_running' });

    await serve();

    const claudeAgain = await connect(session('CLAUDE_CODE_SESSION_ID', 'claude-session-1'));
    const codexAgain = await connect(session('CODEX_THREAD_ID', 'codex-thread-1'));
    expect(claudeAgain.agent?.name).toBe(claude.agent?.name);
    expect(await claudeAgain.job(1)).toMatchObject({ state: 'input-required', lettersUsed: 2 });
    expect((await claudeAgain.inbox())[0].body).toBe('Mock Redis?');
    await claudeAgain.send({ job: 1, kind: 'answer', body: 'Yes' });
    await codexAgain.send({ job: 1, kind: 'report', body: 'Done' });
    expect((await claudeAgain.job(1)).state).toBe('completed');
  });
});
