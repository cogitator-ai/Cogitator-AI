import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCheckpointStore } from '@cogitator-ai/workflows';
import { BridgeDispatcher } from '../dispatcher';
import { recipeAdapter } from '../recipes';
import { SqliteBridgeStore } from '../store/sqlite';
import type { AgentRecord, BridgeJob } from '../types';
import { FakeAdapter } from './bridge-kit';

let scratch: string;
let repo: string;
let store: SqliteBridgeStore;
let bridge: BridgeDispatcher;
let errors: Error[];
let claude: FakeAdapter;
let codex: FakeAdapter;
let starter: AgentRecord;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd();

const until = <T>(look: () => T | Promise<T>): Promise<T> =>
  vi.waitFor(look, { timeout: 5_000, interval: 5 });

/** Which sessions of Codex wake for a letter: all of them unless a test says otherwise. */
let codexWakes: (agent: AgentRecord) => boolean;
let checkpoints: InMemoryCheckpointStore;
let sessions: number;

function spawning(harness: string): FakeAdapter {
  return new FakeAdapter({
    harness,
    ...(harness === 'codex' && { wakesFor: async (agent) => codexWakes(agent) }),
    createSession: async () => ({
      sessionId: `${harness}-started-${(sessions += 1)}`,
      deliveredFirstLetter: true,
    }),
  });
}

/** A dispatcher on the store of the test: a second one stands for a dispatcher that restarted. */
function open(): BridgeDispatcher {
  claude = spawning('claude-code');
  codex = spawning('codex');
  return new BridgeDispatcher({
    store,
    onError: (error) => errors.push(error),
    adapters: [claude, codex, recipeAdapter({ checkpoints, pollMs: 20 })],
    rights: () => 'allow',
  });
}

interface Task {
  agent: string;
  job: number;
  cwd: string;
  text: string;
}

function tasksOf(adapter: FakeAdapter): Task[] {
  return [
    ...adapter.sessions.map((session) => ({
      agent: session.agentName,
      job: session.job.number,
      cwd: session.cwd,
      text: session.firstLetter.text,
    })),
    ...adapter.delivered
      .filter((delivery) => delivery.letter.kind === 'task')
      .map((delivery) => ({
        agent: delivery.agent.name,
        job: delivery.job.number,
        cwd: delivery.job.cwd,
        text: delivery.letter.text,
      })),
  ];
}

function taskOf(adapter: FakeAdapter, job: number): Promise<Task> {
  return until(() => {
    const found = tasksOf(adapter).find((task) => task.job === job);
    if (!found) throw new Error(`Job #${job} did not reach ${adapter.harness} yet`);
    return found;
  });
}

async function ended(job: number): Promise<BridgeJob> {
  return until(async () => {
    const found = await bridge.job(job);
    expect(['completed', 'failed', 'canceled']).toContain(found.state);
    expect(found.checking).toBeUndefined();
    return found;
  });
}

async function reportOf(job: number): Promise<string> {
  await ended(job);
  return (await bridge.letters({ job, kinds: ['report'] }))[0]?.body ?? '';
}

const start = (name: string, input: unknown, body: string) =>
  bridge.createJob(starter.name, { to: 'recipe', body, recipe: { name, input } });

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-strategies-')));
  repo = join(scratch, 'demo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'README.md'), 'demo\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');

  store = await SqliteBridgeStore.open(':memory:');
  errors = [];
  codexWakes = () => true;
  checkpoints = new InMemoryCheckpointStore();
  sessions = 0;
  bridge = open();
  starter = await bridge.register({
    harness: 'claude-code',
    sessionId: 'session-claude',
    cwd: repo,
    project: repo,
  });
});

