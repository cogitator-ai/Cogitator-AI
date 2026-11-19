import { execFileSync } from 'node:child_process';
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCheckpointStore } from '@cogitator-ai/workflows';
import { BridgeDispatcher } from '../dispatcher';
import { recipeAdapter, verdictOf } from '../recipes';
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
let checkpoints: InMemoryCheckpointStore;
let sessions: number;
/** Which sessions of Codex wake for a letter: all of them unless a test says otherwise. */
let codexWakes: (agent: AgentRecord) => boolean;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd();

const until = <T>(look: () => T | Promise<T>): Promise<T> =>
  vi.waitFor(look, { timeout: 5_000, interval: 5 });

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

function tasks(): Task[] {
  return [claude, codex].flatMap((adapter) => [
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
  ]);
}

function taskOf(job: number): Promise<Task> {
  return until(() => {
    const found = tasks().find((task) => task.job === job);
    if (!found) throw new Error(`Job #${job} reached nobody yet`);
    return found;
  });
}

/** Reports on a job as whoever has it, and resolves with the task it was. */
async function say(job: number, body: string): Promise<Task> {
  const task = await taskOf(job);
  await bridge.send(task.agent, { job, kind: 'report', body });
  return task;
}

async function ended(job: number): Promise<BridgeJob> {
  return until(async () => {
    const found = await bridge.job(job);
    expect(['completed', 'failed', 'canceled']).toContain(found.state);
    return found;
  });
}

async function reportOf(job: number): Promise<string> {
  await ended(job);
  return (await bridge.letters({ job, kinds: ['report'] }))[0]?.body ?? '';
}

const TASK = 'Add a rate limiter to the gateway';
const REPORT_TOOL =
  'Report on this job with the report tool of the bridge: what you write in your own window nobody reads.';

const start = (input: unknown, body = TASK, from = starter) =>
  bridge.createJob(from.name, { to: 'recipe', body, recipe: { name: 'plan', input } });

const folderOf = (cwd = repo): string => join(cwd, '.cogitator', 'plans', 'job-1');
const fileOf = (name: string, cwd = repo): string => join(folderOf(cwd), name);

/** What the merger does besides reporting: the two files of the joint plan. */
function writePlan(text = '# Joint plan\n', cwd = repo): void {
  mkdirSync(folderOf(cwd), { recursive: true });
  writeFileSync(fileOf('plan.md', cwd), text);
  writeFileSync(fileOf('decisions.md', cwd), '1. taken\n');
}

/** Both drafts and both critiques of a run of two, jobs #2 to #5. */
async function draftsAndCritiques(): Promise<void> {
  await say(2, '# Plan of codex\n');
  await say(3, '# Plan of claude\n');
  await say(4, '1. take: the bucket per route');
  await say(5, '1. fault: the limiter has no clock');
}

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-plan-')));
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
  checkpoints = new InMemoryCheckpointStore();
  sessions = 0;
  codexWakes = () => true;
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

