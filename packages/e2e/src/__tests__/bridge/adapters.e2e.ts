import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BridgeClient,
  bridgePaths,
  claudeWaitHook,
  type BridgeStatus,
  type HealthCheck,
  type JournalEntry,
} from '@cogitator-ai/bridge';
import { installFakeHarnesses, type FakeHarnesses } from '@cogitator-ai/bridge/testing';

const CLI = fileURLToPath(new URL('../../../../cli/dist/index.js', import.meta.url));
/** How a session of a stand-in harness runs the bridge's command line */
const BRIDGE = `"${process.execPath}" "${CLI}" bridge`;

const posix = process.platform !== 'win32';

let fakes: FakeHarnesses;
let bridgeDir: string;
let project: string;
let watcher: BridgeClient | undefined;
const children: ChildProcess[] = [];

function scratch(prefix: string): string {
  const base = posix && existsSync('/tmp') ? '/tmp' : tmpdir();
  return realpathSync(mkdtempSync(join(base, prefix)));
}

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return fakes.env({
    ...process.env,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    COGITATOR_BRIDGE_HOME: bridgeDir,
    ...extra,
  });
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

/** `cogitator bridge serve` with the stand-ins of Claude Code and Codex on its PATH */
async function serve(extra: NodeJS.ProcessEnv = {}): Promise<() => string> {
  const child = spawn(process.execPath, [CLI, 'bridge', 'serve'], { env: env(extra) });
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

function cli(args: string[], extra: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [CLI, 'bridge', ...args], {
    env: env(extra),
    cwd: project,
    encoding: 'utf-8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function watch(): Promise<BridgeClient> {
  watcher ??= await BridgeClient.connect({ socketPath: bridgePaths({ home: bridgeDir }).socket });
  return watcher;
}

/** A script in the project a stand-in session runs with `run: sh ./<name>` */
function script(name: string, body: string): void {
  const path = join(project, name);
  writeFileSync(path, `#!/bin/sh\nset -e\n${body}\n`);
  chmodSync(path, 0o755);
}

function journalOf(job: number): Promise<JournalEntry[]> {
  return watch().then((client) => client.readJournal({ job }));
}

beforeEach(() => {
  bridgeDir = scratch('cb-e2e-');
  project = scratch('cb-proj-');
  fakes = installFakeHarnesses({ env: { COGITATOR_BRIDGE_HOME: bridgeDir } });
});

afterEach(async () => {
  await watcher?.close().catch(() => undefined);
  watcher = undefined;
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    }
  }
  await fakes.cleanup();
  rmSync(bridgeDir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe.skipIf(!posix)('bridge adapters', () => {
  it('carries a job from a Claude Code window to a Codex thread it starts, a question and the report back', async () => {
    script(
      'delegate.sh',
      `printf 'Write the tests for the rate limiter\\nrun: sh ./ask.sh\\n' | ${BRIDGE} delegate codex - --check "pnpm test"`
    );
    script(
      'ask.sh',
      `printf 'Mock Redis or run a real one?\\nrun: sh ./answer.sh\\n' | ${BRIDGE} send --job 1 --kind question -`
    );
    script(
      'answer.sh',
      `printf 'Mock it\\nrun: sh ./report.sh\\n' | ${BRIDGE} send --job 1 --kind answer -`
    );
    script('report.sh', `${BRIDGE} send --job 1 --kind report "Done: 14 tests pass"`);
    mkdirSync(join(project, '.claude'));
    writeFileSync(
      join(project, '.claude', 'settings.local.json'),
      JSON.stringify(claudeWaitHook({ bridgeCommand: BRIDGE, timeoutS: 120 }))
    );
    await serve();
    await fakes.startCodexDaemon();
    const claude = await fakes.openClaudeWindow({ cwd: project, env: env() });

    await fakes.say(claude, 'run: sh ./delegate.sh');

    const client = await watch();
    const done = await until(
      async () => {
        const [job] = await client.jobs({});
        return job?.state === 'completed' ? job : undefined;
      },
      'the job to be reported on',
      () => JSON.stringify(fakes.transcript('claude', claude))
    );
    expect(done).toMatchObject({ number: 1, checks: [{ command: 'pnpm test' }], lettersUsed: 4 });
    const [orchestrator] = await client.agents({ harness: 'claude-code' });
    const [worker] = await client.agents({ harness: 'codex' });
    expect(orchestrator).toMatchObject({ sessionId: claude, delivery: 'hook', name: done.from });
    expect(worker).toMatchObject({ delivery: 'queue', name: done.to, status: 'active' });

    const report = await fakes.waitForTurn('claude', claude, (turn) =>
      turn.input.includes('Done: 14 tests pass')
    );
    expect(report.wokenBy).toBe('hook');
    const claudeTurns = fakes.transcript('claude', claude);
    expect(claudeTurns.map((turn) => turn.wokenBy)).toEqual(['user', 'hook', 'hook']);
    expect(claudeTurns[1].input.split('\n').slice(0, 2)).toEqual([
      expect.stringMatching(
        /^\[agent bridge\] job #1 .* \| question from codex@.* \| not typed by the user$/
      ),
      'Mock Redis or run a real one?',
    ]);
    const codexTurns = fakes.transcript('codex', worker.sessionId);
    expect(codexTurns.map((turn) => turn.wokenBy)).toEqual(['exec', 'queue']);
    expect(codexTurns[0].input).toContain('Write the tests for the rate limiter');
    expect(codexTurns[1].input.split('\n')[1]).toBe('Mock it');

    const delivered = (await journalOf(1)).filter((entry) => entry.type === 'letter.delivered');
    expect(delivered.map((entry) => [entry.agent, entry.data?.via ?? 'adapter'])).toEqual([
      [worker.name, 'adapter'],
      [orchestrator.name, 'wait'],
      [worker.name, 'adapter'],
      [orchestrator.name, 'wait'],
    ]);
    await until(async () => {
      const status = await client.status();
      return status.waiting.includes(orchestrator.name);
    }, 'the window to wait for mail again');
  });

  it('starts a Claude Code session for a job from Codex, and Codex wakes with its report', async () => {
    fakes.trustFolder(project);
    script(
      'delegate.sh',
      `printf 'Review the diff\\nrun: sh ./report.sh\\n' | ${BRIDGE} delegate claude -`
    );
    script('report.sh', `${BRIDGE} send --job 1 --kind report "Two problems found"`);
    await serve();
    await fakes.startCodexApp();
    const thread = await fakes.openCodexThread({ cwd: project });

    await fakes.run(
      'codex',
      ['queue', '--thread', thread, '--message', 'run: sh ./delegate.sh', '--resume'],
      {
        env: env(),
      }
    );

    const report = await fakes.waitForTurn('codex', thread, (turn) =>
      turn.input.includes('Two problems found')
    );
    expect(report.input.split('\n')[0]).toMatch(
      /\| report from claude@.* \| not typed by the user$/
    );
    const client = await watch();
    expect(await client.job(1)).toMatchObject({ state: 'completed' });
    const [started] = await fakes.claudeSessions();
    expect(started).toMatchObject({ kind: 'background', cwd: project });
    const [reviewer] = await client.agents({ harness: 'claude-code' });
    expect(reviewer).toMatchObject({ sessionId: started.sessionId, status: 'active' });
    const registered = (await client.readJournal({})).filter(
      (entry) => entry.type === 'agent.registered' && entry.agent === reviewer.name
    );
    expect(registered).toHaveLength(1);
    expect(
      await client.agents({ harness: 'claude-code', statuses: ['active', 'starting', 'gone'] })
    ).toHaveLength(1);

    await until(
      async () => (await client.status()).waiting.includes(reviewer.name),
      'its hook to wait'
    );
    const status = cli(['status']);
    expect(status.stdout).toMatch(
      new RegExp(`${reviewer.name}\\s+claude-code.*, hook waits for mail`)
    );
  });

  it('fails the job with what to do when Claude Code does not trust the folder', async () => {
    script('delegate.sh', `${BRIDGE} delegate claude "Review the diff"`);
    await serve();
    await fakes.startCodexApp();
    const thread = await fakes.openCodexThread({ cwd: project });

    await fakes.run(
      'codex',
      ['queue', '--thread', thread, '--message', 'run: sh ./delegate.sh', '--resume'],
      {
        env: env(),
      }
    );

    const failure = await fakes.waitForTurn('codex', thread, (turn) =>
      turn.input.includes('does not trust')
    );
    expect(failure.input).toContain(
      `Claude Code does not trust ${project} yet. Open the folder in Claude Code once and accept its trust prompt`
    );
    expect((await (await watch()).job(1)).state).toBe('failed');
    expect(cli(['log', '--job', '1']).stdout).toContain(
      'Job #1 has failed: the bridge could not start a claude-code session'
    );
  });

  it('tells in the journal when a Codex thread got a letter nothing will wake it for', async () => {
    script('delegate.sh', `${BRIDGE} delegate codex "Write the tests"`);
    await serve();
    const claude = await fakes.openClaudeWindow({ cwd: project, env: env() });
    await fakes.say(claude, 'run: sh ./delegate.sh');
    const client = await watch();
    const worker = await until(
      async () => (await client.agents({ harness: 'codex', statuses: ['active'] }))[0],
      'the thread to start'
    );
    await fakes.waitForTurn('codex', worker.sessionId, () => true);

    const claudeAgent = (await client.agents({ harness: 'claude-code' }))[0];
    script('note.sh', `${BRIDGE} send --job 1 --kind note "Use vitest"`);
    await fakes.say(claude, 'run: sh ./note.sh');
    await until(
      async () => (await journalOf(1)).find((entry) => entry.data?.note !== undefined),
      'the note about the sleeping thread'
    );

    const log = cli(['log', '--job', '1']).stdout;
    expect(log).toContain(`delivered to ${worker.name}`);
    expect(log).toContain('nothing wakes the thread');
    expect(log).toContain('codex app-server daemon start');
    expect(claudeAgent.delivery).toBe('hook');
  });
});

describe.skipIf(!posix)('bridge doctor', () => {
  function sections(stdout: string): Record<string, Record<string, HealthCheck['status']>> {
    const report = JSON.parse(stdout) as {
      sections: { harness: string; checks: HealthCheck[] }[];
    };
    return Object.fromEntries(
      report.sections.map((section) => [
        section.harness,
        Object.fromEntries(section.checks.map((check) => [check.id, check.status])),
      ])
    );
  }

  it('passes with warnings on a machine that has both harnesses and a dispatcher', async () => {
    await serve();

    const doctor = cli(['doctor', '--json']);

    expect(doctor.status).toBe(0);
    expect(sections(doctor.stdout)).toEqual({
      bridge: { dispatcher: 'ok' },
      'claude-code': {
        version: 'ok',
        background: 'ok',
        sessions: 'ok',
        trust: 'warn',
        hook: 'warn',
      },
      codex: { version: 'ok', queue: 'ok', exec: 'ok', daemon: 'warn' },
    });
    const status = JSON.parse(cli(['status', '--json']).stdout) as BridgeStatus;
    expect(status.adapters).toEqual(['claude-code', 'codex']);

    const text = cli(['doctor']).stdout;
    expect(text).toContain('✓ Claude Code: 2.1.292 (Claude Code)');
    expect(text).toContain('! Local daemon: does not run');
    expect(text).toContain('codex app-server daemon start');
    expect(text).toMatch(/Merge into .*settings\.local\.json: \{"hooks":\{"Stop"/);
  });

  it('fails without a dispatcher and with a harness too old for the bridge', () => {
    const doctor = cli(['doctor', '--json'], { FAKE_CODEX_MISSING: 'queue' });

    expect(doctor.status).toBe(1);
    const found = sections(doctor.stdout);
    expect(found.bridge).toEqual({ dispatcher: 'fail' });
    expect(found.codex.queue).toBe('fail');
  });

  it('sees the hook once the project carries it', () => {
    mkdirSync(join(project, '.claude'));
    writeFileSync(
      join(project, '.claude', 'settings.json'),
      JSON.stringify(claudeWaitHook({ bridgeCommand: BRIDGE }))
    );

    expect(sections(cli(['doctor', '--json']).stdout)['claude-code'].hook).toBe('ok');
  });
});