afterEach(async () => {
  await bridge.close();
  store.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('the recipe race', () => {
  it('gives the same job to several agents in worktrees of their own, and lays the results side by side', async () => {
    await start(
      'race',
      { to: ['codex', 'claude'], checks: [{ command: 'test -f done.txt' }], judge: 'codex' },
      'Write the notes'
    );
    const first = await taskOf(codex, 2);
    const second = await taskOf(claude, 3);
    expect(first.cwd).not.toBe(second.cwd);
    expect(first.cwd).toContain(join('.cogitator', 'worktrees'));
    expect(first.text).toContain('Write the notes');
    expect(first.text).toContain('This is attempt 1 of 2 at the same job');
    expect(second.text).toContain('This is attempt 2 of 2 at the same job');
    expect(second.agent).not.toBe(starter.name);

    writeFileSync(join(first.cwd, 'done.txt'), 'done\n');
    await bridge.send(first.agent, { job: 2, kind: 'report', body: 'Notes written' });
    await bridge.send(second.agent, { job: 3, kind: 'report', body: 'Notes drafted' });

    const judge = await taskOf(codex, 4);
    expect(judge.agent).not.toBe(first.agent);
    expect(judge.cwd).toBe(repo);
    expect(judge.text).toContain('Compare 2 attempts at the same job');
    expect(judge.text).toContain(
      `- job #2 by ${first.agent}: checks passed, 1 file +1 -0, in ${first.cwd}`
    );
    expect(judge.text).toContain(
      `- job #3 by ${second.agent}: checks not passed, 0 files +0 -0, in ${second.cwd}`
    );
    await bridge.send(judge.agent, {
      job: 4,
      kind: 'report',
      body: 'The first one holds.\nTAKE: job #2',
    });

    const report = await reportOf(1);
    expect((await bridge.job(1)).state).toBe('completed');
    expect(report).toContain('2 agents were asked to do the job, 2 finished it.');
    expect(report).toContain(
      `- job #2 by ${first.agent}: completed, checks passed, 1 file +1 -0, the pick of the judge`
    );
    expect(report).toContain(`- job #3 by ${second.agent}: completed, checks not passed`);
    expect(report).toContain(`${judge.agent} compared them in job #4 and would take job #2:`);
    expect(report).toContain('> The first one holds.');
    expect(report).toContain('take one with accept, and drop the others with reject');

    expect((await bridge.accept(starter.name, { job: 2 })).state).toBe('accepted');
    await bridge.reject(starter.name, { job: 3 });
    expect(git(repo, 'status', '--porcelain')).toBe('A  done.txt');
    expect(errors).toEqual([]);
  });

  it('takes two sessions of one harness, and says which attempts did not start or finish', async () => {
    await start('race', { to: ['codex', 'codex', starter.name] }, 'Write the notes');
    const first = await taskOf(codex, 2);
    const second = await taskOf(codex, 3);
    expect(first.agent).not.toBe(second.agent);
    await bridge.send(first.agent, { job: 2, kind: 'report', body: 'Written' });
    await bridge.send(second.agent, {
      job: 3,
      kind: 'report',
      body: 'Could not',
      outcome: 'failed',
    });

    const report = await reportOf(1);
    expect((await bridge.job(1)).state).toBe('completed');
    expect(report).toContain('3 agents were asked to do the job, 1 finished it.');
    expect(report).toContain(`- job #2 by ${first.agent}: completed, no checks, 0 files +0 -0`);
    expect(report).toContain(`- job #3 by ${second.agent}: failed (reported as failed by `);
    expect(report).toContain(`- ${starter.name}: not started: `);
    expect(report).not.toContain('compared them');
  });

  it('fails when no attempt finished, and is refused with fewer than two agents', async () => {
    await expect(start('race', { to: ['codex'] }, 'Write the notes')).rejects.toThrow(
      'The recipe race cannot start with this input: to:'
    );
    await start('race', { to: ['codex', 'claude'], judge: 'codex' }, 'Write the notes');
    const first = await taskOf(codex, 2);
    const second = await taskOf(claude, 3);
    for (const [agent, job] of [
      [first.agent, 2],
      [second.agent, 3],
    ] as const) {
      await bridge.send(agent, { job, kind: 'report', body: 'No', outcome: 'failed' });
    }
    const report = await reportOf(1);
    expect((await bridge.job(1)).state).toBe('failed');
    expect(report).toContain(
      '2 agents were asked to do the job, 0 finished it: there is nothing to take.'
    );
    expect(tasksOf(codex)).toHaveLength(1);
  });
});

describe('a race or a debate the bridge cannot finish as asked', () => {
  it('lays the attempts out when nobody can judge them', async () => {
    await start('race', { to: ['codex', 'claude'], judge: 'gemini' }, 'Write the notes');
    const first = await taskOf(codex, 2);
    const second = await taskOf(claude, 3);
    await bridge.send(first.agent, { job: 2, kind: 'report', body: 'Written' });
    await bridge.send(second.agent, { job: 3, kind: 'report', body: 'Drafted' });

    const report = await reportOf(1);
    expect((await bridge.job(1)).state).toBe('completed');
    expect(report).toContain('2 agents were asked to do the job, 2 finished it.');
    expect(report).toContain(`- job #2 by ${first.agent}: completed, no checks`);
    expect(report).toContain('Nobody compared them: No gemini session works in this project');
    expect(report).toContain('take one with accept');
  });

  it('reports what was said when nobody can sum a debate up, and when a turn is refused', async () => {
    await start(
      'debate',
      { debaters: ['codex', 'claude', 'gemini'], rounds: 1, moderator: 'gemini' },
      'Tabs or spaces?'
    );
    const one = await taskOf(codex, 2);
    const two = await taskOf(claude, 3);
    await bridge.send(one.agent, { job: 2, kind: 'report', body: 'Tabs.\nSTANCE: disagree' });
    await bridge.send(two.agent, { job: 3, kind: 'report', body: 'Spaces.\nSTANCE: disagree' });

    const report = await reportOf(1);
    expect((await bridge.job(1)).state).toBe('completed');
    expect(report).toContain(
      'The debate of 3 agents ended after 1 round: the rounds ran out, and 0 of 2 said they agree at the end.'
    );
    expect(report).toContain(
      'debater 3 did not get its turn of round 1: No gemini session works in this project'
    );
    expect(report).toContain('Nobody summed it up: No gemini session works in this project');
    expect(report).toContain(`The positions at the end:\n${one.agent}, round 1:\n> Tabs.`);
    expect(report).toContain('debater 3, round 1:\n> gave no answer');
  });

  it('refuses a debate that is too long to hand over turn by turn', async () => {
    await expect(
      start('debate', { debaters: ['codex', 'claude', 'codex', 'claude', 'codex'], rounds: 9 }, 'x')
    ).rejects.toThrow('A debate takes 40 turns at most: fewer debaters, or fewer rounds');
    await expect(
      start('debate', { debaters: ['codex', { to: 'claude', role: 'a\u2028b' }] }, 'x')
    ).rejects.toThrow('A role is one line');

    await start('debate', { debaters: ['codex', 'claude'] }, 'q'.repeat(20_001));
    expect(await reportOf(1)).toContain(
      'The recipe debate failed: the question of a debate takes 20000 characters at most, and this one has 20001.'
    );
    expect((await bridge.job(1)).state).toBe('failed');
    expect(await bridge.jobs({ parent: 1 })).toEqual([]);
  });
});

describe('a debate over several sessions and a restart', () => {
  it('keeps a seat with the session that spoke for it last', async () => {
    codexWakes = (agent) => agent.sessionId !== 'codex-started-1';
    await start('debate', { debaters: ['codex', 'claude'], rounds: 3 }, 'Tabs or spaces?');
    const one = await taskOf(codex, 2);
    const two = await taskOf(claude, 3);
    await bridge.send(one.agent, { job: 2, kind: 'report', body: 'Tabs.\nSTANCE: disagree' });
    await bridge.send(two.agent, { job: 3, kind: 'report', body: 'Spaces.\nSTANCE: disagree' });

    const [next] = await until(() => {
      const later = tasksOf(codex).filter((task) => task.job > 3);
      expect(later).toHaveLength(1);
      return later;
    });
    expect(next.agent).not.toBe(one.agent);
    const back = await until(() => {
      const found = tasksOf(claude).find((task) => task.job > 3);
      if (!found) throw new Error('The second debater has no turn yet');
      return found;
    });
    await bridge.send(next.agent, {
      job: next.job,
      kind: 'report',
      body: 'Still tabs.\nSTANCE: disagree',
    });
    await bridge.send(back.agent, {
      job: back.job,
      kind: 'report',
      body: 'Still spaces.\nSTANCE: disagree',
    });

    const [third] = await until(() => {
      const later = tasksOf(codex).filter((task) => task.job > 5);
      expect(later).toHaveLength(1);
      return later;
    });
    expect(third.agent).toBe(next.agent);
    expect(third.text).toContain(`${one.agent}, round 1:\n> Tabs.`);
    expect(third.text).toContain(`${next.agent}, round 2:\n> Still tabs.`);
    expect(await bridge.jobs({ parent: 1 })).toHaveLength(6);
  });

  it('goes on in the middle of a round after the dispatcher was restarted', async () => {
    await start('debate', { debaters: ['codex', 'claude'], rounds: 2 }, 'Tabs or spaces?');
    const one = await taskOf(codex, 2);
    const two = await taskOf(claude, 3);
    await bridge.send(one.agent, { job: 2, kind: 'report', body: 'Tabs.\nSTANCE: disagree' });
    await bridge.close();

    bridge = open();
    await bridge.send(two.agent, { job: 3, kind: 'report', body: 'Spaces.\nSTANCE: disagree' });
    await until(async () => expect(await bridge.jobs({ parent: 1 })).toHaveLength(4));
    await bridge.close();

    bridge = open();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const turns = await bridge.jobs({ parent: 1 });
    expect(turns.map((turn) => turn.number).sort()).toEqual([2, 3, 4, 5]);
    for (const turn of turns.filter((job) => job.number > 3)) {
      await bridge.send(turn.to, {
        job: turn.number,
        kind: 'report',
        body: 'Either.\nSTANCE: agree',
      });
    }
    const report = await reportOf(1);
    expect((await bridge.job(1)).state).toBe('completed');
    expect(report).toContain('ended after 2 rounds: all of them hold the same position now.');
    expect(await bridge.jobs({ parent: 1 })).toHaveLength(4);
    expect(await checkpoints.list('bridge-debate')).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe('the recipe debate', () => {
  it('lets agents answer each other round by round until they agree, and has it summed up', async () => {
    await start(
      'debate',
      { debaters: ['codex', { to: 'claude', role: 'critic' }], moderator: 'codex' },
      'Should the limiter live in the gateway?'
    );
    const one = await taskOf(codex, 2);
    const two = await taskOf(claude, 3);
    expect(two.agent).not.toBe(starter.name);
    expect(one.text).toContain('You are debater 1 of 2 in a debate of agents on a question.');
    expect(one.text).toContain('Give your own view of the question');
    expect(one.text).toContain('> Should the limiter live in the gateway?');
    expect(one.text).toContain('This is round 1 of 3 at most.');
    expect(two.text).toContain('You argue against the position or solution in question');
    await bridge.send(one.agent, {
      job: 2,
      kind: 'report',
      body: 'Yes: one place for every route.\nSTANCE: agree',
    });
    await bridge.send(two.agent, {
      job: 3,
      kind: 'report',
      body: 'No: the gateway becomes a bottleneck.\nSTANCE: disagree',
    });

    const again = await taskOf(codex, 4);
    const back = await taskOf(claude, 5);
    expect(again.agent).toBe(one.agent);
    expect(back.agent).toBe(two.agent);
    expect(again.text).toContain('This is round 2 of 3 at most. What was said before:');
    expect(again.text).toContain(`${one.agent}, round 1:\n> Yes: one place for every route.`);
    expect(again.text).toContain(
      `${two.agent} (critic), round 1:\n> No: the gateway becomes a bottleneck.`
    );
    await bridge.send(one.agent, {
      job: 4,
      kind: 'report',
      body: 'With a limit per route it scales.\n**STANCE: agree**',
    });
    await bridge.send(two.agent, {
      job: 5,
      kind: 'report',
      body: 'Per route answers my point.\nSTANCE: agree',
    });

    const moderator = await taskOf(codex, 6);
    expect(moderator.agent).not.toBe(one.agent);
    expect(moderator.text).toContain('Sum up a debate of 2 agents.');
    expect(moderator.text).toContain(
      `${two.agent} (critic), round 2:\n> Per route answers my point.`
    );
    await bridge.send(moderator.agent, {
      job: 6,
      kind: 'report',
      body: 'Both end at the gateway, with a limit per route.',
    });

    const report = await reportOf(1);
    expect((await bridge.job(1)).state).toBe('completed');
    expect(report).toContain(
      'The debate of 2 agents ended after 2 rounds: all of them hold the same position now.'
    );
    expect(report).toContain(
      `${moderator.agent} sums it up:\n> Both end at the gateway, with a limit per route.`
    );
    expect(report).toContain(
      'Every turn is a job of its own, with all that was said: #2, #3, #4, #5.'
    );
    expect(await bridge.jobs({ parent: 1 })).toHaveLength(5);
    expect(errors).toEqual([]);
  });

  it('does not take the silence of a debater that argued before for agreement', async () => {
    await start('debate', { debaters: ['codex', 'claude', 'codex'], rounds: 3 }, 'Tabs or spaces?');
    const one = await taskOf(codex, 2);
    const two = await taskOf(claude, 3);
    const three = await taskOf(codex, 4);
    for (const [task, job] of [
      [one, 2],
      [two, 3],
      [three, 4],
    ] as const) {
      await bridge.send(task.agent, { job, kind: 'report', body: 'Mine.\nSTANCE: disagree' });
    }

    const second = await until(async () => {
      const turns = (await bridge.jobs({ parent: 1 })).filter((job) => job.number > 4);
      expect(turns).toHaveLength(3);
      return turns;
    });
    for (const turn of second) {
      await bridge.send(
        turn.to,
        turn.to === three.agent
          ? { job: turn.number, kind: 'report', body: 'Cannot go on', outcome: 'failed' }
          : { job: turn.number, kind: 'report', body: 'Fine.\nSTANCE: agree' }
      );
    }

    const third = await until(async () => {
      const turns = (await bridge.jobs({ parent: 1 })).filter((job) => job.number > 7);
      expect(turns).toHaveLength(3);
      return turns;
    });
    for (const turn of third) {
      await bridge.send(turn.to, {
        job: turn.number,
        kind: 'report',
        body: 'Fine.\nSTANCE: agree',
      });
    }
    const report = await reportOf(1);
    expect(report).toContain(
      'The debate of 3 agents ended after 3 rounds: all of them hold the same position now.'
    );
    expect(await bridge.jobs({ parent: 1 })).toHaveLength(9);
  });

  it('ends when the rounds run out, with the positions of the last round', async () => {
    await start('debate', { debaters: ['codex', 'codex'], rounds: 1 }, 'Tabs or spaces?');
    const one = await taskOf(codex, 2);
    const two = await taskOf(codex, 3);
    expect(one.agent).not.toBe(two.agent);
    await bridge.send(one.agent, { job: 2, kind: 'report', body: 'Tabs.\nSTANCE: agree' });
    await bridge.send(two.agent, { job: 3, kind: 'report', body: 'Spaces.\nSTANCE: agree' });

    const report = await reportOf(1);
    expect((await bridge.job(1)).state).toBe('completed');
    expect(report).toContain(
      'The debate of 2 agents ended after 1 round: the rounds ran out, and 2 of 2 said they agree at the end.'
    );
    expect(report).toContain(`The positions at the end:\n${one.agent}, round 1:\n> Tabs.`);
    expect(report).toContain(`${two.agent}, round 1:\n> Spaces.`);
  });

  it('fails when fewer than two debaters answer', async () => {
    await start('debate', { debaters: ['codex', 'claude'] }, 'Tabs or spaces?');
    const one = await taskOf(codex, 2);
    const two = await taskOf(claude, 3);
    await bridge.send(one.agent, { job: 2, kind: 'report', body: 'Tabs.\nSTANCE: disagree' });
    await bridge.send(two.agent, { job: 3, kind: 'report', body: 'Busy', outcome: 'failed' });

    const report = await reportOf(1);
    expect((await bridge.job(1)).state).toBe('failed');
    expect(report).toContain('ended after 1 round: fewer than two of them answered.');
    expect(await bridge.jobs({ parent: 1 })).toHaveLength(2);
  });
});
