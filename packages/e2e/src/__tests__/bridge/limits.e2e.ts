import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentRecord, BridgeJob } from '@cogitator-ai/bridge';
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

interface Served {
  output: () => string;
  stop: () => Promise<void>;
}

async function serve(extra: NodeJS.ProcessEnv = {}): Promise<Served> {
  const child = spawn(process.execPath, [CLI, 'bridge', 'serve'], { env: { ...env(), ...extra } });
  children.push(child);
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  await until(
    () => output.includes('Bridge dispatcher running'),
    'the dispatcher to start',
    () => output
  );
  return {
    output: () => output,
    stop: async () => {
      children.splice(children.indexOf(child), 1);
      const gone = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGINT');
      await gone;
    },
  };
}

function run(args: string[], session: NodeJS.ProcessEnv = {}, cwd: string = project) {
  const result = spawnSync(process.execPath, [CLI, 'bridge', ...args], {
    env: { ...env(), ...session },
    cwd,
    encoding: 'utf-8',
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The command line as the session that hands the jobs over runs it: a Codex thread. */
const orchestrator = (args: string[]) => run(args, { CODEX_THREAD_ID: 'thread-orchestrator' });

/** The command line as a session the bridge started runs it. */
const as = (agent: AgentRecord) => (args: string[]) =>
  run(
    args,
    agent.harness === 'codex'
      ? { CODEX_THREAD_ID: agent.sessionId }
      : { CLAUDE_CODE_SESSION_ID: agent.sessionId },
    agent.cwd
  );

interface Status {
  agentList: AgentRecord[];
  jobList: BridgeJob[];
}

function status(): Status | undefined {
  const read = run(['status', '--json']);
  return read.status === 0 ? (JSON.parse(read.stdout) as Status) : undefined;
}

const agentOf = (name: string): Promise<AgentRecord> =>
  until(
    () => status()?.agentList.find((agent) => agent.name === name && agent.status === 'active'),
    `${name} to be there`
  );

const git = (...args: string[]): string => {
  const result = spawnSync('git', args, { cwd: project, encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trimEnd();
};

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
  mkdirSync(join(project, '.cogitator'), { recursive: true });
  writeFileSync(
    join(project, '.cogitator', 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash(test:*)'] } })
  );
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

const jobOf = (number: number): BridgeJob | undefined =>
  status()?.jobList.find((job) => job.number === number);

describe.skipIf(!posix)('the limit of a harness, on the real command line', () => {
  it('hands the job of a Codex thread that ran into its usage limit to Claude Code', async () => {
    const served = await serve({
      FAKE_CODEX_TURN_FAIL: 'You\u2019ve hit your usage limit. Try again later.',
    });

    const handed = orchestrator(['delegate', 'codex:new', 'Write the notes\nsay: Written']);
    expect(handed.status, handed.stderr).toBe(0);
    expect(handed.stdout).toMatch(/Job #1 is with codex-?\d*@\S+ \(submitted\)/);

    const moved = await until(
      () => {
        const job = jobOf(1);
        return job?.redirects ? job : undefined;
      },
      'the job to go to another agent',
      () => `${served.output()}\n${run(['log']).stdout.split('\n').slice(-15).join('\n')}`
    );
    expect(moved.redirects?.[0]).toMatchObject({
      to: moved.to,
      why: "ran into the limit of codex (You've hit your usage limit. Try again later.)",
    });
    const taker = await agentOf(moved.to);
    expect(taker.harness).toBe('claude-code');
    const turn = await fakes.waitForTurn('claude', taker.sessionId, () => true);
    expect(turn.input).toContain('Write the notes');
    expect(turn.input).toContain(
      `[agent bridge] ${moved.redirects?.[0].from} had this job before you, and ran into the limit of codex`
    );

    const shown = run(['status']).stdout;
    expect(shown).toContain('Out of their limit, no job goes to them');
    expect(shown).toMatch(/codex {2}until \d\d:\d\d, then the bridge tries it again/);
    expect(run(['limits']).stdout).toMatch(/^codex {2}until \d\d:\d\d/);
    const log = run(['log']).stdout;
    expect(log).toMatch(/codex is out of its limit until \d\d:\d\d:\d\d, when it is tried again/);
    expect(log).toContain(`handed on from ${moved.redirects?.[0].from} to ${moved.to}`);

    const refused = orchestrator(['delegate', 'codex', 'One more']);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/codex is out of its limit until \d\d:\d\d/);
    const suggested = orchestrator(['suggest']).stdout;
    expect(suggested).toMatch(/codex .*takes no job now: out of its limit until/);

    const asAgent = orchestrator(['limits', '--clear', 'codex']);
    expect(asAgent.status).not.toBe(0);
    const cleared = run(['limits', '--clear', 'codex']);
    expect(cleared.status, cleared.stderr).toBe(0);
    expect(cleared.stdout).toContain('codex takes jobs again');
    expect(run(['limits']).stdout).toContain('No agent is out of its limit');

    const reported = as(taker)(['send', '--job', '1', '--kind', 'report', 'Written']);
    expect(reported.status, reported.stderr).toBe(0);
    const mail = await until(() => {
      const read = orchestrator(['inbox']);
      return read.stdout.includes('Written') ? read.stdout : undefined;
    }, 'the report');
    expect(mail).toContain('so the bridge handed the job to');
    expect(served.output()).not.toContain('!');
  });

  it('hears of the limit of Claude Code from its hook, and Codex finishes the job', async () => {
    const served = await serve({
      FAKE_CLAUDE_TURN_ERROR: 'rate_limit',
      FAKE_CLAUDE_TURN_ERROR_TEXT: "You've hit your session limit · resets 3:45pm",
    });

    const handed = orchestrator(['delegate', 'claude:new', 'Write the notes\nsay: Written']);
    expect(handed.status, handed.stderr).toBe(0);

    const mail = await until(
      () => {
        const read = orchestrator(['inbox', '--peek']);
        return read.stdout.includes('report from codex') ? read.stdout : undefined;
      },
      'the report of the agent that took the job over',
      () => `${served.output()}\n${run(['log']).stdout.split('\n').slice(-15).join('\n')}`
    );
    expect(mail).toContain('Written');
    expect(mail).toContain(
      "ran into the limit of claude (You've hit your session limit · resets 3:45pm), so the bridge handed the job to codex"
    );
    const limits = JSON.parse(run(['limits', '--json']).stdout) as {
      harness: string;
      told: boolean;
      until: string;
    }[];
    expect(limits).toMatchObject([{ harness: 'claude-code', told: true }]);
    const until345 = new Date(limits[0].until);
    expect([until345.getHours(), until345.getMinutes()]).toEqual([15, 45]);
    expect(run(['results', '--json']).stdout).toContain('"harness": "codex"');
    expect(served.output()).not.toContain('!');
  });
});