describe('what a checker of a plan said', () => {
  it('is a signature only when the last verdict says signed', () => {
    expect(verdictOf('Good.\nVERDICT: signed')).toEqual({ signed: true, objections: [] });
    expect(verdictOf('Fine by me.\n**VERDICT: signed**')).toEqual({ signed: true, objections: [] });
    expect(verdictOf('VERDICT: signed\nOn a second look:\nVERDICT: objections').signed).toBe(false);
    expect(verdictOf('VERDICT: objections\nNo, it holds.\nverdict: SIGNED').signed).toBe(true);
    expect(verdictOf('Looks good to me')).toEqual({ signed: false, objections: [] });
    expect(verdictOf('- VERDICT: signed.')).toEqual({ signed: true, objections: [] });
    expect(verdictOf('> **Verdict: signed**')).toEqual({ signed: true, objections: [] });
    expect(verdictOf(undefined)).toEqual({ signed: false, objections: [] });
  });

  it('does not take a mention of the verdict inside a sentence for one', () => {
    expect(
      verdictOf(
        'OBJECTION: Steps - rollback is missing.\nI cannot give VERDICT: signed until that is fixed.'
      )
    ).toEqual({ signed: false, objections: ['Steps - rollback is missing.'] });
    expect(
      verdictOf('End with VERDICT: signed or VERDICT: objections, they said. I object.')
    ).toEqual({
      signed: false,
      objections: [],
    });
    expect(verdictOf('VERDICT: signed, once step 3 is fixed').signed).toBe(false);
  });

  it('carries the objections as they were put', () => {
    const said = [
      'OBJECTION: Steps - step 3 writes the table before step 2 makes it',
      '- **OBJECTION:** Checks - no command runs the new tests',
      'VERDICT: objections',
    ].join('\n');
    expect(verdictOf(said)).toEqual({
      signed: false,
      objections: [
        'Steps - step 3 writes the table before step 2 makes it',
        'Checks - no command runs the new tests',
      ],
    });
    expect(verdictOf('OBJECTION: Goal - vague\nVERDICT: signed')).toEqual({
      signed: true,
      objections: [],
    });
  });
});

