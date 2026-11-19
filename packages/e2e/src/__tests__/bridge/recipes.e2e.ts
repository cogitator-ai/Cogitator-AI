import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

/** The command line as the session that starts the recipes runs it: a Codex thread. */
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

describe.skipIf(!posix)('a recipe of the bridge, on the real command line', () => {
  it('has a job done, checked, reviewed, fixed and reviewed again, across a restart of the dispatcher', async () => {
    let served = await serve();

    const started = orchestrator([
      'build',
      'codex',
      '--title',
      'Write the notes',
      '--check',
      'test -f notes.txt',
      '--rounds',
      '1',
      'Write the notes\nrun: echo edited > notes.txt\nsay: Written',
    ]);
    expect(started.status, started.stderr).toBe(0);
    expect(started.stdout).toContain(
      'Job #1 is the build (submitted): codex does the work, then it is checked and reviewed.'
    );
    expect(run(['status']).stdout).toContain('(recipe build)');

    const review = await until(
      () => status()?.jobList.find((job) => job.number === 3),
      'the review to be handed over',
      served.output
    );
    const worktree = join(project, '.cogitator', 'worktrees', 'job-2-write-the-notes');
    expect(review.cwd).toBe(worktree);
    expect(review.parent).toBe(1);
    const reviewer = await agentOf(review.to);
    expect(reviewer.harness).toBe('claude-code');
    const asked = await fakes.waitForTurn('claude', reviewer.sessionId, () => true);
    expect(asked.input).toContain('Review the work of job #2, done by ');
    expect(asked.input).toContain(`The work is in ${worktree}, a git worktree made from commit `);
    expect(asked.input).toContain('> run: echo edited > notes.txt');
    expect(existsSync(join(worktree, 'notes.txt'))).toBe(true);
    expect(readdirSync(join(bridgeDir, 'recipes'))).toHaveLength(1);

    await served.stop();
    served = await serve();

    const found = as(reviewer)([
      'send',
      '--job',
      '3',
      '--kind',
      'report',
      'Read it.\n[major] notes.txt:1 - The notes say nothing',
    ]);
    expect(found.status, found.stderr).toBe(0);

    const again = await until(
      () => status()?.jobList.find((job) => job.number === 5),
      'the second review to be handed over',
      () => `${served.output()}\n${run(['log']).stdout.split('\n').slice(-22).join('\n')}`
    );
    const second = await agentOf(again.to);
    expect(second.harness).toBe('claude-code');
    const looked = await fakes.waitForTurn('claude', second.sessionId, () => true);
    expect(looked.input).toContain('This is round 2.');
    expect(looked.input).toContain('[major] notes.txt:1 - The notes say nothing');
    const log = run(['log', '--job', '4']).stdout;
    expect(log).toContain('Fix what the review of your work on job #2 found');
    expect(log).toContain('checks confirmed the result');
    expect(log).not.toContain('no local daemon runs');
    const clean = as(second)(['send', '--job', '5', '--kind', 'report', '[none]']);
    expect(clean.status, clean.stderr).toBe(0);

    const mail = await until(
      () => {
        const read = orchestrator(['inbox']);
        return read.stdout.includes('passed the review') ? read.stdout : undefined;
      },
      'the report of the recipe',
      served.output
    );
    expect(mail).toContain(
      `passed the review of ${second.name} after 1 round of fixes: nothing at or above major is open.`
    );
    expect(mail).toContain('Checks: passed');
    expect(mail).toContain('Round 1: review in job #3');
    expect(mail).toContain('1 major, fixes in job #4.');
    expect(mail).toContain('take it with accept');
    expect(mail).toContain('[agent bridge] Findings: none.');
    expect(readdirSync(join(bridgeDir, 'recipes'))).toEqual([]);

    const taken = orchestrator(['accept', '2']);
    expect(taken.status, taken.stderr).toBe(0);
    expect(readFileSync(join(project, 'notes.txt'), 'utf8')).toBe('edited\n');
    expect(git('status', '--porcelain')).toBe('A  notes.txt');
    expect(served.output()).not.toContain('!');
  });

  it('sends the author of a fix back once, and holds nothing up for what the review noticed beside the job', async () => {
    const served = await serve();

    const started = orchestrator([
      'build',
      'codex',
      '--type',
      'fix',
      '--title',
      'Fix the notes',
      '--check',
      'test -f notes.txt',
      'Fix the notes\nrun: echo edited > notes.txt\nsay: Written',
    ]);
    expect(started.status, started.stderr).toBe(0);

    const review = await until(
      () => status()?.jobList.find((job) => job.number === 3),
      'the review to be handed over',
      served.output
    );
    const reviewer = await agentOf(review.to);
    const asked = await fakes.waitForTurn('claude', reviewer.sessionId, () => true);
    expect(asked.input).toContain('Judge the work against the job.');
    expect(asked.input).toContain('mark it as beside the job');
    const found = as(reviewer)([
      'send',
      '--job',
      '3',
      '--kind',
      'report',
      [
        'Read it.',
        '[major] notes.txt:1 - The notes say nothing',
        '[beside major] README.md:1 - The readme never said what the project is',
      ].join('\n'),
    ]);
    expect(found.status, found.stderr).toBe(0);

    const again = await until(
      () => status()?.jobList.find((job) => job.number === 5),
      'the second review to be handed over',
      () => `${served.output()}\n${run(['log']).stdout.split('\n').slice(-22).join('\n')}`
    );
    const second = await agentOf(again.to);
    const looked = await fakes.waitForTurn('claude', second.sessionId, (turn) =>
      turn.input.includes('This is round 2.')
    );
    const [task] = looked.input.split('--- Context of this job');
    expect(task).toContain('[major] notes.txt:1 - The notes say nothing');
    expect(task).not.toContain('The readme never said');
    const fixing = (status()?.agentList ?? [])
      .filter((agent) => agent.harness === 'codex' && agent.sessionId !== 'thread-orchestrator')
      .flatMap((agent) => fakes.transcript('codex', agent.sessionId))
      .find((turn) => turn.input.includes('Fix what the review of your work on job #2 found'));
    if (!fixing) throw new Error('The fixes reached no Codex session');
    const [fixes] = fixing.input.split('--- Context of this job');
    expect(fixes).toContain('To fix:\n[major] notes.txt:1 - The notes say nothing');
    expect(fixes).toContain('The review noticed 1 more beside the job.');
    expect(fixes).not.toContain('The readme never said');
    const still = as(second)([
      'send',
      '--job',
      '5',
      '--kind',
      'report',
      '[major] notes.txt:1 - The notes still say nothing',
    ]);
    expect(still.status, still.stderr).toBe(0);

    const mail = await until(
      () => {
        const read = orchestrator(['inbox']);
        return read.stdout.includes('is not clean') ? read.stdout : undefined;
      },
      'the report of the recipe',
      served.output
    );
    expect(mail).toContain(
      'The review of job #2 is not clean after 1 round of fixes: 1 major at or above major is still open.'
    );
    expect(mail).toContain(
      'Beside the job the review noticed 1 major. It is no part of this work and was not sent back: decide on it apart from it.'
    );
    expect(mail).toContain(
      '[beside major] README.md:1 - The readme never said what the project is'
    );
    expect(mail).toContain('1 major, 1 beside the job, fixes in job #4.');
    expect(mail).not.toContain('Round 3');
    expect(served.output()).not.toContain('!');
  });

  it('races two agents in worktrees of their own, and the work of one is taken', async () => {
    const served = await serve();
    const started = orchestrator([
      'race',
      '--to',
      'codex',
      '--to',
      'codex',
      '--title',
      'Write the notes',
      '--check',
      'test -f notes.txt',
      'Write the notes\nrun: echo raced > notes.txt\nsay: Written',
    ]);
    expect(started.status, started.stderr).toBe(0);
    expect(started.stdout).toContain(
      'Job #1 is the race (submitted): codex, codex do the job side by side.'
    );

    const mail = await until(
      () => {
        const read = orchestrator(['inbox']);
        return read.stdout.includes('asked to do the job') ? read.stdout : undefined;
      },
      'the report of the race',
      () => `${served.output()}\n${run(['log']).stdout.split('\n').slice(-20).join('\n')}`
    );
    expect(mail).toContain('2 agents were asked to do the job, 2 finished it.');
    expect(mail).toMatch(/- job #2 by codex\S+: completed, checks passed, 1 file \+1 -0/);
    expect(mail).toMatch(/- job #3 by codex\S+: completed, checks passed, 1 file \+1 -0/);
    expect(mail).toContain('take one with accept, and drop the others with reject');
    expect(existsSync(join(project, 'notes.txt'))).toBe(false);

    expect(orchestrator(['accept', '3']).status).toBe(0);
    expect(orchestrator(['reject', '2']).status).toBe(0);
    expect(readFileSync(join(project, 'notes.txt'), 'utf8')).toBe('raced\n');
    expect(
      readdirSync(join(project, '.cogitator', 'worktrees')).filter((name) =>
        name.startsWith('job-')
      )
    ).toEqual([]);
  });

  it('lets two agents debate a question, and reports where they ended', async () => {
    const served = await serve();
    const started = orchestrator([
      'debate',
      '--with',
      'codex=advocate',
      '--with',
      'codex=critic',
      '--rounds',
      '2',
      'Should the notes live in the repository?',
    ]);
    expect(started.status, started.stderr).toBe(0);
    expect(started.stdout).toContain(
      'Job #1 is the debate (submitted): codex, codex answer each other.'
    );

    const mail = await until(
      () => {
        const read = orchestrator(['inbox']);
        return read.stdout.includes('The debate of') ? read.stdout : undefined;
      },
      'the report of the debate',
      () => `${served.output()}\n${run(['log']).stdout.split('\n').slice(-20).join('\n')}`
    );
    expect(mail).toContain(
      'The debate of 2 agents ended after 2 rounds: the rounds ran out, and 0 of 2 said they agree at the end.'
    );
    expect(mail).toMatch(/codex\S* \(advocate\), round 2:/);
    expect(mail).toMatch(
      /Every turn is a job of its own, with all that was said: #2, #3, #[45], #[45]\./
    );
    expect(run(['log', '--job', '4']).stdout).toContain('(debate, round 2)');
  });

  it('has two agents plan apart, object once, and settle on one plan with a copy where it was asked for', async () => {
    const served = await serve();
    const started = orchestrator([
      'plan',
      '--with',
      'claude',
      '--with',
      'claude',
      '--out',
      'docs/notes-plan.md',
      '--constraint',
      'No new dependency',
      'Plan where the notes of the project live',
    ]);
    expect(started.status, started.stderr).toBe(0);
    expect(started.stdout).toContain(
      'Job #1 is the plan (submitted): claude, claude plan apart, then settle on one plan.'
    );

    const folder = join(project, '.cogitator', 'plans', 'job-1');
    const detail = (): string =>
      `${served.output()}\n${run(['log']).stdout.split('\n').slice(-24).join('\n')}`;
    const turnOf = async (job: number, has: string) => {
      const found = await until(
        () => status()?.jobList.find((listed) => listed.number === job),
        `job #${job} to be handed over`,
        detail
      );
      const agent = await agentOf(found.to);
      const turn = await fakes.waitForTurn('claude', agent.sessionId, (asked) =>
        asked.input.includes(has)
      );
      return { agent, input: turn.input };
    };
    const report = (agent: AgentRecord, job: number, body: string): void => {
      const sent = as(agent)(['send', '--job', String(job), '--kind', 'report', body]);
      expect(sent.status, sent.stderr).toBe(0);
    };

    const one = await turnOf(2, 'You are planner 1 of 2.');
    const two = await turnOf(3, 'You are planner 2 of 2.');
    expect(one.agent.name).not.toBe(two.agent.name);
    expect(one.input).toContain('> Plan where the notes of the project live');
    expect(one.input).toContain('No new dependency');
    report(one.agent, 2, '# Plan one\nThe notes live in docs/notes.');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(join(folder, 'draft-1.md'))).toBe(false);
    report(two.agent, 3, '# Plan two\nThe notes live next to the code.');

    const first = await turnOf(4, 'check it against the code');
    const second = await turnOf(5, 'check it against the code');
    expect(first.agent.name).toBe(one.agent.name);
    expect(first.input).toContain(join(folder, 'draft-2.md'));
    expect(second.input).toContain(join(folder, 'draft-1.md'));
    expect(readFileSync(join(folder, 'draft-1.md'), 'utf-8')).toContain(
      'The notes live in docs/notes.'
    );
    report(first.agent, 4, '1. take: notes next to the code are found by whoever reads the code');
    report(second.agent, 5, '1. gap: nothing says who keeps docs/notes current');

    const merge = await turnOf(6, 'Write the joint plan to');
    expect(merge.agent.name).toBe(one.agent.name);
    expect(merge.input).toContain(join(folder, 'critique-2.md'));
    writeFileSync(join(folder, 'plan.md'), '# Joint plan\nThe notes live next to the code.\n');
    writeFileSync(join(folder, 'decisions.md'), '1. taken\n2. taken\n');
    report(merge.agent, 6, 'Both files are written');

    const check = await turnOf(7, 'say whether you stand behind it');
    expect(check.agent.name).toBe(two.agent.name);
    report(
      check.agent,
      7,
      'OBJECTION: Steps - nothing moves the notes that exist already\nVERDICT: objections'
    );

    const revise = await turnOf(8, 'did not all sign it');
    expect(revise.agent.name).toBe(one.agent.name);
    expect(revise.input).toContain('Steps - nothing moves the notes that exist already');
    writeFileSync(
      join(folder, 'plan.md'),
      '# Joint plan\nThe notes live next to the code, the old ones are moved first.\n'
    );
    report(revise.agent, 8, 'Taken: a step moves them');

    const again = await turnOf(9, 'This is check 2.');
    report(again.agent, 9, 'It holds now.\nVERDICT: signed');

    const mail = await until(
      () => {
        const read = orchestrator(['inbox']);
        return read.stdout.includes('The joint plan of') ? read.stdout : undefined;
      },
      'the report of the plan',
      detail
    );
    expect(mail).toContain(`The joint plan of 2 agents is in ${join(folder, 'plan.md')}`);
    expect(mail).toContain('signed it at check 2.');
    expect(mail).toContain(`A copy is in ${join(project, 'docs', 'notes-plan.md')}.`);
    expect(mail).toContain('Every step is a job of its own: #2, #3, #4, #5, #6, #7, #8, #9.');
    expect(mail).not.toContain('Changed in the repository');
    expect(readFileSync(join(project, 'docs', 'notes-plan.md'), 'utf-8')).toBe(
      '# Joint plan\nThe notes live next to the code, the old ones are moved first.\n'
    );
    expect(run(['log', '--job', '6']).stdout).toContain('(plan, merge)');
    expect(readFileSync(join(folder, 'plan.md'), 'utf-8')).not.toContain('Not agreed');
    expect(git('status', '--porcelain')).toBe('?? docs/');
  });

  it('refuses a recipe the dispatcher does not know, with those it does', async () => {
    await serve();
    const refused = orchestrator(['recipe', 'waltz', 'Dance']);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(
      'There is no recipe "waltz". The recipes of this bridge: review, build, race, debate, plan'
    );
  });
});
