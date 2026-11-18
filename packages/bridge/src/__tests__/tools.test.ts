import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tool } from '@cogitator-ai/types';
import { BridgeClient } from '../client';
import { hostBridge, type BridgeHost } from '../host';
import { memoryBoard } from '../memory';
import { recipeAdapter } from '../recipes';
import { bridgePaths, canonicalPath } from '../paths';
import { TOOL_CALL_HINT_KEY } from '../tools/caller';
import { BRIDGE_INSTRUCTIONS } from '../tools/guidance';
import { bridgeTools } from '../tools/tools';
import { FakeAdapter } from './bridge-kit';
import { socketDir, tempDir } from './helpers';

let home: string;
let removeHome: () => void;
let project: string;
let removeProject: () => void;
const hosts: BridgeHost[] = [];
const errors: Error[] = [];

async function startHost(options: Parameters<typeof hostBridge>[0] = {}): Promise<BridgeHost> {
  const host = await hostBridge({
    home,
    tickMs: 25,
    onError: (error) => errors.push(error),
    ...options,
  });
  hosts.push(host);
  return host;
}

beforeEach(() => {
  ({ dir: home, remove: removeHome } = socketDir());
  const made = tempDir('cogitator-bridge-tools-');
  project = canonicalPath(made.dir);
  removeProject = made.remove;
  mkdirSync(join(project, '.git'));
  errors.length = 0;
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  removeHome();
  removeProject();
  expect(errors).toEqual([]);
});

/** What a harness adds to a call: nothing, the hint of a hook, or what Codex sends with it. */
interface Origin {
  hint?: { harness: string; session: string; cwd?: string };
  meta?: Record<string, unknown>;
  client?: string;
}

interface Session {
  call(name: string, args?: Record<string, unknown>, origin?: Origin): Promise<string>;
}

/** The tools as one server process gives them to the session it was started for. */
function session(env: NodeJS.ProcessEnv, base: Origin = {}): Session {
  const tools = bridgeTools({ socketPath: bridgePaths({ home }).socket, env, cwd: project });
  return {
    async call(name, args = {}, origin = base) {
      const found = tools.find((candidate) => candidate.name === name) as Tool | undefined;
      if (!found) throw new Error(`No tool ${name}`);
      const withHint = origin.hint ? { ...args, [TOOL_CALL_HINT_KEY]: origin.hint } : args;
      const parsed = (found.parameters as { parse(value: unknown): unknown }).parse(withHint);
      const context = {
        agentId: 'test',
        runId: 'run',
        signal: new AbortController().signal,
        request: {
          ...(origin.meta && { meta: origin.meta }),
          ...(origin.client && { client: { name: origin.client } }),
        },
      };
      return String(await found.execute(parsed as never, context as never));
    },
  };
}

const claude = (id = 'session-claude'): Session => session({ CLAUDE_CODE_SESSION_ID: id });

const codex = (thread = 'thread-codex'): Session =>
  session(
    {},
    { meta: { 'x-codex-turn-metadata': { thread_id: thread } }, client: 'codex-mcp-client' }
  );

function jobNumber(text: string): number {
  const match = /Job #(\d+)/.exec(text);
  if (!match) throw new Error(`No job number in: ${text}`);
  return Number(match[1]);
}

