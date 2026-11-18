import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentRecord, BridgeJob, JobResult } from '@cogitator-ai/bridge';
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

async function serve(): Promise<Served> {
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

function results(): JobResult[] {
  const read = run(['results', '--json']);
  return read.status === 0 ? (JSON.parse(read.stdout) as JobResult[]) : [];
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

describe.skipIf(!posix)('the scoreboard of the bridge, on the real command line', () => {
  it('gives a job to auto, keeps what became of it, and counts a review on the work', async () => {
    const served = await serve();

    const before = orchestrator(['suggest', 'code']);
    expect(before.status, before.stderr).toBe(0);
    expect(before.stdout).toContain('How jobs of every type of the last 60 days went:');
    expect(before.stdout).toMatch(/ {2}claude {2}no job yet {2}<- auto takes this one/);
    expect(before.stdout).toMatch(/ {2}codex {3}no job yet\n/);
    expect(before.stdout).toContain('Not enough data to tell the agents apart');

    const handed = orchestrator([
      'delegate',
      'auto',
      '--type',
      'code',
      '--check',
      'test -f README.md',
      'Say what the README is for',
    ]);
    expect(handed.status, handed.stderr).toBe(0);
    expect(handed.stdout).toMatch(/Job #1 is with claude@\S+ \(submitted\)/);
    expect(handed.stdout).toMatch(/Why claude@\S+: Not enough data to tell the agents apart/);

    const work = await until(
      () => status()?.jobList.find((job) => job.number === 1),
      'the job to be there',
      served.output
    );
    expect(work).toMatchObject({ type: 'code' });
    expect(work.routed).toContain('and claude has none. It takes this one');
    const author = await agentOf(work.to);
    expect(author.harness).toBe('claude-code');
    await fakes.waitForTurn('claude', author.sessionId, () => true);
    const reported = as(author)(['send', '--job', '1', '--kind', 'report', 'It is a demo']);
    expect(reported.status, reported.stderr).toBe(0);
    const held = await until(
      () => results().find((result) => result.job === 1),
      'the result of the job',
      () => `${served.output()}\n${run(['log']).stdout.split('\n').slice(-12).join('\n')}`
    );
    expect(held).toMatchObject({
      agent: author.name,
      harness: 'claude-code',
      type: 'code',
      outcome: 'good',
      grounds: ['its checks passed'],
      verified: true,
    });

    const review = orchestrator([
      'delegate',
      'codex:new',
      '--type',
      'review',
      '--review-of',
      '1',
      'Review the work of job 1\nsay: [minor] README.md:1 - It says little',
    ]);
    expect(review.status, review.stderr).toBe(0);
    const counted = await until(
      () => results().find((result) => result.job === 1 && result.findings !== undefined),
      'the review to be counted on the work',
      served.output
    );
    expect(counted.findings).toEqual({ blocker: 0, major: 0, minor: 1, nit: 0 });
    expect(counted.grounds).toEqual(['its checks passed', 'a review found nothing above minor']);
    const listed = orchestrator(['results', '--type', 'code']);
    expect(listed.stdout).toMatch(
      /^#1 {2}claude@\S+ {2}code {2}good \(its checks passed, a review found nothing above minor\) {2}\S+, 2 letters\n$/
    );

    const after = orchestrator(['suggest', 'code', '--json']);
    expect(after.status, after.stderr).toBe(0);
    const suggestion = JSON.parse(after.stdout) as {
      basis: string;
      candidates: { harness: string; scored: number; good: number; enough: boolean }[];
    };
    expect(suggestion.basis).toBe('trial');
    expect(
      suggestion.candidates.find((candidate) => candidate.harness === 'claude-code')
    ).toMatchObject({ scored: 1, good: 1, enough: false });
    expect(orchestrator(['suggest', 'code']).stdout).toContain(
      'claude  1 of 1 held, not enough to tell (5 checked jobs are)'
    );

    const refused = orchestrator(['delegate', 'codex', '--type', 'two words', 'More']);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('A job type is one word');
    expect(served.output()).not.toContain('!');
  });
});
