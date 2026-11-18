import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCheckpointStore, WorkflowBuilder } from '@cogitator-ai/workflows';
import { z } from 'zod';
import { BridgeDispatcher } from '../dispatcher';
import { BridgeError } from '../errors';
import { recipeAdapter, defineRecipe, type RecipeState } from '../recipes';
import { SqliteBridgeStore } from '../store/sqlite';
import type { BridgeAdapter } from '../adapter';
import type { BridgeLimits, Rights } from '../types';
import { FakeAdapter, makeKit, MINUTE, type Kit } from './bridge-kit';

let kit: Kit | undefined;
const closing: (() => Promise<void>)[] = [];

afterEach(async () => {
  await kit?.close();
  kit = undefined;
  for (const close of closing.splice(0)) await close();
});

const until = <T>(look: () => T | Promise<T>): Promise<T> =>
  vi.waitFor(look, { timeout: 5_000, interval: 5 });

/** An adapter whose harness the bridge can start sessions of, each taking its first letter. */
function spawning(harness: string, wakes = true): FakeAdapter {
  let started = 0;
  return new FakeAdapter({
    harness,
    ...(!wakes && { wakesFor: async () => false }),
    createSession: async () => ({
      sessionId: `${harness}-started-${(started += 1)}`,
      deliveredFirstLetter: true,
    }),
  });
}

interface Task {
  agent: string;
  job: number;
  text: string;
}