describe('the recipe plan', () => {
  it('has two agents plan apart, read each other, and settle on one plan', async () => {
    await start({ planners: ['codex', 'claude'] });
    const one = await taskOf(2);
    const two = await taskOf(3);
    expect(one.agent).toMatch(/^codex/);
    expect(two.agent).toMatch(/^claude/);
    expect(two.agent).not.toBe(starter.name);
    expect(one.cwd).toBe(repo);
    expect((await bridge.job(2)).type).toBe('plan');
    expect((await bridge.job(2)).worktree).toBeUndefined();
    expect(one.text).toContain('You are planner 1 of 2.');
    expect(one.text).toContain(`> ${TASK}`);
    expect(one.text).toContain('Change no file');
    expect(one.text).toContain(REPORT_TOOL);
    expect(one.text).toContain('The text of your report is the plan itself, whole');
    expect(one.text).toContain('## What is there today');
    expect(one.text).not.toContain('draft-');

    await say(2, '# Plan of codex\nA token bucket per route.\n');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(existsSync(fileOf('draft-1.md'))).toBe(false);
    expect(tasks().filter((task) => task.job > 3)).toEqual([]);
    await say(3, '# Plan of claude\nA sliding window.\n');

    const critique = await taskOf(4);
    const other = await taskOf(5);
    expect(readFileSync(fileOf('draft-1.md'), 'utf8')).toBe(
      '# Plan of codex\nA token bucket per route.\n'
    );
    expect(readFileSync(fileOf('draft-2.md'), 'utf8')).toContain('A sliding window.');
    expect(critique.agent).toBe(one.agent);
    expect(other.agent).toBe(two.agent);
    expect(critique.text).toContain(fileOf('draft-2.md'));
    expect(critique.text).not.toContain(fileOf('draft-1.md'));
    expect(critique.text).not.toContain('A sliding window.');
    expect(other.text).toContain(fileOf('draft-1.md'));
    expect(other.text).toContain('take:');
    expect(other.text).toContain(REPORT_TOOL);
    expect(other.text).toContain('The text of your report is the critique itself, whole');
    expect(other.text).toContain('beside:');
    await say(4, '1. take: the window is simpler to test');
    await say(5, '1. fault: a bucket per route leaks memory');

    const merge = await taskOf(6);
    expect(merge.agent).toBe(one.agent);
    expect(readFileSync(fileOf('critique-2.md'), 'utf8')).toContain('leaks memory');
    for (const name of ['draft-1.md', 'draft-2.md', 'critique-1.md', 'critique-2.md']) {
      expect(merge.text).toContain(fileOf(name));
    }
    expect(merge.text).toContain(`Write the joint plan to ${fileOf('plan.md')}`);
    expect(merge.text).toContain(fileOf('decisions.md'));
    expect(merge.text).toContain(REPORT_TOOL);
    writePlan();
    await say(6, 'Both files are written');

    const check = await taskOf(7);
    expect(check.agent).toBe(two.agent);
    expect(check.text).toContain(fileOf('plan.md'));
    expect(check.text).toContain('VERDICT: signed');
    expect(check.text).toContain(`${REPORT_TOOL} End your report with one line`);
    expect(check.text).toContain('OBJECTION: <heading> - <what is wrong and why>');
    await say(7, 'It holds.\nVERDICT: signed');

    const report = await reportOf(1);
    expect((await bridge.job(1)).state).toBe('completed');
    expect(report).toContain(
      `The joint plan of 2 agents is in ${fileOf('plan.md')}: ${one.agent} wrote it from the drafts and the critiques of all, and ${two.agent} signed it at the first check.`
    );
    expect(report).toContain(`Everything the planners wrote is in ${folderOf()}`);
    expect(report).toContain('Every step is a job of its own: #2, #3, #4, #5, #6, #7.');
    expect(report).toContain('cogitator bridge build');
    expect(report).not.toContain('Changed in the repository');
    expect(readFileSync(fileOf('plan.md'), 'utf8')).toBe('# Joint plan\n');
    expect(await bridge.jobs({ parent: 1 })).toHaveLength(6);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(errors).toEqual([]);
  });

  it('sends the merger back for objections, and ends when the checker signs', async () => {
    await start({
      planners: ['codex', 'claude'],
      out: 'docs/limiter-plan.md',
      context: { constraints: ['No new dependency'] },
    });
    expect((await taskOf(2)).text).toContain('No new dependency');
    expect((await taskOf(3)).text).toContain('No new dependency');
    await draftsAndCritiques();
    const merge = await taskOf(6);
    writePlan();
    await say(6, 'Written');
    await say(
      7,
      'OBJECTION: Steps - the limiter is used before it is made\nOBJECTION: Checks - nothing runs the tests\nVERDICT: objections'
    );

    const revise = await taskOf(8);
    expect(revise.agent).toBe(merge.agent);
    expect(revise.text).toContain('Steps - the limiter is used before it is made');
    expect(revise.text).toContain('Checks - nothing runs the tests');
    expect(revise.text).toContain(fileOf('decisions.md'));
    expect(revise.text).toContain(REPORT_TOOL);
    writePlan('# Joint plan, revised\n');
    await say(8, 'Both taken');

    const again = await taskOf(9);
    expect(again.text).toContain('This is check 2.');
    expect(again.text).toContain('Steps - the limiter is used before it is made');
    await say(9, 'VERDICT: signed');

    const report = await reportOf(1);
    expect((await bridge.job(1)).state).toBe('completed');
    expect(report).toContain('signed it at check 2');
    expect(report).toContain(`A copy is in ${join(repo, 'docs', 'limiter-plan.md')}.`);
    expect(readFileSync(join(repo, 'docs', 'limiter-plan.md'), 'utf8')).toBe(
      '# Joint plan, revised\n'
    );
    expect(readFileSync(fileOf('plan.md'), 'utf8')).not.toContain('Not agreed');
    expect(report).not.toContain('Changed in the repository');
    expect(errors).toEqual([]);
  });

  it('says what is not agreed when the rounds run out, in the report and in the plan', async () => {
    await start({ planners: ['codex', 'claude'], rounds: 0 });
    await draftsAndCritiques();
    const merge = await taskOf(6);
    writePlan();
    await say(6, 'Written');
    const check = await say(7, 'OBJECTION: Design - one process cannot share the bucket');

    const report = await reportOf(1);
    expect((await bridge.job(1)).state).toBe('completed');
    expect(report).toContain(
      `The joint plan of 2 agents is in ${fileOf('plan.md')}, and it is not agreed: 1 objection is open, and no round of answers is left.`
    );
    expect(report).toContain(`- ${check.agent}: Design - one process cannot share the bucket`);
    expect(report).toContain(fileOf('decisions.md'));
    const plan = readFileSync(fileOf('plan.md'), 'utf8');
    expect(plan.startsWith('# Joint plan\n')).toBe(true);
    expect(plan.match(/## Not agreed between the planners/g)).toHaveLength(1);
    expect(plan).toContain(`- ${check.agent}: Design - one process cannot share the bucket`);
    expect(plan).toContain(merge.agent);
    expect(await bridge.jobs({ parent: 1 })).toHaveLength(6);
    expect(errors).toEqual([]);
  });

  it('stops when a round of answers left no fewer objections open', async () => {
    await start({ planners: ['codex', 'claude'], rounds: 3 });
    await draftsAndCritiques();
    writePlan();
    await say(6, 'Written');
    await say(7, 'OBJECTION: Steps - a\nOBJECTION: Steps - b\nVERDICT: objections');
    await say(8, 'Answered');
    await say(9, 'OBJECTION: Steps - c\nOBJECTION: Risks - d\nVERDICT: objections');

    const report = await reportOf(1);
    expect(report).toContain(
      'it is not agreed: the last round of answers brought it no closer, with 2 objections open before it and 2 after. The bridge stopped here with 2 rounds left'
    );
    expect(report).toContain('Risks - d');
    expect(report).not.toContain('Steps - a');
    expect(await bridge.jobs({ parent: 1 })).toHaveLength(8);
    expect(readFileSync(fileOf('plan.md'), 'utf8')).toContain('Steps - c');
    expect(errors).toEqual([]);
  });

  it('goes on while the objections get fewer, and counts a checker that names none as one', async () => {
    await start({ planners: ['codex', 'claude'], rounds: 2 });
    await draftsAndCritiques();
    writePlan();
    await say(6, 'Written');
    await say(7, 'OBJECTION: Steps - a\nOBJECTION: Steps - b\nVERDICT: objections');
    await say(8, 'Answered');
    const check = await say(9, 'Still not there');
    await say(10, 'Answered again');
    await say(11, 'VERDICT: objections');

    const report = await reportOf(1);
    expect(report).toContain(
      'it is not agreed: 1 objection is open, and no round of answers is left.'
    );
    expect(report).toContain(`- ${check.agent} did not sign and named no objection`);
    expect(await bridge.jobs({ parent: 1 })).toHaveLength(10);
    expect(errors).toEqual([]);
  });

  it('leaves the plan as it is when the merger does not answer the objections', async () => {
    await start({ planners: ['codex', 'claude'] });
    await draftsAndCritiques();
    writePlan();
    await say(6, 'Written');
    await say(7, 'OBJECTION: Steps - a\nVERDICT: objections');
    const revise = await taskOf(8);
    await bridge.send(revise.agent, {
      job: 8,
      kind: 'report',
      body: 'Out of context',
      outcome: 'failed',
    });

    const report = await reportOf(1);
    expect((await bridge.job(1)).state).toBe('completed');
    expect(report).toContain(`it is not agreed: ${revise.agent} did not answer the objections`);
    expect(report).toContain('Steps - a');
    expect(await bridge.jobs({ parent: 1 })).toHaveLength(7);
    expect(readFileSync(fileOf('plan.md'), 'utf8')).toContain('## Not agreed between the planners');
    expect(errors).toEqual([]);
  });

  it('fails when only one agent wrote a draft, and says where it is', async () => {
    await start({ planners: ['codex', 'claude'] });
    const one = await say(2, '# Plan of codex\n');
    const two = await taskOf(3);
    await bridge.send(two.agent, { job: 3, kind: 'report', body: 'No access', outcome: 'failed' });

    const report = await reportOf(1);
    expect((await bridge.job(1)).state).toBe('failed');
    expect(report).toContain('No joint plan was written: 1 of 2 agents wrote a draft');
    expect(report).toContain(`${one.agent}: ${fileOf('draft-1.md')}`);
    expect(readFileSync(fileOf('draft-1.md'), 'utf8')).toBe('# Plan of codex\n');
    expect(await bridge.jobs({ parent: 1 })).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  it('asks the next planner to merge when the first leaves no plan', async () => {
    await start({ planners: ['codex', 'claude'] });
    await draftsAndCritiques();
    const first = await say(6, 'The plan is in my head');
    const second = await taskOf(7);
    expect(second.agent).toMatch(/^claude/);
    expect(second.text).toContain(`Write the joint plan to ${fileOf('plan.md')}`);
    writePlan();
    await say(7, 'Written');

    const check = await taskOf(8);
    expect(check.agent).toBe(first.agent);
    await say(8, 'VERDICT: signed');
    const report = await reportOf(1);
    expect((await bridge.job(1)).state).toBe('completed');
    expect(report).toContain(`${second.agent} wrote it`);
    expect(report).toContain(`${first.agent} signed it at the first check`);
    expect(report).toContain(`${first.agent} was asked to merge in job #6 and left no plan`);
    expect(errors).toEqual([]);
  });

  it('fails when nobody merges the drafts', async () => {
    await start({ planners: ['codex', 'claude'] });
    await draftsAndCritiques();
    await say(6, 'Nothing written');
    await say(7, 'Nothing written either');
    const report = await reportOf(1);
    expect((await bridge.job(1)).state).toBe('failed');
    expect(report).toContain('No joint plan was written: nobody merged the drafts');
    expect(report).toContain(fileOf('draft-2.md'));
    expect(errors).toEqual([]);
  });

  it('fails when nobody checks the merged plan', async () => {
    await start({ planners: ['codex', 'claude'] });
    await draftsAndCritiques();
    writePlan();
    await say(6, 'Written');
    const check = await taskOf(7);
    await bridge.send(check.agent, { job: 7, kind: 'report', body: 'Gone', outcome: 'failed' });
    const alone = await reportOf(1);
    expect((await bridge.job(1)).state).toBe('failed');
    expect(alone).toContain('nobody checked the plan');
    expect(alone).toContain(fileOf('plan.md'));
    expect(errors).toEqual([]);
  });

  it('goes on without a planner that wrote no draft, and without a critique', async () => {
    await start({ planners: ['codex', 'claude', 'codex'] });
    const one = await say(2, '# Plan one\n');
    const two = await say(3, '# Plan two\n');
    const three = await taskOf(4);
    await bridge.send(three.agent, { job: 4, kind: 'report', body: 'No time', outcome: 'failed' });

    const critique = await taskOf(5);
    expect(critique.agent).toBe(one.agent);
    expect(critique.text).toContain(fileOf('draft-2.md'));
    expect(critique.text).not.toContain('draft-3.md');
    await say(5, '1. gap: no migration');
    const silent = await taskOf(6);
    expect(silent.agent).toBe(two.agent);
    await bridge.send(silent.agent, { job: 6, kind: 'report', body: 'Lost it', outcome: 'failed' });

    const merge = await taskOf(7);
    expect(merge.agent).toBe(one.agent);
    expect(merge.text).toContain(fileOf('critique-1.md'));
    expect(merge.text).not.toContain('critique-2.md');
    writePlan();
    await say(7, 'Written');
    const check = await taskOf(8);
    expect(check.agent).toBe(two.agent);
    await say(8, 'VERDICT: signed');

    const report = await reportOf(1);
    expect((await bridge.job(1)).state).toBe('completed');
    expect(report).toContain('The joint plan of 2 agents');
    expect(report).toContain('Planner 3 (codex) wrote no draft');
    expect(report).toContain(`${two.agent} wrote no critique`);
    expect(await bridge.jobs({ parent: 1 })).toHaveLength(7);
    expect(errors).toEqual([]);
  });

  it('hands the place of a session that does not wake to a fresh one, with what it wrote', async () => {
    await start({ planners: ['codex', 'claude'] });
    const one = await say(2, '# Plan of codex\n');
    codexWakes = () => false;
    await say(3, '# Plan of claude\n');

    const critique = await taskOf(4);
    expect(critique.agent).not.toBe(one.agent);
    expect(critique.agent).toMatch(/^codex/);
    expect(critique.text).toContain('You are planner 1 of 2.');
    expect(critique.text).toContain(
      `You take the place of a session that planned as planner 1 before and is gone: its plan is in ${fileOf('draft-1.md')}.`
    );
    await say(4, '1. gap: no tests');
    await say(5, '1. take: the window');
    const merge = await taskOf(6);
    expect(merge.agent).not.toBe(critique.agent);
    expect(merge.text).toContain(`its critique in ${fileOf('critique-1.md')}`);
    writePlan();
    await say(6, 'Written');
    await say(7, 'VERDICT: signed');
    const report = await reportOf(1);
    expect(report).toContain(`${merge.agent} wrote it`);
    expect(errors).toEqual([]);
  });

  it('needs every checker to sign', async () => {
    await start({ planners: ['codex', 'claude', 'codex'], rounds: 0 });
    await say(2, '# One\n');
    await say(3, '# Two\n');
    await say(4, '# Three\n');
    await say(5, '1. take: x');
    await say(6, '1. take: y');
    await say(7, '1. take: z');
    writePlan();
    await say(8, 'Written');
    const signer = await say(9, 'VERDICT: signed');
    const other = await say(10, 'OBJECTION: Risks - no rollback\nVERDICT: objections');

    const report = await reportOf(1);
    expect(report).toContain('The joint plan of 3 agents');
    expect(report).toContain('it is not agreed: 1 objection is open');
    expect(report).toContain(`- ${other.agent}: Risks - no rollback`);
    expect(report).toContain(`${signer.agent} signed`);
    expect(errors).toEqual([]);
  });

  it('refuses a place for the copy that is outside or taken, before any agent is asked', async () => {
    writeFileSync(join(repo, 'taken.md'), 'mine\n');
    await start({ planners: ['codex', 'claude'], out: 'taken.md' });
    const taken = await reportOf(1);
    expect((await bridge.job(1)).state).toBe('failed');
    expect(taken).toContain('is there already');
    expect(await bridge.jobs({ parent: 1 })).toEqual([]);

    await start({ planners: ['codex', 'claude'], out: '../elsewhere.md' });
    const outside = await reportOf(2);
    expect((await bridge.job(2)).state).toBe('failed');
    expect(outside).toContain('outside');
    expect(tasks()).toEqual([]);
    expect(readFileSync(join(repo, 'taken.md'), 'utf8')).toBe('mine\n');
  });

  it('says in the report that the copy was not made when the place got taken on the way', async () => {
    await start({ planners: ['codex', 'claude'], out: 'plan.md' });
    await draftsAndCritiques();
    writePlan();
    await say(6, 'Written');
    writeFileSync(join(repo, 'plan.md'), 'somebody else\n');
    git(repo, 'add', 'plan.md');
    await say(7, 'VERDICT: signed');
    const report = await reportOf(1);
    expect((await bridge.job(1)).state).toBe('completed');
    expect(report).toContain('No copy was made');
    expect(report).toContain('is there already');
    expect(readFileSync(join(repo, 'plan.md'), 'utf8')).toBe('somebody else\n');
  });

  it('names what changed in the repository while the plan was written', async () => {
    writeFileSync(join(repo, 'before.ts'), 'was dirty\n');
    await start({ planners: ['codex', 'claude'], out: 'docs/plan.md' });
    await draftsAndCritiques();
    writeFileSync(join(repo, 'stray.ts'), 'export {};\n');
    writePlan();
    await say(6, 'Written');
    await say(7, 'VERDICT: signed');
    const report = await reportOf(1);
    expect(report).toContain(
      'Changed in the repository while the plan was written, by whom the bridge cannot tell:\n- ?? stray.ts'
    );
    expect(report).not.toContain('before.ts');
    expect(report).not.toContain('- ?? docs/plan.md');
  });

  it('plans in a folder that is no repository, and says it could not watch it', async () => {
    const plain = join(scratch, 'plain');
    mkdirSync(plain);
    const there = await bridge.register({
      harness: 'claude-code',
      sessionId: 'session-plain',
      cwd: plain,
      project: plain,
    });
    await start({ planners: ['codex', 'claude'] }, TASK, there);
    const one = await taskOf(2);
    expect(one.cwd).toBe(plain);
    await draftsAndCritiques();
    const merge = await taskOf(6);
    expect(merge.text).toContain(fileOf('plan.md', plain));
    writePlan('# Joint plan\n', plain);
    await say(6, 'Written');
    await say(7, 'VERDICT: signed');
    const report = await reportOf(1);
    expect((await bridge.job(1)).state).toBe('completed');
    expect(report).toContain(
      `${plain} is in no git repository, so the bridge could not see whether anything else was changed`
    );
    expect(errors).toEqual([]);
  });

  it('refuses fewer than two planners, more than four, and a task too long to read whole', async () => {
    await expect(start({ planners: ['codex'] })).rejects.toThrow();
    await expect(
      start({ planners: ['codex', 'claude', 'codex', 'claude', 'codex'] })
    ).rejects.toThrow();
    await expect(start({ planners: ['codex', 'claude'], rounds: 6 })).rejects.toThrow();
    await start({ planners: ['codex', 'claude'] }, 'x'.repeat(20_001));
    const report = await reportOf(1);
    expect((await bridge.job(1)).state).toBe('failed');
    expect(report).toContain('20000 characters at most');
    expect(tasks()).toEqual([]);
  });

  it('goes on in the middle of a round after the dispatcher was restarted', async () => {
    await start({ planners: ['codex', 'claude'], rounds: 0 });
    await say(2, '# Plan of codex\n');
    await say(3, '# Plan of claude\n');
    await say(4, '1. take: x');
    await taskOf(5);
    await bridge.close();

    bridge = open();
    const left = await bridge.job(5);
    await bridge.send(left.to, { job: 5, kind: 'report', body: '1. fault: y' });
    await until(async () => expect(await bridge.jobs({ parent: 1 })).toHaveLength(5));
    writePlan();
    const merge = await bridge.job(6);
    await bridge.send(merge.to, { job: 6, kind: 'report', body: 'Written' });
    await until(async () => expect(await bridge.jobs({ parent: 1 })).toHaveLength(6));
    await bridge.close();

    bridge = open();
    const check = await bridge.job(7);
    await bridge.send(check.to, {
      job: 7,
      kind: 'report',
      body: 'OBJECTION: Goal - vague\nVERDICT: objections',
    });
    const report = await reportOf(1);
    expect((await bridge.job(1)).state).toBe('completed');
    expect(report).toContain('it is not agreed: 1 objection is open');
    expect(await bridge.jobs({ parent: 1 })).toHaveLength(6);
    expect(readFileSync(fileOf('draft-1.md'), 'utf8')).toBe('# Plan of codex\n');
    expect(readFileSync(fileOf('critique-2.md'), 'utf8')).toBe('1. fault: y');
    expect(
      readFileSync(fileOf('plan.md'), 'utf8').match(/## Not agreed between the planners/g)
    ).toHaveLength(1);
    expect(await checkpoints.list('bridge-plan')).toEqual([]);
    expect(errors).toEqual([]);
  });
});