describe('bridgeTools', () => {
  it('are the tools of the bridge, each saying what it does to the world', () => {
    const tools = bridgeTools({ socketPath: bridgePaths({ home }).socket });

    expect(tools.map((tool) => tool.name)).toEqual([
      'delegate',
      'build',
      'review',
      'race',
      'debate',
      'ask',
      'answer',
      'report',
      'note',
      'inbox',
      'job',
      'jobs',
      'cancel',
      'diff',
      'accept',
      'reject',
      'remember',
      'recall',
      'forget',
      'agents',
      'suggest',
    ]);
    for (const tool of tools) {
      expect(tool.annotations?.openWorldHint).toBe(false);
      expect(
        tool.annotations?.readOnlyHint === true ||
          tool.annotations?.destructiveHint === (tool.name === 'reject')
      ).toBe(true);
      expect(JSON.stringify(tool.toJSON())).not.toContain(TOOL_CALL_HINT_KEY);
    }
    expect(BRIDGE_INSTRUCTIONS).toContain('end your turn');
  });

  it('carry a job from one session to another and back', async () => {
    const adapter = new FakeAdapter({ harness: 'codex' });
    await startHost({ adapters: [adapter] });
    const orchestrator = claude();
    const worker = codex();
    expect(await worker.call('inbox')).toBe('No letters wait for this session.');

    const handed = await orchestrator.call('delegate', {
      to: 'codex',
      task: 'Write the tests for the rate limiter\nCover the burst case',
    });
    const job = jobNumber(handed);
    expect(handed).toContain(`Job #${job} is with codex@`);
    expect(handed).toContain('end your turn');
    expect(adapter.texts[0]).toContain('Write the tests for the rate limiter');

    const asked = await worker.call('ask', { job, question: 'Mock Redis or run a real one?' });
    expect(asked).toContain('Asked claude@');
    expect(asked).toContain('input-required');

    const mail = await orchestrator.call('inbox');
    expect(mail).toContain('[agent bridge]');
    expect(mail).toContain('Mock Redis or run a real one?');

    expect(await orchestrator.call('answer', { job, answer: 'Mock it' })).toMatch(
      /Answered codex@.+ is working/
    );
    expect(await worker.call('note', { job, text: 'Half of the cases are in' })).toContain(
      'Sent the note to claude@'
    );
    expect(
      await worker.call('report', { job, result: '14 tests in limiter.test.ts, all pass' })
    ).toMatch(/Reported to claude@.+ is completed/);

    const seen = await orchestrator.call('job', { job });
    expect(seen).toContain(`#${job} completed`);
    expect(seen).toContain('report (completed) from codex@');
    expect(seen).toContain('14 tests in limiter.test.ts, all pass');
    expect(await orchestrator.call('jobs')).toBe('This session has no jobs in progress.');
    expect(await orchestrator.call('jobs', { all: true })).toContain(`#${job} completed`);
  });

  it('give a job a worktree and its checks, show what it changed, and take or drop its work', async () => {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trimEnd();
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    writeFileSync(join(project, 'README.md'), 'demo\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    let started = 0;
    const adapter = new FakeAdapter({
      harness: 'codex',
      createSession: async () => ({ sessionId: `thread-${(started += 1)}` }),
    });
    await startHost({ adapters: [adapter], rights: () => 'allow' });
    const orchestrator = claude();

    const handed = await orchestrator.call('delegate', {
      to: 'codex',
      task: 'Fix the limiter',
      worktree: true,
      checks: ['test -f fixed.txt'],
    });
    const job = jobNumber(handed);
    expect(handed).toContain(
      'It is done in a git worktree of its own, off your last commit: its changes come to you with accept.'
    );
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const worktree = adapter.sessions[0].cwd;
    expect(worktree).toBe(join(project, '.cogitator', 'worktrees', 'job-1-fix-the-limiter'));
    writeFileSync(join(worktree, 'fixed.txt'), 'fixed\n');

    const seen = await orchestrator.call('diff', { job });
    expect(seen.split('\n').slice(0, 2)).toEqual([
      expect.stringMatching(
        /^Job #1 changed 1 file, \+1 -0, in .+job-1-fix-the-limiter \(branch cogitator\/job-1-fix-the-limiter, since commit [0-9a-f]{10}\):$/
      ),
      'A fixed.txt  +1 -0',
    ]);
    expect(seen).toContain('+fixed');
    expect(await orchestrator.call('diff', { job, filesOnly: true })).not.toContain('+fixed');

    await codex('thread-1').call('report', { job, result: 'Fixed' });
    const mail = await vi.waitFor(async () => {
      const text = await orchestrator.call('inbox');
      expect(text).toContain('Fixed');
      return text;
    });
    expect(mail).toContain('[agent bridge] Changed in the worktree of the job');
    expect(mail).toContain('[agent bridge] Checks. Verified: the check passed.');
    const looked = await orchestrator.call('job', { job });
    expect(looked).toContain(`Done in a worktree of its own: ${worktree}`);
    expect(looked).toContain('Changed when it reported: 1 file, +1 -0');
    expect(await orchestrator.call('jobs', { all: true })).toContain(
      '(verified, work in its worktree)'
    );

    expect(await orchestrator.call('accept', { job })).toBe(
      `The work of job #1 is in ${project}: 1 file, +1 -0, staged and not committed. Look at it with git diff --cached and commit it yourself. The worktree is gone.`
    );
    expect(readFileSync(join(project, 'fixed.txt'), 'utf8')).toBe('fixed\n');
    expect(git('status', '--porcelain')).toBe('A  fixed.txt');
    expect(await orchestrator.call('jobs', { all: true })).toContain('(verified, work taken)');
    await expect(orchestrator.call('diff', { job })).rejects.toThrow(/its worktree is gone/);

    const again = jobNumber(
      await orchestrator.call('delegate', {
        to: 'codex:new',
        task: 'Try another way',
        worktree: true,
      })
    );
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(2));
    writeFileSync(join(adapter.sessions[1].cwd, 'other.txt'), 'other\n');
    await codex('thread-2').call('report', { job: again, result: 'Tried' });
    expect(await orchestrator.call('accept', { job: again, asBranch: 'feat/other' })).toMatch(
      /^The work of job #2 is the branch feat\/other, at commit [0-9a-f]{10}\. Your checkout is as it was, and the worktree is gone\.$/
    );
    expect(git('show', 'feat/other:other.txt')).toBe('other');

    const third = jobNumber(
      await orchestrator.call('delegate', { to: 'codex:new', task: 'A third way', worktree: true })
    );
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(3));
    await orchestrator.call('cancel', { job: third });
    expect(await orchestrator.call('reject', { job: third, reason: 'Not needed' })).toBe(
      'The work of job #3 is dropped, and its worktree is gone.'
    );
    expect(existsSync(adapter.sessions[2].cwd)).toBe(false);
  });

  it('hand a job over with its context, keep notes on the board and bring them to the next job', async () => {
    writeFileSync(
      join(project, 'limiter.ts'),
      'export const limit = 1;\nexport const burst = 1;\n'
    );
    const adapter = new FakeAdapter({ harness: 'codex' });
    const board = await memoryBoard({ store: ':memory:' });
    await startHost({ adapters: [adapter], board });
    const orchestrator = claude();
    const worker = codex();
    await worker.call('inbox');
    expect(await orchestrator.call('recall')).toBe('The board of this project is empty.');

    const first = jobNumber(
      await orchestrator.call('delegate', {
        to: 'codex',
        task: 'Raise the burst limit of the limiter to 3',
        context: {
          done: ['The burst test passes'],
          constraints: ['Do not touch the public API'],
          files: [{ path: 'limiter.ts', lines: '2', why: 'the constant' }],
          unknown: 'left out',
        },
      })
    );
    const task = await worker.call('inbox');
    expect(task).toContain('Done when:\n- The burst test passes');
    expect(task).toContain(
      '- limiter.ts lines 2-2 of 2: the constant\n  2| export const burst = 1;'
    );

    const kept = await worker.call('remember', {
      note: 'The limiter tests need Redis on port 6380',
    });
    expect(kept).toMatch(/^Kept as \S+, for every agent of this project\.$/);
    const own = await worker.call('remember', {
      note: 'The flaky test is skipped on this job',
      job: first,
      jobOnly: true,
    });
    expect(own).toMatch(new RegExp(`^Kept as \\S+, for the two agents of job #${first}\\.$`));
    await worker.call('report', {
      job: first,
      result: 'Raised it, the tests pass',
      lessons: ['Mocking Redis hid a race in the limiter: run a real one'],
    });

    const looked = await vi.waitFor(async () => {
      const text = await orchestrator.call('recall', { about: 'limiter redis' });
      expect(text).toContain('Mocking Redis hid a race');
      return text;
    });
    expect(looked).toMatch(
      /^\S+ {2}The limiter tests need Redis on port 6380 \(fact from codex@\S+, job #1, \d{4}-\d{2}-\d{2}\)$/m
    );
    expect(await orchestrator.call('recall', { kind: 'lesson' })).toMatch(
      /^\S+ {2}Mocking Redis hid a race in the limiter: run a real one \(lesson from codex@\S+, job #1, /
    );
    expect(await orchestrator.call('recall', { about: 'kubernetes' })).toBe(
      'Nothing on the board fits that.'
    );

    const id = /^Kept as (\S+),/.exec(kept)?.[1] ?? '';
    await expect(orchestrator.call('forget', { id })).rejects.toThrow(/only they, or the person/);
    expect(await worker.call('forget', { id })).toBe(
      `The note ${id} is off the board: The limiter tests need Redis on port 6380`
    );

    await orchestrator.call('delegate', {
      to: 'codex',
      task: 'Lower the burst limit of the limiter again',
    });
    const next = await worker.call('inbox');
    expect(next).toContain(
      'What earlier jobs like this one showed (what the agents that did them said, and how the jobs ended: weigh it):'
    );
    expect(next).toContain(
      '- Mocking Redis hid a race in the limiter: run a real one (lesson from codex@'
    );
    expect(next).not.toContain('Redis on port 6380');
    await board.close?.();
  });

  it('have a job built and reviewed by the conductor, and name the findings of a review', async () => {
    let started = 0;
    const adapter = new FakeAdapter({
      harness: 'codex',
      createSession: async () => ({
        sessionId: `thread-${(started += 1)}`,
        deliveredFirstLetter: true,
      }),
    });
    await startHost({ adapters: [adapter, recipeAdapter({ pollMs: 20 })] });
    const orchestrator = claude();
    const ended = (job: number) =>
      vi.waitFor(async () =>
        expect(await orchestrator.call('job', { job })).toContain(`#${job} completed`)
      );

    const built = await orchestrator.call('build', {
      to: 'codex',
      task: 'Fix the limiter',
      worktree: false,
      by: 'codex',
      rounds: 0,
      threshold: 'minor',
      context: { done: ['The burst test passes'] },
    });
    expect(built).toContain(
      'Job #1 is the build (submitted): codex does the work, then it is checked and reviewed.'
    );
    expect(built).toContain('end your turn');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    expect(adapter.sessions[0].firstLetter.text).toContain('Done when:\n- The burst test passes');
    await codex('thread-1').call('report', { job: 2, result: 'Fixed' });

    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(2));
    expect(adapter.sessions[1].firstLetter.text).toContain('Review the work of job #2');
    expect(
      await codex('thread-2').call('report', {
        job: 3,
        result: 'One thing',
        findings: [
          { severity: 'minor', summary: 'The name\nsays nothing', file: 'src/limiter.ts', line: 3 },
        ],
      })
    ).toMatch(/Reported to recipe.+ is completed/);
    await ended(1);
    const mail = await orchestrator.call('inbox');
    expect(mail).toContain(
      'The review of job #2 is not clean: 1 minor at or above minor is still open.'
    );
    expect(mail).toContain(
      '[agent bridge] Findings: 1 minor.\n[minor] src/limiter.ts:3 - The name says nothing'
    );

    const reviewed = await orchestrator.call('review', { job: 2, rounds: 0, focus: 'The names' });
    expect(reviewed).toContain('Job #4 is the review of job #2 (submitted).');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(3));
    expect(adapter.sessions[2].firstLetter.text).toContain('Look at this above all:\n> The names');
    await codex('thread-3').call('report', { job: 5, result: 'Clean', findings: [] });
    await ended(4);
    expect(await orchestrator.call('inbox')).toContain('passed the review of codex-');

    expect(await orchestrator.call('job', { job: 2 })).toContain(
      'Result as a code job: good (a review found nothing above minor)'
    );
    expect(await orchestrator.call('job', { job: 3 })).toContain('A review of job #2');

    await expect(orchestrator.call('review', { job: 2, threshold: 'huge' })).rejects.toThrow();
  });

  it('start a race and a debate of the conductor', async () => {
    let started = 0;
    const adapter = new FakeAdapter({
      harness: 'codex',
      createSession: async () => ({
        sessionId: `thread-${(started += 1)}`,
        deliveredFirstLetter: true,
      }),
    });
    await startHost({ adapters: [adapter, recipeAdapter({ pollMs: 20 })] });
    const orchestrator = claude();

    const debated = await orchestrator.call('debate', {
      question: 'Tabs or spaces?',
      debaters: [{ to: 'codex', role: 'advocate' }, { to: 'codex' }],
      rounds: 1,
    });
    expect(debated).toContain('Job #1 is the debate (submitted): codex, codex answer each other.');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(2));
    expect(adapter.sessions[0].firstLetter.text).toContain('You argue in favor');
    await codex('thread-1').call('report', { job: 2, result: 'Tabs.\nSTANCE: disagree' });
    await codex('thread-2').call('report', { job: 3, result: 'Spaces.\nSTANCE: disagree' });
    await vi.waitFor(async () =>
      expect(await orchestrator.call('job', { job: 1 })).toContain('#1 completed')
    );
    expect(await orchestrator.call('inbox')).toContain(
      'The debate of 2 agents ended after 1 round: the rounds ran out, and 0 of 2 said they agree at the end.'
    );

    const raced = await orchestrator.call('race', {
      to: ['codex', 'codex'],
      task: 'Fix the limiter',
      checks: ['pnpm test'],
      judge: 'codex',
    });
    expect(raced).toContain(
      'Job #4 is the race (submitted): codex, codex do the job side by side.'
    );
    await vi.waitFor(async () =>
      expect(await orchestrator.call('job', { job: 4 })).toContain('#4 failed')
    );
    expect(await orchestrator.call('inbox')).toContain(
      '2 agents were asked to do the job, 0 finished it'
    );
    await expect(orchestrator.call('race', { to: ['codex'], task: 'x' })).rejects.toThrow();
  });

  it('name the type of a job, leave the choice of the agent to the bridge and show how jobs went', async () => {
    let threads = 0;
    const adapter = new FakeAdapter({
      harness: 'codex',
      createSession: async () => ({ sessionId: `thread-${(threads += 1)}` }),
    });
    await startHost({ adapters: [adapter] });
    const orchestrator = claude();
    await codex().call('inbox');

    const before = await orchestrator.call('suggest', { type: 'code' });
    expect(before).toContain('How jobs of every type of the last 60 days went:');
    expect(before).toMatch(/ {2}codex {2}no job yet {2}<- auto takes this one/);
    expect(before).toContain('Not enough data to tell the agents apart');

    const handed = await orchestrator.call('delegate', {
      to: 'auto',
      task: 'Fix the burst limit',
      type: 'Code',
    });
    const job = jobNumber(handed);
    expect(handed).toMatch(
      /Job #1 is with codex@\S+ \(submitted\)\. Why codex@\S+: Not enough data/
    );
    await codex().call('report', { job, result: 'Fixed' });

    const asked = await orchestrator.call('delegate', {
      to: 'codex:new',
      task: 'Review the work of job 1',
      type: 'review',
      reviewOf: job,
    });
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    await codex('thread-1').call('report', {
      job: jobNumber(asked),
      result: 'One thing',
      findings: [{ severity: 'major', summary: 'The limit is off by one' }],
    });

    const seen = await orchestrator.call('job', { job });
    expect(seen).toContain('Why codex@');
    expect(seen).toContain('Result as a code job: bad (a review found 1 major)');
    const after = await orchestrator.call('suggest', { type: 'code' });
    expect(after).toContain('0 of 1 held, not enough to tell (5 checked jobs are)');
    expect(after).toContain('1 more nobody checked');

    await expect(
      orchestrator.call('delegate', { to: 'codex', task: 'More', type: 'two words' })
    ).rejects.toThrow(/A job type is one word/);
  });

  it('say so when the bridge was given no conductor for its recipes', async () => {
    await startHost({ adapters: [new FakeAdapter({ harness: 'codex' })] });
    await expect(claude().call('build', { to: 'codex', task: 'Fix the limiter' })).rejects.toThrow(
      'This bridge carries out no recipes'
    );
  });

  it('report a job that failed as failed', async () => {
    await startHost({ adapters: [new FakeAdapter({ harness: 'codex' })] });
    const worker = codex();
    await worker.call('inbox');
    const job = jobNumber(await claude().call('delegate', { to: 'codex', task: 'Fix the build' }));

    expect(
      await worker.call('report', { job, result: 'The toolchain is missing', failed: true })
    ).toContain('is failed');
  });

  it('act as the session a hook names, not the one the server was started for', async () => {
    await startHost({ adapters: [new FakeAdapter({ harness: 'codex' })] });
    await codex().call('inbox');
    const server = claude('session-before-clear');
    const first = jobNumber(await server.call('delegate', { to: 'codex', task: 'First job' }));

    const second = jobNumber(
      await server.call(
        'delegate',
        { to: 'codex', task: 'Second job' },
        { hint: { harness: 'claude-code', session: 'session-after-clear' } }
      )
    );

    const reader = await BridgeClient.connect({ socketPath: bridgePaths({ home }).socket });
    try {
      const [before, after] = [await reader.job(first), await reader.job(second)];
      expect(before.from).not.toBe(after.from);
      const agents = await reader.agents({ harness: 'claude-code' });
      expect(agents.map((agent) => agent.sessionId).sort()).toEqual([
        'session-after-clear',
        'session-before-clear',
      ]);
    } finally {
      await reader.close();
    }
  });

  it('show a job of others without its letters', async () => {
    await startHost({ adapters: [new FakeAdapter({ harness: 'codex' })] });
    await codex().call('inbox');
    const job = jobNumber(
      await claude().call('delegate', { to: 'codex', task: 'Rotate the signing key' })
    );

    const seen = await claude('session-other').call('job', { job });

    expect(seen).toContain(`#${job} working`);
    expect(seen).toContain('"Rotate the signing key"');
    expect(seen).toContain('this session is neither');
    expect(seen).not.toContain('task from');
  });

  it('take a job back and tell the agent that had it', async () => {
    const adapter = new FakeAdapter({ harness: 'codex' });
    await startHost({ adapters: [adapter] });
    await codex().call('inbox');
    const orchestrator = claude();
    const job = jobNumber(await orchestrator.call('delegate', { to: 'codex', task: 'Port it' }));

    expect(await orchestrator.call('cancel', { job, reason: 'Not needed any more' })).toMatch(
      new RegExp(`Job #${job} is canceled, codex@.+ is told`)
    );
    expect(adapter.texts.at(-1)).toContain('Not needed any more');
    await expect(codex().call('cancel', { job })).rejects.toThrow();
  });

  it('list who can take a job and what the bridge can start', async () => {
    await startHost({
      adapters: [
        new FakeAdapter({
          harness: 'codex',
          createSession: async () => ({ sessionId: 'thread-new' }),
        }),
      ],
    });
    await codex().call('inbox');

    const listed = await claude().call('agents');

    expect(listed).toMatch(/claude@\S+ {2}claude-code, this session/);
    expect(listed).toMatch(/codex@\S+ {2}codex/);
    expect(listed).toContain('The bridge starts a session for a job handed to: codex');
  });

  it('say so when the bridge can start nothing', async () => {
    await startHost();

    expect(await claude().call('agents')).toContain('The bridge cannot start sessions here');
  });

  it('pass on what the bridge refuses, in its own words', async () => {
    await startHost();
    const orchestrator = claude();

    await expect(orchestrator.call('delegate', { to: 'codex', task: 'Do it' })).rejects.toThrow(
      /No codex session works in this project/
    );
    await expect(orchestrator.call('report', { job: 41, result: 'Done' })).rejects.toThrow(/41/);
  });

  it('decide a permission request: allow it, refuse it, or leave it to the user', async () => {
    const asked: string[] = [];
    await startHost({
      rights: ({ ask }) => (ask.command?.startsWith('git push') ? 'allow' : 'ask'),
      person: { ask: ({ letter }) => void asked.push(letter.kind), settle: () => undefined },
    });
    const orchestrator = claude();
    const worker = codex();
    await worker.call('inbox');
    const job = jobNumber(await orchestrator.call('delegate', { to: 'codex', task: 'Ship it' }));
    await worker.call('inbox');
    const raw = await BridgeClient.connect({
      socketPath: bridgePaths({ home }).socket,
      caller: { harness: 'codex', sessionId: 'thread-codex', cwd: project },
    });
    const request = (command: string) =>
      raw.send({
        job,
        kind: 'permission',
        body: `Run \`${command}\``,
        ask: { tool: 'Bash', access: 'command', command },
      });

    try {
      const push = await request('git push origin main');
      expect(await orchestrator.call('inbox')).toContain('[agent bridge] Yours to decide');
      expect(await orchestrator.call('answer', { job, decision: 'allow' })).toMatch(
        /^Allowed codex@\S+\. Job #1 is working\.$/
      );
      expect(await raw.verdict({ letter: push.letter.id })).toMatchObject({
        verdict: 'allow',
        reason: 'Allowed',
      });

      const tag = await request('git tag v1');
      await expect(orchestrator.call('answer', { job, decision: 'allow' })).rejects.toThrow(
        /is the person's to allow/
      );
      expect(
        await orchestrator.call('answer', { job, decision: 'deny', answer: 'No tags today' })
      ).toMatch(/^Refused codex@/);
      expect(await raw.verdict({ letter: tag.letter.id })).toMatchObject({
        verdict: 'deny',
        reason: 'No tags today',
      });

      await worker.call('ask', { job, question: 'Which release?' });
      await expect(orchestrator.call('answer', { job })).rejects.toThrow(
        /Say the answer, or the decision/
      );
      expect(await orchestrator.call('answer', { job, decision: 'person' })).toMatch(
        /^Left to the user: their answer goes to codex@\S+\. Tell the user in one line that codex@\S+ waits for their word on job #1, which they give with "cogitator bridge asks"\.$/
      );
      expect(asked).toEqual(['permission', 'question']);
    } finally {
      await raw.close();
    }
  });

  it('tell the agent what to tell the user when no dispatcher runs', async () => {
    await expect(claude().call('jobs')).rejects.toThrow(
      /No bridge dispatcher runs on this machine.+cogitator bridge serve/
    );
  });

  it('tell the agent when nothing says which session is calling', async () => {
    await startHost();

    await expect(session({}).call('jobs')).rejects.toThrow(
      /cannot tell which session is calling.+cogitator bridge doctor/
    );
  });

  it('go on working after the dispatcher was restarted', async () => {
    const first = await startHost({ adapters: [new FakeAdapter({ harness: 'codex' })] });
    const orchestrator = claude();
    await codex().call('inbox');
    const job = jobNumber(await orchestrator.call('delegate', { to: 'codex', task: 'Do it' }));
    await first.close();
    hosts.length = 0;

    await startHost({ adapters: [new FakeAdapter({ harness: 'codex' })] });

    expect(await orchestrator.call('jobs')).toContain(`#${job} `);
  });
});