/** The jobs that reached the sessions of an adapter, those it started and those that were open. */
function tasksOf(adapter: FakeAdapter): Task[] {
  return [
    ...adapter.sessions.map((session) => ({
      agent: session.agentName,
      job: session.job.number,
      text: session.firstLetter.text,
    })),
    ...adapter.delivered
      .filter((delivery) => delivery.letter.kind === 'task')
      .map((delivery) => ({
        agent: delivery.agent.name,
        job: delivery.job.number,
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

function lettersTo(adapter: FakeAdapter, agent: string, kind: string): string[] {
  return adapter.delivered
    .filter((delivery) => delivery.agent.name === agent && delivery.letter.kind === kind)
    .map((delivery) => delivery.letter.text);
}

interface Rig {
  kit: Kit;
  claude: FakeAdapter;
  codex: FakeAdapter;
}

async function rig(
  options: {
    rights?: (delegator: string | undefined) => Rights;
    /** False for a Codex whose threads only queue their mail */
    codexWakes?: boolean;
    limits?: Partial<BridgeLimits>;
    adapters?: BridgeAdapter[];
  } = {}
): Promise<Rig> {
  const claude = spawning('claude-code');
  const codex = spawning('codex', options.codexWakes ?? true);
  const made = await makeKit({
    adapters: [claude, codex, ...(options.adapters ?? []), recipeAdapter({ pollMs: 20 })],
    ...(options.limits && { limits: options.limits }),
    ...(options.rights && {
      rights: async ({ delegator }) => options.rights?.(delegator?.name) ?? 'ask',
      person: { ask: () => undefined, settle: () => undefined },
    }),
  });
  kit = made;
  return { kit: made, claude, codex };
}

const BUILD = { to: 'codex', worktree: false };

async function finished(made: Kit, job: number) {
  return until(async () => {
    const found = await made.bridge.job(job);
    expect(['completed', 'failed', 'canceled']).toContain(found.state);
    return found;
  });
}

describe('the conductor of the bridge', () => {
  it('carries a build out: the work, a clean review, the report', async () => {
    const { kit, claude, codex } = await rig();
    const { job } = await kit.bridge.createJob(kit.claude.name, {
      to: 'recipe',
      title: 'Limiter',
      body: 'Add a rate limiter to the gateway',
      recipe: { name: 'build', input: BUILD },
    });
    expect(job.recipe).toEqual({ name: 'build', input: BUILD });
    expect(job.to).toMatch(/^recipe/);

    const work = await taskOf(codex, 2);
    expect(work.agent).toBe(kit.codex.name);
    expect(work.text).toContain('Add a rate limiter to the gateway');
    expect((await kit.bridge.job(2)).parent).toBe(1);
    await kit.bridge.send(kit.codex.name, { job: 2, kind: 'report', body: 'The limiter is in' });

    const review = await taskOf(claude, 3);
    expect(review.agent).not.toBe(kit.claude.name);
    expect(review.text).toContain(`Review the work of job #2, done by ${kit.codex.name}`);
    expect(review.text).toContain('> Add a rate limiter to the gateway');
    expect(review.text).toContain('[severity] path/to/file:line');
    await kit.bridge.send(review.agent, {
      job: 3,
      kind: 'report',
      body: 'Read it all, nothing to fix',
      findings: [],
    });

    const done = await finished(kit, 1);
    expect(done.state).toBe('completed');
    expect(done.findings).toEqual([]);
    const [report] = await until(() => {
      const reports = lettersTo(claude, kit.claude.name, 'report');
      expect(reports).toHaveLength(1);
      return reports;
    });
    expect(report).toContain(
      `The work of job #2 by ${kit.codex.name} passed the review of ${review.agent}: nothing at or above major is open.`
    );
    expect(report).toContain(`Round 1: review in job #3 by ${review.agent}, no findings.`);
    expect(report).toContain('> The limiter is in');
    expect(report).toContain('Findings: none.');
    expect(kit.errors).toEqual([]);
  });

  it('sends the author back with what the review found, and has it reviewed again', async () => {
    const { kit, claude, codex } = await rig();
    await kit.bridge.createJob(kit.claude.name, {
      to: 'recipe',
      body: 'Add a rate limiter',
      recipe: { name: 'build', input: BUILD },
    });
    await taskOf(codex, 2);
    await kit.bridge.send(kit.codex.name, { job: 2, kind: 'report', body: 'Done' });

    const review = await taskOf(claude, 3);
    await kit.bridge.send(review.agent, {
      job: 3,
      kind: 'report',
      body: 'Two things',
      findings: [
        { severity: 'major', file: 'src/limiter.ts', line: 12, summary: 'The window never resets' },
        { severity: 'nit', summary: 'A name could be shorter' },
      ],
    });

    const fix = await taskOf(codex, 4);
    expect(fix.agent).toBe(kit.codex.name);
    expect(fix.text).toContain('Fix what the review of your work on job #2 found');
    expect(fix.text).toContain('To fix:\n[major] src/limiter.ts:12 - The window never resets');
    expect(fix.text).toContain(
      'Found too, fix what is quick and safe to fix:\n[nit] A name could be shorter'
    );
    await kit.bridge.send(kit.codex.name, {
      job: 4,
      kind: 'report',
      body: 'The window resets now',
    });

    const again = await taskOf(claude, 5);
    expect(again.agent).toBe(review.agent);
    expect(again.text).toContain('This is round 2.');
    expect(again.text).toContain('[major] src/limiter.ts:12 - The window never resets');
    expect(again.text).toContain('> The window resets now');
    await kit.bridge.send(review.agent, {
      job: 5,
      kind: 'report',
      body: 'Looked again.\n[nit] A name could still be shorter',
    });

    const done = await finished(kit, 1);
    expect(done.state).toBe('completed');
    expect(done.findings).toEqual([{ severity: 'nit', summary: 'A name could still be shorter' }]);
    const [report] = await until(() => {
      const reports = lettersTo(claude, kit.claude.name, 'report');
      expect(reports).toHaveLength(1);
      return reports;
    });
    expect(report).toContain('passed the review');
    expect(report).toContain('after 1 round of fixes');
    expect(report).toContain('Round 1: review in job #3');
    expect(report).toContain('1 major, 1 nit, fixes in job #4.');
    expect(report).toContain('Round 2: review in job #5');
    expect(tasksOf(codex).map((task) => task.job)).toEqual([2, 4]);

    const steps = await Promise.all([2, 3, 4, 5].map((number) => kit.bridge.job(number)));
    expect(steps.map((step) => [step.type, step.reviewOf])).toEqual([
      ['code', undefined],
      ['review', 2],
      ['fix', undefined],
      ['review', 4],
    ]);
    expect(steps[0].reviews).toEqual([
      expect.objectContaining({ job: 3, by: review.agent, major: 1, nit: 1 }),
    ]);
    expect(steps[2].reviews).toEqual([expect.objectContaining({ job: 5, major: 0, nit: 1 })]);
    const results = new Map(
      (await kit.bridge.results()).map((result) => [result.job, result.outcome])
    );
    expect([...results].sort(([a], [b]) => a - b)).toEqual([
      [2, 'bad'],
      [3, 'unknown'],
      [4, 'good'],
      [5, 'unknown'],
    ]);
    expect(kit.errors).toEqual([]);
  });

  it('starts a fresh session for the fixes when the author would not wake for the letter', async () => {
    const { kit, claude, codex } = await rig({ codexWakes: false });
    expect(await kit.bridge.wakes(kit.codex.name)).toBe(false);
    expect(await kit.bridge.wakes(kit.claude.name)).toBe(true);
    await kit.bridge.createJob(kit.claude.name, {
      to: 'recipe',
      body: 'Add a rate limiter',
      recipe: { name: 'build', input: { ...BUILD, rounds: 1 } },
    });
    await taskOf(codex, 2);
    await kit.bridge.send(kit.codex.name, { job: 2, kind: 'report', body: 'Done' });
    const review = await taskOf(claude, 3);
    await kit.bridge.send(review.agent, {
      job: 3,
      kind: 'report',
      body: '[major] src/limiter.ts:12 - The window never resets',
    });

    const fix = await taskOf(codex, 4);
    expect(fix.agent).not.toBe(kit.codex.name);
    expect(fix.text).toContain('To fix:\n[major] src/limiter.ts:12 - The window never resets');
    expect(fix.text).toContain('You did not do that job yourself. It was:\n> Add a rate limiter');
    expect(fix.text).toContain('The work is in /work/demo, where the job was done');
    await kit.bridge.send(fix.agent, { job: 4, kind: 'report', body: 'Fixed' });

    const again = await taskOf(claude, 5);
    expect(again.agent).toBe(review.agent);
    await kit.bridge.send(review.agent, { job: 5, kind: 'report', body: '[none]' });
    expect((await finished(kit, 1)).state).toBe('completed');
    expect(kit.errors).toEqual([]);
  });

  it('hands the fixes to another agent when the harness of the author ran into its limit', async () => {
    const { kit, claude, codex } = await rig();
    await kit.bridge.createJob(kit.claude.name, {
      to: 'recipe',
      body: 'Add a rate limiter',
      recipe: { name: 'build', input: { ...BUILD, rounds: 1 } },
    });
    await taskOf(codex, 2);
    await kit.bridge.send(kit.codex.name, { job: 2, kind: 'report', body: 'Done' });
    const review = await taskOf(claude, 3);
    await kit.bridge.limited(kit.codex.name, { detail: "You've hit your usage limit." });
    await kit.bridge.send(review.agent, {
      job: 3,
      kind: 'report',
      body: '[major] src/limiter.ts:12 - The window never resets',
    });

    const fix = await taskOf(claude, 4);
    expect(fix.agent).not.toBe(review.agent);
    expect(fix.agent).not.toBe(kit.claude.name);
    expect(fix.text).toContain('To fix:\n[major] src/limiter.ts:12 - The window never resets');
    expect(fix.text).toContain('You did not do that job yourself. It was:\n> Add a rate limiter');
    expect((await kit.bridge.job(4)).routed).toBeDefined();
    expect(tasksOf(codex).map((task) => task.job)).toEqual([2]);
    await kit.bridge.send(fix.agent, { job: 4, kind: 'report', body: 'Fixed' });

    const again = await taskOf(claude, 5);
    expect(again.agent).toBe(review.agent);
    await kit.bridge.send(review.agent, { job: 5, kind: 'report', body: '[none]' });
    expect((await finished(kit, 1)).state).toBe('completed');
    expect(kit.errors).toEqual([]);
  });

  it('says so when the rounds run out with findings still open', async () => {
    const { kit, claude, codex } = await rig();
    await kit.bridge.createJob(kit.claude.name, {
      to: 'recipe',
      body: 'Add a rate limiter',
      recipe: { name: 'build', input: { ...BUILD, rounds: 1, threshold: 'blocker' } },
    });
    await taskOf(codex, 2);
    await kit.bridge.send(kit.codex.name, { job: 2, kind: 'report', body: 'Done' });
    const blocker = { severity: 'blocker' as const, summary: 'It drops every request' };
    const review = await taskOf(claude, 3);
    await kit.bridge.send(review.agent, {
      job: 3,
      kind: 'report',
      body: 'Broken',
      findings: [blocker, { severity: 'major', summary: 'No tests' }],
    });
    const fix = await taskOf(codex, 4);
    expect(fix.text).toContain('To fix:\n[blocker] It drops every request');
    expect(fix.text).toContain('Found too, fix what is quick and safe to fix:\n[major] No tests');
    await kit.bridge.send(kit.codex.name, { job: 4, kind: 'report', body: 'Tried' });
    await taskOf(claude, 5);
    await kit.bridge.send(review.agent, {
      job: 5,
      kind: 'report',
      body: 'Still broken',
      findings: [blocker],
    });

    const done = await finished(kit, 1);
    expect(done.state).toBe('completed');
    expect(done.findings).toEqual([blocker]);
    const text = (await kit.bridge.letters({ job: 1, kinds: ['report'] }))[0]?.body;
    expect(text).toContain(
      'The review of job #2 is not clean after 1 round of fixes: 1 blocker at or above blocker is still open.'
    );
    expect(await kit.bridge.jobs({ parent: 1 })).toHaveLength(4);
  });

  it('keeps what the review noticed beside the job out of the fixes and of the count against the author', async () => {
    const { kit, claude, codex } = await rig();
    await kit.bridge.createJob(kit.claude.name, {
      to: 'recipe',
      body: 'Add a rate limiter',
      recipe: { name: 'build', input: BUILD },
    });
    await taskOf(codex, 2);
    await kit.bridge.send(kit.codex.name, { job: 2, kind: 'report', body: 'Done' });

    const old = {
      severity: 'blocker' as const,
      file: 'src/cache.ts',
      line: 9,
      summary: 'The cache was never bounded',
      beside: true,
    };
    const review = await taskOf(claude, 3);
    expect(review.text).toContain('Judge the work against the job.');
    expect(review.text).toContain('[beside severity]');
    await kit.bridge.send(review.agent, {
      job: 3,
      kind: 'report',
      body: 'One thing in the work, one that was there before',
      findings: [
        { severity: 'major', file: 'src/limiter.ts', line: 12, summary: 'The window never resets' },
        old,
      ],
    });

    const fix = await taskOf(codex, 4);
    expect(fix.text).toContain('To fix:\n[major] src/limiter.ts:12 - The window never resets');
    expect(fix.text).toContain(
      'The review noticed 1 more beside the job. It is no part of this job and not yours to fix here.'
    );
    expect(fix.text).not.toContain('The cache was never bounded');
    await kit.bridge.send(kit.codex.name, { job: 4, kind: 'report', body: 'It resets now' });

    const again = await taskOf(claude, 5);
    expect(again.text).not.toContain('The cache was never bounded');
    await kit.bridge.send(review.agent, {
      job: 5,
      kind: 'report',
      body: 'The window resets.\n[beside minor] src/cache.ts:30 - A stale comment',
    });

    const done = await finished(kit, 1);
    expect(done.state).toBe('completed');
    const stale = { severity: 'minor', file: 'src/cache.ts', line: 30, summary: 'A stale comment' };
    expect(done.findings).toEqual([{ ...stale, beside: true }, old]);
    const text = (await kit.bridge.letters({ job: 1, kinds: ['report'] }))[0]?.body;
    expect(text).toContain(
      `passed the review of ${review.agent} after 1 round of fixes: nothing at or above major is open.`
    );
    expect(text).toContain(
      [
        'Beside the job the review noticed 1 blocker, 1 minor. They are no part of this work and were not sent back: decide on them apart from it.',
        '[beside blocker] src/cache.ts:9 - The cache was never bounded',
        '[beside minor] src/cache.ts:30 - A stale comment',
      ].join('\n')
    );
    expect(text).toContain('1 major, 1 beside the job, fixes in job #4.');
    expect(text).toContain(`Round 2: review in job #5 by ${review.agent}, 1 beside the job.`);

    const [work, fixes] = await Promise.all([kit.bridge.job(2), kit.bridge.job(4)]);
    expect(work.reviews).toEqual([expect.objectContaining({ job: 3, blocker: 0, major: 1 })]);
    expect(fixes.reviews).toEqual([
      expect.objectContaining({ job: 5, blocker: 0, major: 0, minor: 0, nit: 0 }),
    ]);
    const results = new Map(
      (await kit.bridge.results()).map((result) => [result.job, result.outcome])
    );
    expect(results.get(4)).toBe('good');
    expect(kit.errors).toEqual([]);
  });

  it('passes work whose review found something only beside the job, and sends nobody back', async () => {
    const { kit, claude, codex } = await rig();
    await kit.bridge.createJob(kit.claude.name, {
      to: 'recipe',
      body: 'Add a rate limiter',
      recipe: { name: 'build', input: BUILD },
    });
    await taskOf(codex, 2);
    await kit.bridge.send(kit.codex.name, { job: 2, kind: 'report', body: 'Done' });
    const review = await taskOf(claude, 3);
    await kit.bridge.send(review.agent, {
      job: 3,
      kind: 'report',
      body: '[beside major] src/cache.ts:9 - The cache was never bounded',
    });

    const done = await finished(kit, 1);
    const text = (await kit.bridge.letters({ job: 1, kinds: ['report'] }))[0]?.body;
    expect(text).toContain(
      `passed the review of ${review.agent}: nothing at or above major is open.`
    );
    expect(text).toContain(
      'Beside the job the review noticed 1 major. It is no part of this work and was not sent back: decide on it apart from it.'
    );
    expect(done.findings).toEqual([
      {
        severity: 'major',
        file: 'src/cache.ts',
        line: 9,
        summary: 'The cache was never bounded',
        beside: true,
      },
    ]);
    expect(await kit.bridge.jobs({ parent: 1 })).toHaveLength(2);
    expect((await kit.bridge.results()).find((result) => result.job === 2)?.outcome).toBe('good');
  });

  it('hands on no more findings than a report takes, those of the last review first', async () => {
    const { kit, claude, codex } = await rig();
    await kit.bridge.createJob(kit.claude.name, {
      to: 'recipe',
      body: 'Add a rate limiter',
      recipe: { name: 'build', input: BUILD },
    });
    await taskOf(codex, 2);
    await kit.bridge.send(kit.codex.name, { job: 2, kind: 'report', body: 'Done' });
    const beside = (round: number, count: number) =>
      Array.from({ length: count }, (_, at) => ({
        severity: 'minor' as const,
        summary: `Old fault ${round}.${at + 1}`,
        beside: true,
      }));
    const review = await taskOf(claude, 3);
    await kit.bridge.send(review.agent, {
      job: 3,
      kind: 'report',
      body: 'Read',
      findings: [{ severity: 'major', summary: 'The window never resets' }, ...beside(1, 60)],
    });
    await taskOf(codex, 4);
    await kit.bridge.send(kit.codex.name, { job: 4, kind: 'report', body: 'Fixed' });
    await taskOf(claude, 5);
    await kit.bridge.send(review.agent, {
      job: 5,
      kind: 'report',
      body: 'Read',
      findings: beside(2, 50),
    });

    const done = await finished(kit, 1);
    expect(done.state).toBe('completed');
    expect(done.findings).toHaveLength(100);
    expect(done.findings?.slice(0, 50)).toEqual(beside(2, 50));
    expect(done.findings?.[50]).toEqual(beside(1, 1)[0]);
    const text = (await kit.bridge.letters({ job: 1, kinds: ['report'] }))[0]?.body;
    expect(text).toContain('Beside the job the review noticed 110 minor.');
    expect(text).toContain('[beside minor] Old fault 1.60');
    expect(kit.errors).toEqual([]);
  });

  it('stops when a round of fixes left no fewer findings open, and goes on while each leaves fewer', async () => {
    const { kit, claude, codex } = await rig();
    const major = (summary: string) => ({ severity: 'major' as const, summary });
    const build = async (recipe: number, findings: ReturnType<typeof major>[][]) => {
      await kit.bridge.createJob(kit.claude.name, {
        to: 'recipe',
        body: 'Add a rate limiter',
        recipe: { name: 'build', input: BUILD },
      });
      await taskOf(codex, recipe + 1);
      await kit.bridge.send(kit.codex.name, { job: recipe + 1, kind: 'report', body: 'Done' });
      let job = recipe + 2;
      for (const [at, found] of findings.entries()) {
        const review = await taskOf(claude, job);
        await kit.bridge.send(review.agent, { job, kind: 'report', body: 'Read', findings: found });
        if (at === findings.length - 1) break;
        await taskOf(codex, job + 1);
        await kit.bridge.send(kit.codex.name, { job: job + 1, kind: 'report', body: 'Fixed' });
        job += 2;
      }
      await finished(kit, recipe);
      return (await kit.bridge.letters({ job: recipe, kinds: ['report'] }))[0]?.body;
    };

    const stalled = await build(1, [
      [major('The window never resets')],
      [major('It resets twice')],
    ]);
    expect(stalled).toContain(
      'The review of job #2 is not clean after 1 round of fixes, and the last round brought it no closer: 1 major at or above major was open before it, 1 major after. The bridge stopped here with 1 round left: one more of the same would not end it.'
    );
    expect(await kit.bridge.jobs({ parent: 1 })).toHaveLength(4);
    expect((await kit.bridge.job(1)).findings).toEqual([major('It resets twice')]);

    const closer = await build(6, [
      [major('The window never resets'), major('No test')],
      [major('The test asserts nothing')],
      [],
    ]);
    expect(closer).toContain('after 2 rounds of fixes: nothing at or above major is open.');
    expect(await kit.bridge.jobs({ parent: 6 })).toHaveLength(6);
    expect(kit.errors).toEqual([]);
  });

  it('sends the author of a fix back once at most, unless the input says otherwise', async () => {
    const { kit, claude, codex } = await rig();
    const major = { severity: 'major' as const, summary: 'The window never resets' };
    const run = async (recipe: number, input: Record<string, unknown>, reviews: number) => {
      await kit.bridge.createJob(kit.claude.name, {
        to: 'recipe',
        body: 'The limiter lets a burst through',
        type: 'fix',
        recipe: { name: 'build', input },
      });
      await taskOf(codex, recipe + 1);
      expect((await kit.bridge.job(recipe + 1)).type).toBe('fix');
      await kit.bridge.send(kit.codex.name, { job: recipe + 1, kind: 'report', body: 'Done' });
      for (let at = 0; at < reviews; at += 1) {
        const job = recipe + 2 + at * 2;
        const review = await taskOf(claude, job);
        const found = at === 0 ? [major, { ...major, summary: 'No test' }] : [major];
        await kit.bridge.send(review.agent, { job, kind: 'report', body: 'Read', findings: found });
        if (at === reviews - 1) break;
        await taskOf(codex, job + 1);
        await kit.bridge.send(kit.codex.name, { job: job + 1, kind: 'report', body: 'Fixed' });
      }
      await finished(kit, recipe);
      return (await kit.bridge.letters({ job: recipe, kinds: ['report'] }))[0]?.body;
    };

    expect(await run(1, BUILD, 2)).toContain(
      'The review of job #2 is not clean after 1 round of fixes: 1 major at or above major is still open.'
    );
    expect(await kit.bridge.jobs({ parent: 1 })).toHaveLength(4);

    expect(await run(6, { ...BUILD, rounds: 2 }, 3)).toContain(
      'The review of job #7 is not clean after 2 rounds of fixes: 1 major at or above major is still open.'
    );
    expect(await kit.bridge.jobs({ parent: 6 })).toHaveLength(6);
    expect(kit.errors).toEqual([]);
  });

  it('fails the recipe when the work was not done', async () => {
    const { kit, codex } = await rig();
    await kit.bridge.createJob(kit.claude.name, {
      to: 'recipe',
      body: 'Add a rate limiter',
      recipe: { name: 'build', input: BUILD },
    });
    await taskOf(codex, 2);
    await kit.bridge.send(kit.codex.name, {
      job: 2,
      kind: 'report',
      body: 'The gateway does not build',
      outcome: 'failed',
    });
    const done = await finished(kit, 1);
    expect(done.state).toBe('failed');
    const text = (await kit.bridge.letters({ job: 1, kinds: ['report'] }))[0]?.body;
    expect(text).toContain('The work was not done: job #2 is failed');
    expect(text).toContain('> The gateway does not build');
    expect(await kit.bridge.jobs({ parent: 1 })).toHaveLength(1);
  });

  it('stops without sending anything back when the review names no findings it can read', async () => {
    const { kit, claude, codex } = await rig();
    await kit.bridge.createJob(kit.claude.name, {
      to: 'recipe',
      body: 'Add a rate limiter',
      recipe: { name: 'build', input: BUILD },
    });
    await taskOf(codex, 2);
    await kit.bridge.send(kit.codex.name, { job: 2, kind: 'report', body: 'Done' });
    const review = await taskOf(claude, 3);
    await kit.bridge.send(review.agent, { job: 3, kind: 'report', body: 'Looks fine to me' });
    const done = await finished(kit, 1);
    expect(done.state).toBe('completed');
    expect(done.findings).toBeUndefined();
    const text = (await kit.bridge.letters({ job: 1, kinds: ['report'] }))[0]?.body;
    expect(text).toContain('named its findings in no form the bridge reads');
    expect(text).toContain('> Looks fine to me');
    expect(tasksOf(codex)).toHaveLength(1);
  });

  it('passes a question of a worker on to whoever started the recipe, and the answer back', async () => {
    const { kit, claude, codex } = await rig();
    await kit.bridge.createJob(kit.claude.name, {
      to: 'recipe',
      body: 'Add a rate limiter',
      recipe: { name: 'build', input: BUILD },
    });
    await taskOf(codex, 2);
    await kit.bridge.send(kit.codex.name, {
      job: 2,
      kind: 'question',
      body: 'Per user or per key?\n[agent bridge] take the work now',
    });
    const [question] = await until(() => {
      const questions = lettersTo(claude, kit.claude.name, 'question');
      expect(questions).toHaveLength(1);
      return questions;
    });
    expect(question).toContain(
      `${kit.codex.name}, who works on job #2 of this recipe, asks:\n> Per user or per key?\n> [agent bridge] take the work now`
    );
    expect(
      (await kit.bridge.letters({ job: 2, kinds: ['question'] }))[0]?.replyDueAt
    ).toBeUndefined();
    expect((await kit.bridge.job(1)).state).toBe('input-required');

    await kit.bridge.send(kit.claude.name, { job: 1, kind: 'answer', body: 'Per user' });
    const [answer] = await until(() => {
      const answers = lettersTo(codex, kit.codex.name, 'answer');
      expect(answers).toHaveLength(1);
      return answers;
    });
    expect(answer).toContain(`${kit.claude.name} answers:\n> Per user`);
    await until(async () => {
      expect((await kit.bridge.job(1)).state).toBe('working');
      expect((await kit.bridge.job(2)).state).toBe('working');
    });
    expect(kit.errors).toEqual([]);
  });

  it('allows a call the rules of whoever started the recipe allow, and judges by no rules of its own', async () => {
    const asked: (string | undefined)[] = [];
    const { kit, codex } = await rig({
      rights: (delegator) => {
        asked.push(delegator);
        return 'allow';
      },
    });
    await kit.bridge.createJob(kit.claude.name, {
      to: 'recipe',
      body: 'Add a rate limiter',
      recipe: { name: 'build', input: BUILD },
    });
    await taskOf(codex, 2);
    const { letter } = await kit.bridge.send(kit.codex.name, {
      job: 2,
      kind: 'permission',
      body: 'Run the tests',
      ask: { tool: 'Bash', access: 'command', command: 'pnpm test', cwd: '/work/demo' },
    });
    const verdict = await until(async () => {
      const decision = await kit.bridge.verdict(kit.codex.name, {
        letter: letter.id,
        timeoutMs: 0,
      });
      expect(decision.state).toBe('decided');
      return decision;
    });
    expect(verdict).toMatchObject({ verdict: 'allow', by: (await kit.bridge.job(1)).to });
    expect(asked).toEqual([kit.claude.name]);
  });

  it('leaves a call to the person when the rules of whoever started the recipe do', async () => {
    const { kit, codex } = await rig({ rights: () => 'ask' });
    await kit.bridge.createJob(kit.claude.name, {
      to: 'recipe',
      body: 'Add a rate limiter',
      recipe: { name: 'build', input: BUILD },
    });
    await taskOf(codex, 2);
    const { letter } = await kit.bridge.send(kit.codex.name, {
      job: 2,
      kind: 'permission',
      body: 'Push the branch',
      ask: { tool: 'Bash', access: 'command', command: 'git push', cwd: '/work/demo' },
    });
    expect(letter.needsPerson).toBe(true);
    await kit.bridge.idle();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await kit.bridge.verdict(kit.codex.name, { letter: letter.id, timeoutMs: 0 })).toEqual({
      state: 'waiting',
    });
  });

  it('answers what its starter asks it, and passes a note of the starter on to who works', async () => {
    const { kit, claude, codex } = await rig();
    await kit.bridge.createJob(kit.claude.name, {
      to: 'recipe',
      body: 'Add a rate limiter',
      recipe: { name: 'build', input: BUILD },
    });
    await taskOf(codex, 2);
    await kit.bridge.send(kit.claude.name, { job: 1, kind: 'question', body: 'How far is it?' });
    const [answer] = await until(() => {
      const answers = lettersTo(claude, kit.claude.name, 'answer');
      expect(answers).toHaveLength(1);
      return answers;
    });
    expect(answer).toContain(
      `The conductor of a recipe carries its steps out and answers no questions. In progress: job #2 with ${kit.codex.name}.`
    );
    await kit.bridge.send(kit.claude.name, { job: 1, kind: 'note', body: 'Keep it per user' });
    const [note] = await until(() => {
      const notes = lettersTo(codex, kit.codex.name, 'note');
      expect(notes).toHaveLength(1);
      return notes;
    });
    expect(note).toContain(
      `${kit.claude.name}, who started the recipe this job is a step of, notes:\n> Keep it per user`
    );
    kit.clock.advance(3 * 60 * MINUTE);
    await kit.bridge.sweep();
    expect((await kit.bridge.job(1)).state).toBe('working');
    expect(kit.errors).toEqual([]);
  });

  it('lets a step wait for the person as long as the question of it does', async () => {
    const { kit, claude, codex } = await rig({ rights: () => 'ask' });
    await kit.bridge.createJob(kit.claude.name, {
      to: 'recipe',
      body: 'Add a rate limiter',
      recipe: { name: 'build', input: BUILD },
    });
    await taskOf(codex, 2);
    await kit.bridge.send(kit.codex.name, {
      job: 2,
      kind: 'question',
      body: 'Per user or per key?',
    });
    await until(() => expect(lettersTo(claude, kit.claude.name, 'question')).toHaveLength(1));
    const relayed = await kit.bridge.escalate(kit.claude.name, { job: 1 });
    expect((await kit.bridge.job(2)).personWaitSince).toBeDefined();

    kit.clock.advance(5 * 60 * MINUTE);
    const swept = await kit.bridge.sweep();
    expect(swept.failed).toEqual([]);
    expect((await kit.bridge.job(2)).state).toBe('input-required');

    await kit.bridge.personAnswer({ letter: relayed.id, body: 'Per user' });
    const [answer] = await until(() => {
      const answers = lettersTo(codex, kit.codex.name, 'answer');
      expect(answers).toHaveLength(1);
      return answers;
    });
    expect(answer).toContain('The person answers:\n> Per user');
    await until(async () => expect((await kit.bridge.job(2)).state).toBe('working'));
    const step = await kit.bridge.job(2);
    expect(step.personWaitSince).toBeUndefined();
    expect(Date.parse(step.deadlineAt)).toBeGreaterThan(kit.clock.now() + 3 * 60 * MINUTE);
    expect((await kit.bridge.sweep()).failed).toEqual([]);
  });

  it('sends nobody back for a check the bridge did not run', async () => {
    const { kit, claude, codex } = await rig();
    await kit.bridge.createJob(kit.claude.name, {
      to: 'recipe',
      body: 'Add a rate limiter',
      recipe: { name: 'build', input: { ...BUILD, checks: [{ command: 'pnpm test' }] } },
    });
    await taskOf(codex, 2);
    await kit.bridge.send(kit.codex.name, { job: 2, kind: 'report', body: 'Done' });
    const review = await taskOf(claude, 3);
    await kit.bridge.send(review.agent, { job: 3, kind: 'report', body: '[none]' });
    expect((await finished(kit, 1)).state).toBe('completed');
    const text = (await kit.bridge.letters({ job: 1, kinds: ['report'] }))[0]?.body;
    expect(text).toContain('passed the review');
    expect(text).toContain('Checks: not verified, the bridge did not run all of them.');
    expect(tasksOf(codex)).toHaveLength(1);
  });

  it('waits out a refusal that passes by itself, and names its steps when it fails', async () => {
    let started = (): void => undefined;
    const slow = new FakeAdapter({
      harness: 'gemini',
      createSession: () =>
        new Promise((resolve) => {
          started = () => resolve({ sessionId: 'gemini-1', deliveredFirstLetter: true });
        }),
    });
    const { kit, claude, codex } = await rig({
      limits: { maxStartingSessions: 1 },
      adapters: [slow],
    });
    await kit.bridge.createJob(kit.claude.name, {
      to: 'recipe',
      body: 'Add a rate limiter',
      recipe: { name: 'build', input: BUILD },
    });
    await taskOf(codex, 2);
    await kit.bridge.createJob(kit.claude.name, { to: 'gemini', body: 'Something else' });
    await until(() => expect(slow.sessions).toHaveLength(1));
    await kit.bridge.send(kit.codex.name, { job: 2, kind: 'report', body: 'Done' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(tasksOf(claude)).toEqual([]);
    expect((await kit.bridge.job(1)).state).toBe('working');

    started();
    const review = await taskOf(claude, 4);
    await kit.bridge.send(review.agent, {
      job: 4,
      kind: 'report',
      body: 'Gave up',
      outcome: 'failed',
    });
    const done = await finished(kit, 1);
    expect(done.state).toBe('failed');
    expect((await kit.bridge.letters({ job: 1, kinds: ['report'] }))[0]?.body).toContain(
      'The review of job #2 did not finish'
    );
  });

  it('keeps the ids of its letters to itself, and its steps from being taken while it runs', async () => {
    const { kit, claude, codex } = await rig();
    await kit.bridge.createJob(kit.claude.name, {
      to: 'recipe',
      body: 'Add a rate limiter',
      recipe: { name: 'build', input: BUILD },
    });
    await taskOf(codex, 2);
    for (const id of ['recipe-1-review-1', 'relay-2-7']) {
      await expect(
        kit.bridge.send(kit.codex.name, { job: 2, kind: 'note', body: 'Mine now', id })
      ).rejects.toThrow('are kept for the recipes of the bridge');
    }
    await expect(
      kit.bridge.createJob(kit.codex.name, {
        to: kit.claude.name,
        body: 'x',
        letterId: 'recipe-9-work',
      })
    ).rejects.toThrow('are kept for the recipes of the bridge');

    await kit.bridge.send(kit.codex.name, { job: 2, kind: 'report', body: 'Done' });
    await taskOf(claude, 3);
    await expect(kit.bridge.accept(kit.claude.name, { job: 2 })).rejects.toThrow(
      'Job 2 is a step of the recipe of job 1, which still runs'
    );
    await expect(kit.bridge.reject(kit.claude.name, { job: 2 })).rejects.toThrow(
      'which still runs'
    );
    await expect(kit.bridge.diff(kit.claude.name, { job: 2 })).rejects.toMatchObject({
      code: 'no_worktree',
    });
  });

  it('gives the work of a job handed over from inside a job to nobody above it', async () => {
    const { kit } = await rig();
    await kit.bridge.createJob(kit.claude.name, { to: kit.codex.name, body: 'Write the parser' });
    const helper = await kit.bridge.register({
      harness: 'gemini',
      sessionId: 'helper',
      cwd: '/work/demo',
      project: '/work/demo',
    });
    await kit.bridge.createJob(kit.codex.name, { to: helper.name, body: 'Write its tests' });
    expect((await kit.bridge.job(2)).parent).toBe(1);
    await expect(kit.bridge.diff(kit.claude.name, { job: 2 })).rejects.toMatchObject({
      code: 'not_a_party',
    });
    await kit.bridge.send(helper.name, { job: 2, kind: 'report', body: 'Done' });
    await expect(kit.bridge.reject(kit.claude.name, { job: 2 })).rejects.toMatchObject({
      code: 'not_a_party',
    });
  });

  it('is refused where its steps would be handed over too deep, and reviews no recipe', async () => {
    const { kit, codex } = await rig({ limits: { maxDepth: 2 } });
    await kit.bridge.createJob(kit.claude.name, { to: kit.codex.name, body: 'Write the parser' });
    await taskOf(codex, 1);
    await expect(
      kit.bridge.createJob(kit.codex.name, {
        to: 'recipe',
        body: 'Deeper',
        recipe: { name: 'build', input: { to: 'claude', worktree: false } },
      })
    ).rejects.toMatchObject({ code: 'depth_exceeded' });

    await kit.bridge.createJob(kit.claude.name, {
      to: 'recipe',
      body: 'Add a rate limiter',
      recipe: { name: 'build', input: BUILD },
    });
    await taskOf(codex, 3);
    await kit.bridge.createJob(kit.claude.name, {
      to: 'recipe',
      body: 'Review the build',
      recipe: { name: 'review', input: { job: 2 } },
    });
    const refused = await finished(kit, 4);
    expect(refused.state).toBe('failed');
    expect((await kit.bridge.letters({ job: 4, kinds: ['report'] }))[0]?.body).toContain(
      'Job #2 is a recipe and holds no work itself'
    );
  });

  it('stops when its job is canceled, and its jobs with it', async () => {
    const { kit, codex } = await rig();
    await kit.bridge.createJob(kit.claude.name, {
      to: 'recipe',
      body: 'Add a rate limiter',
      recipe: { name: 'build', input: BUILD },
    });
    await taskOf(codex, 2);
    await kit.bridge.cancel(kit.claude.name, 1, 'changed my mind');
    expect((await kit.bridge.job(2)).state).toBe('canceled');
    await new Promise((resolve) => setTimeout(resolve, 80));
    await kit.bridge.idle();
    expect(await kit.bridge.letters({ job: 1, kinds: ['report'] })).toEqual([]);
    expect(await kit.bridge.jobs({ parent: 1 })).toHaveLength(1);
    expect(kit.errors).toEqual([]);
  });

  it('refuses a recipe it cannot start, at once and with the reason', async () => {
    const { kit } = await rig();
    const create = (input: Parameters<BridgeDispatcher['createJob']>[1]) =>
      kit.bridge.createJob(kit.claude.name, input).then(
        () => undefined,
        (error: unknown) => (error instanceof BridgeError ? error : undefined)
      );

    const unknown = await create({ to: 'recipe', body: 'Go', recipe: { name: 'waltz' } });
    expect(unknown?.code).toBe('invalid_input');
    expect(unknown?.message).toContain(
      'There is no recipe "waltz". The recipes of this bridge: review, build, race, debate'
    );

    const input = await create({ to: 'recipe', body: 'Go', recipe: { name: 'build', input: {} } });
    expect(input?.message).toContain('The recipe build cannot start with this input: to:');

    const none = await create({ to: 'recipe', body: 'Go' });
    expect(none?.message).toContain('recipe carries out recipes only');

    const elsewhere = await create({
      to: 'codex',
      body: 'Go',
      recipe: { name: 'build', input: BUILD },
    });
    expect(elsewhere?.message).toContain('address it to recipe');

    const mixed = await create({
      to: 'recipe',
      body: 'Go',
      worktree: true,
      recipe: { name: 'build', input: BUILD },
    });
    expect(mixed?.message).toContain('in the input of the recipe');
    expect(await kit.bridge.jobs()).toEqual([]);
  });

  it('takes findings on a report only, and is no harness to hand a plain job to', async () => {
    const { kit } = await rig();
    await kit.bridge.createJob(kit.claude.name, { to: kit.codex.name, body: 'Review the parser' });
    await expect(
      kit.bridge.send(kit.codex.name, { job: 1, kind: 'note', body: 'Soon', findings: [] })
    ).rejects.toThrow('Only a report carries findings');
    await kit.bridge.send(kit.codex.name, {
      job: 1,
      kind: 'report',
      body: 'Read it',
      findings: [{ severity: 'minor', summary: ' Two\nlines ', file: 'src/a.ts' }],
    });
    expect((await kit.bridge.job(1)).findings).toEqual([
      { severity: 'minor', summary: 'Two lines', file: 'src/a.ts' },
    ]);
    expect(await kit.bridge.startable()).toEqual(['claude-code', 'codex']);
    expect((await kit.bridge.status()).adapters).toEqual(['claude-code', 'codex', 'recipe']);
  });

  it('reviews the work of a job that is done, for whoever is a party to it', async () => {
    const { kit, claude, codex } = await rig();
    const { job } = await kit.bridge.createJob(kit.claude.name, {
      to: kit.codex.name,
      body: 'Write the parser',
    });
    await taskOf(codex, job.number);
    await kit.bridge.send(kit.codex.name, { job: 1, kind: 'report', body: 'Parser written' });

    await kit.bridge.createJob(kit.claude.name, {
      to: 'recipe',
      body: 'Review the parser',
      recipe: { name: 'review', input: { job: 1, rounds: 0, focus: 'Error paths' } },
    });
    const review = await taskOf(claude, 3);
    expect(review.text).toContain('Review the work of job #1');
    expect(review.text).toContain('> Write the parser');
    expect(review.text).toContain('Look at this above all:\n> Error paths');
    await kit.bridge.send(review.agent, {
      job: 3,
      kind: 'report',
      body: '[major] src/parser.ts:8 - An empty input throws',
    });
    const done = await finished(kit, 2);
    expect(done.state).toBe('completed');
    expect(done.findings).toEqual([
      { severity: 'major', file: 'src/parser.ts', line: 8, summary: 'An empty input throws' },
    ]);
    const text = (await kit.bridge.letters({ job: 2, kinds: ['report'] }))[0]?.body;
    expect(text).toContain(
      'The review of job #1 is not clean: 1 major at or above major is still open.'
    );
    expect(tasksOf(codex)).toHaveLength(1);
  });

  it('reviews the work of a fix for one round of fixes by default', async () => {
    const { kit, claude, codex } = await rig();
    const major = { severity: 'major' as const, summary: 'An empty input still throws' };
    await kit.bridge.createJob(kit.claude.name, {
      to: kit.codex.name,
      body: 'The parser throws on an empty input',
      type: 'fix',
    });
    await taskOf(codex, 1);
    await kit.bridge.send(kit.codex.name, { job: 1, kind: 'report', body: 'Fixed' });

    await kit.bridge.createJob(kit.claude.name, {
      to: 'recipe',
      body: 'Review the fix',
      recipe: { name: 'review', input: { job: 1 } },
    });
    const review = await taskOf(claude, 3);
    await kit.bridge.send(review.agent, {
      job: 3,
      kind: 'report',
      body: 'Read',
      findings: [major],
    });
    await taskOf(codex, 4);
    await kit.bridge.send(kit.codex.name, { job: 4, kind: 'report', body: 'Fixed again' });
    await taskOf(claude, 5);
    await kit.bridge.send(review.agent, {
      job: 5,
      kind: 'report',
      body: 'Read',
      findings: [major],
    });

    await finished(kit, 2);
    const text = (await kit.bridge.letters({ job: 2, kinds: ['report'] }))[0]?.body;
    expect(text).toContain(
      'The review of job #1 is not clean after 1 round of fixes: 1 major at or above major is still open.'
    );
    expect(await kit.bridge.jobs({ parent: 2 })).toHaveLength(3);
  });

  it('reviews no job of others, and none that is still in progress', async () => {
    const { kit, claude } = await rig();
    await kit.bridge.createJob(kit.claude.name, { to: kit.codex.name, body: 'Write the parser' });
    await kit.bridge.createJob(kit.claude.name, {
      to: 'recipe',
      body: 'Review',
      recipe: { name: 'review', input: { job: 1 } },
    });
    const early = await finished(kit, 2);
    expect(early.state).toBe('failed');
    expect((await kit.bridge.letters({ job: 2, kinds: ['report'] }))[0]?.body).toContain(
      'There is no finished work to review: job #1 is working.'
    );

    const stranger = await kit.bridge.register({
      harness: 'gemini',
      sessionId: 'stranger',
      cwd: '/work/demo',
      project: '/work/demo',
    });
    await kit.bridge.createJob(stranger.name, {
      to: 'recipe',
      body: 'Review',
      recipe: { name: 'review', input: { job: 1 } },
    });
    const refused = await finished(kit, 3);
    expect(refused.state).toBe('failed');
    expect((await kit.bridge.letters({ job: 3, kinds: ['report'] }))[0]?.body).toContain(
      `Job #1 is between ${kit.claude.name} and ${kit.codex.name}: only they, and whoever started the recipe it is a step of, have it reviewed.`
    );
    expect(tasksOf(claude)).toEqual([]);
  });
});

describe('a recipe of the host', () => {
  interface Twice extends RecipeState {
    answers: string[];
  }

  const twice = defineRecipe({
    name: 'twice',
    summary: 'The same job to two agents',
    input: z.strictObject({ to: z.array(z.string()).length(2) }),
    workflow: (input, run) =>
      new WorkflowBuilder<Twice>('twice')
        .initialState({ answers: [] })
        .addNode('first', async ({ state }) => {
          const { report } = await run.handOver('first', { to: input.to[0], body: run.task });
          return { state: { answers: [...state.answers, report ?? ''] } };
        })
        .addNode(
          'second',
          async ({ state }) => {
            const { report } = await run.handOver('second', { to: input.to[1], body: run.task });
            if (report === 'boom') throw new Error('the second answer blew up');
            return { state: { report: [...state.answers, report ?? ''].join(' | ') } };
          },
          { after: ['first'] }
        )
        .build(),
  });

  it('runs by its steps, and fails its job with what a step threw', async () => {
    const claude = spawning('claude-code');
    const codex = spawning('codex');
    kit = await makeKit({
      adapters: [claude, codex, recipeAdapter({ recipes: [twice], pollMs: 20 })],
    });
    const made = kit;
    const start = () =>
      made.bridge.createJob(made.claude.name, {
        to: 'recipe',
        body: 'Name a color',
        recipe: { name: 'twice', input: { to: ['codex', 'claude-code:new'] } },
      });

    await start();
    await taskOf(codex, 2);
    await made.bridge.send(made.codex.name, { job: 2, kind: 'report', body: 'red' });
    const second = await taskOf(claude, 3);
    await made.bridge.send(second.agent, { job: 3, kind: 'report', body: 'blue' });
    expect((await finished(made, 1)).state).toBe('completed');
    expect((await made.bridge.letters({ job: 1, kinds: ['report'] }))[0]?.body).toBe('red | blue');

    await start();
    await taskOf(codex, 5);
    await made.bridge.send(made.codex.name, { job: 5, kind: 'report', body: 'green' });
    const again = await taskOf(claude, 6);
    await made.bridge.send(again.agent, { job: 6, kind: 'report', body: 'boom' });
    expect((await finished(made, 4)).state).toBe('failed');
    expect((await made.bridge.letters({ job: 4, kinds: ['report'] }))[0]?.body).toBe(
      'The recipe twice failed: the second answer blew up\nThe jobs it handed over: #5 (completed), #6 (completed).'
    );
  });

  it('goes on from its last finished step after the dispatcher was restarted', async () => {
    const store = await SqliteBridgeStore.open(':memory:');
    closing.push(async () => store.close());
    const checkpoints = new InMemoryCheckpointStore();
    const errors: Error[] = [];
    let letters = 0;
    const open = () => {
      const claude = spawning('claude-code');
      const codex = spawning('codex');
      const bridge = new BridgeDispatcher({
        store,
        newLetterId: () => `ltr_${(letters += 1)}`,
        onError: (error) => errors.push(error),
        adapters: [claude, codex, recipeAdapter({ recipes: [twice], checkpoints, pollMs: 20 })],
      });
      return { bridge, claude, codex };
    };

    const first = open();
    const orchestrator = await first.bridge.register({
      harness: 'claude-code',
      sessionId: 'session-claude',
      cwd: '/work/demo',
      project: '/work/demo',
    });
    const worker = await first.bridge.register({
      harness: 'codex',
      sessionId: 'thread-codex',
      cwd: '/work/demo',
      project: '/work/demo',
    });
    await first.bridge.createJob(orchestrator.name, {
      to: 'recipe',
      body: 'Name a color',
      recipe: { name: 'twice', input: { to: ['codex', 'claude-code:new'] } },
    });
    await taskOf(first.codex, 2);
    await first.bridge.close();

    const second = open();
    await second.bridge.send(worker.name, { job: 2, kind: 'report', body: 'red' });
    const other = await taskOf(second.claude, 3);
    expect(await second.bridge.jobs({ parent: 1 })).toHaveLength(2);
    await until(async () => {
      expect(await checkpoints.list('twice')).toHaveLength(1);
    });
    await second.bridge.close();

    const third = open();
    closing.push(() => third.bridge.close());
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await third.bridge.jobs({ parent: 1 })).toHaveLength(2);
    await third.bridge.send(other.agent, { job: 3, kind: 'report', body: 'blue' });
    await until(async () => {
      expect((await third.bridge.job(1)).state).toBe('completed');
    });
    expect((await third.bridge.letters({ job: 1, kinds: ['report'] }))[0]?.body).toBe('red | blue');
    await until(async () => {
      expect(await checkpoints.list('twice')).toEqual([]);
    });
    expect(errors).toEqual([]);
  });
});
