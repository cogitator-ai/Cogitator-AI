import { afterEach, describe, expect, it } from 'vitest';
import type { CreatedSession, SessionRequest } from '../adapter';
import type { BridgeDispatcherOptions } from '../dispatcher';
import type { Finding } from '../findings';
import { recipeAdapter } from '../recipes';
import type { PersonRoute } from '../person';
import { FakeAdapter, makeKit, type Kit } from './bridge-kit';

let kit: Kit;
let started = 0;

const code = (value: string) => expect.objectContaining({ code: value });

function starts(harness: string, options: { wakes?: boolean } = {}): FakeAdapter {
  return new FakeAdapter({
    harness,
    createSession: async (request: SessionRequest): Promise<CreatedSession> => ({
      sessionId: `${request.harness}-started-${(started += 1)}`,
    }),
    ...(options.wakes !== undefined && { wakesFor: async () => options.wakes === true }),
  });
}

async function open(options: Omit<Partial<BridgeDispatcherOptions>, 'store' | 'now'> = {}) {
  kit = await makeKit({ adapters: [starts('claude-code'), starts('codex')], ...options });
  return kit;
}

/** A job Claude hands over, which its agent reports on as done. */
async function done(to: string, input: { type?: string; body?: string } = {}): Promise<number> {
  const { bridge, claude } = kit;
  const created = await bridge.createJob(claude.name, {
    to,
    body: input.body ?? `Do the thing ${(started += 1)}`,
    ...(input.type && { type: input.type }),
  });
  await bridge.idle();
  const { job } = created;
  await bridge.send(job.to, { job: job.number, kind: 'report', body: 'Done' });
  return job.number;
}

/** Has the work of a job reviewed by a fresh Claude session, which reports the findings given. */
async function reviewed(job: number, findings: Finding[]): Promise<number> {
  const { bridge, claude } = kit;
  const review = await bridge.createJob(claude.name, {
    to: 'claude:new',
    body: `Review job ${job}, pass ${(started += 1)}`,
    type: 'review',
    reviewOf: job,
  });
  await bridge.idle();
  await bridge.send(review.job.to, {
    job: review.job.number,
    kind: 'report',
    body: 'Reviewed',
    findings,
  });
  return review.job.number;
}

const MAJOR: Finding = { severity: 'major', summary: 'The limit is off by one' };
const NIT: Finding = { severity: 'nit', summary: 'A name could be shorter' };

afterEach(async () => {
  await kit.close();
  started = 0;
});

describe('the type of a job and its result', () => {
  it('keeps the type on the record, in lower case, and refuses a type that is no word', async () => {
    const { bridge, claude, codex } = await open();
    const { job } = await bridge.createJob(claude.name, {
      to: codex.name,
      body: 'Write the docs',
      type: ' Docs ',
    });
    expect(job.type).toBe('docs');
    await expect(
      bridge.createJob(claude.name, { to: codex.name, body: 'More', type: 'two words' })
    ).rejects.toMatchObject(code('invalid_input'));
  });

  it('counts what a review found on the job it reviewed, from findings or from the text', async () => {
    const { bridge, claude, codex } = await open();
    const work = await done(codex.name, { type: 'code' });
    const first = await reviewed(work, [MAJOR, NIT]);
    expect((await bridge.job(work)).reviews).toEqual([
      expect.objectContaining({ job: first, blocker: 0, major: 1, minor: 0, nit: 1 }),
    ]);
    expect((await bridge.job(first)).reviewOf).toBe(work);

    const second = await bridge.createJob(claude.name, {
      to: 'claude:new',
      body: `Review job ${work} once more`,
      reviewOf: work,
    });
    await bridge.idle();
    await bridge.send(second.job.to, {
      job: second.job.number,
      kind: 'report',
      body: 'Looked again.\n[minor] src/limiter.ts:12 - the comment is stale\n',
    });
    const now = await bridge.job(work);
    expect(now.reviews?.map((review) => [review.job, review.major, review.minor])).toEqual([
      [first, 1, 0],
      [second.job.number, 0, 1],
    ]);
    expect((await bridge.job(second.job.number)).findings).toEqual([
      expect.objectContaining({ severity: 'minor', file: 'src/limiter.ts', line: 12 }),
    ]);
  });

  it('counts no review that failed or said nothing the bridge reads', async () => {
    const { bridge, claude, codex } = await open();
    const work = await done(codex.name);
    const unread = await bridge.createJob(claude.name, {
      to: 'claude:new',
      body: `Review job ${work}`,
      reviewOf: work,
    });
    await bridge.idle();
    await bridge.send(unread.job.to, {
      job: unread.job.number,
      kind: 'report',
      body: 'Looks fine to me',
    });
    const failed = await bridge.createJob(claude.name, {
      to: 'claude:new',
      body: `Review job ${work} again`,
      reviewOf: work,
    });
    await bridge.idle();
    await bridge.send(failed.job.to, {
      job: failed.job.number,
      kind: 'report',
      body: 'Could not read the worktree',
      outcome: 'failed',
      findings: [MAJOR],
    });
    expect((await bridge.job(work)).reviews).toBeUndefined();
  });

  it('lets only somebody with a say in a job have its work reviewed', async () => {
    const { bridge, claude, codex } = await open();
    const work = await done(codex.name);
    const stranger = await bridge.register({
      harness: 'codex',
      sessionId: 'thread-other',
      cwd: '/work/other',
      project: '/work/other',
    });
    await expect(
      bridge.createJob(stranger.name, { to: 'claude:new', body: 'Review it', reviewOf: work })
    ).rejects.toMatchObject(code('not_a_party'));
    await expect(
      bridge.createJob(claude.name, { to: 'claude:new', body: 'Review it', reviewOf: 999 })
    ).rejects.toMatchObject(code('unknown_job'));
    await expect(
      bridge.createJob(codex.name, { to: 'claude:new', body: 'Review my own work', reviewOf: work })
    ).resolves.toMatchObject({ job: { reviewOf: work } });
  });

  it('lists what became of the jobs that ended, without recipes and canceled jobs', async () => {
    const { bridge, claude, codex, clock } = await open({
      adapters: [starts('claude-code'), starts('codex'), recipeAdapter({ pollMs: 5 })],
    });
    const good = await done(codex.name, { type: 'code' });
    await reviewed(good, [NIT]);
    clock.advance(60_000);
    const bad = await done(codex.name, { type: 'code' });
    await reviewed(bad, [MAJOR]);
    const going = await bridge.createJob(claude.name, { to: codex.name, body: 'Still going' });
    const canceled = await bridge.createJob(claude.name, { to: codex.name, body: 'Never mind' });
    await bridge.cancel(claude.name, canceled.job.number);

    const all = await bridge.results();
    const byJob = new Map(all.map((result) => [result.job, result]));
    expect(byJob.get(good)).toMatchObject({
      harness: 'codex',
      type: 'code',
      outcome: 'good',
      grounds: ['a review found nothing above minor'],
      findings: { blocker: 0, major: 0, minor: 0, nit: 1 },
    });
    expect(byJob.get(bad)).toMatchObject({ outcome: 'bad', grounds: ['a review found 1 major'] });
    expect(byJob.has(going.job.number)).toBe(false);
    expect(byJob.has(canceled.job.number)).toBe(false);
    expect(all.filter((result) => result.type === 'review')).toHaveLength(2);
    expect(all.every((result) => result.harness !== 'recipe')).toBe(true);

    expect((await bridge.results({ type: 'code' })).map((result) => result.job)).toEqual([
      bad,
      good,
    ]);
    expect(await bridge.results({ harness: 'claude', type: 'code' })).toEqual([]);
    expect(await bridge.results({ limit: 1 })).toHaveLength(1);
  });

  it('forgets a result once it is older than the window of the scoreboard', async () => {
    const { bridge, codex, clock } = await open({ limits: { scoreWindowMs: 3_600_000 } });
    const old = await done(codex.name);
    clock.advance(2 * 3_600_000);
    const fresh = await done(codex.name);
    expect((await bridge.results()).map((result) => result.job)).toEqual([fresh]);
    expect(old).toBeLessThan(fresh);
  });

  it('counts how many times a job needed the person', async () => {
    const asked: string[] = [];
    const person: PersonRoute = {
      ask: async (waiting) => {
        asked.push(waiting.letter.id);
      },
      settle: async () => undefined,
    };
    const { bridge, claude, codex } = await open({ person });
    const { job } = await bridge.createJob(claude.name, { to: codex.name, body: 'Deploy it' });
    await bridge.inbox(codex.name);
    const question = await bridge.send(codex.name, {
      job: job.number,
      kind: 'question',
      body: 'Which region?',
    });
    await bridge.inbox(claude.name);
    await bridge.escalate(claude.name, { letter: question.letter.id });
    await bridge.escalate(claude.name, { letter: question.letter.id });
    expect((await bridge.job(job.number)).personNeeded).toBe(1);

    await bridge.stuck(codex.name, { what: 'Allow the push?' });
    expect((await bridge.job(job.number)).personNeeded).toBe(2);
    await bridge.personAnswer({ letter: question.letter.id, body: 'eu-west' });
    await bridge.send(codex.name, { job: job.number, kind: 'report', body: 'Deployed' });
    await bridge.idle();
    expect(asked).toEqual([question.letter.id]);
    expect((await bridge.results())[0]).toMatchObject({ job: job.number, person: 2 });
  });
});

describe('suggest and auto', () => {
  it('says there is not enough data, and auto tries the agent that has done the fewest jobs', async () => {
    const { bridge, claude } = await open();
    const suggestion = await bridge.suggest({ type: 'code' });
    expect(suggestion).toMatchObject({ basis: 'trial', best: 'claude-code', minJobs: 5 });
    expect(suggestion.windowMs).toBe(60 * 86_400_000);
    expect(suggestion.reason).toMatch(/^Not enough data to tell the agents apart/);

    const { job, routed } = await bridge.createJob(claude.name, {
      to: 'auto',
      body: 'Fix the limiter',
      type: 'code',
    });
    await bridge.idle();
    expect(routed).toBe(suggestion.reason);
    expect(job.routed).toBe(suggestion.reason);
    expect(job.to).toBe('claude-2@demo');
    expect((await bridge.agents()).find((agent) => agent.name === job.to)).toMatchObject({
      harness: 'claude-code',
      status: 'active',
    });
    const [entry] = (await bridge.readJournal({ job: job.number })).filter(
      (line) => line.type === 'job.created'
    );
    expect(entry.data).toMatchObject({ type: 'code', routed: suggestion.reason });

    await bridge.send(job.to, { job: job.number, kind: 'report', body: 'Done' });
    const next = await bridge.suggest({ type: 'code' });
    expect(next).toMatchObject({ basis: 'trial', best: 'codex' });
    expect(next.reason).toContain('and codex has none. It takes this one');
  });

  it('gives a job to the agent whose jobs of that type held best', async () => {
    const { bridge, claude, codex } = await open({ limits: { scoreMinJobs: 2 } });
    for (let index = 0; index < 3; index += 1) {
      await reviewed(await done(codex.name, { type: 'code' }), []);
    }
    for (let index = 0; index < 3; index += 1) {
      await reviewed(await done('claude:new', { type: 'code' }), index === 0 ? [] : [MAJOR]);
    }
    const suggestion = await bridge.suggest({ type: 'code' });
    expect(suggestion).toMatchObject({ basis: 'type', best: 'codex' });
    expect(suggestion.candidates.map((candidate) => [candidate.harness, candidate.good])).toEqual([
      ['codex', 3],
      ['claude-code', 1],
    ]);

    const { job, routed } = await bridge.createJob(claude.name, {
      to: 'auto',
      body: 'One more fix',
      type: 'code',
    });
    expect(job.to).toBe(codex.name);
    expect(routed).toContain('codex: 3 of 3 held');

    const other = await bridge.suggest({ type: 'docs' });
    expect(other.basis).toBe('all');
    expect(other.reason).toMatch(/^Not enough docs jobs to tell the agents apart/);
  });

  it('starts a fresh session where the one that is there would not wake, or with auto:new', async () => {
    const { bridge, claude } = await open({
      adapters: [starts('codex', { wakes: false }), starts('claude-code')],
    });
    const asleep = await bridge.createJob(claude.name, { to: 'auto', body: 'Wake up' });
    expect(asleep.job.to).toBe('codex-2@demo');
    await bridge.idle();

    await kit.close();
    const awake = await open({ adapters: [starts('codex'), starts('claude-code')] });
    const same = await awake.bridge.createJob(awake.claude.name, { to: 'auto', body: 'Same one' });
    expect(same.job.to).toBe(awake.codex.name);
    const fresh = await awake.bridge.createJob(awake.claude.name, {
      to: 'auto:new',
      body: 'A new one',
    });
    expect(fresh.job.to).toBe('codex-2@demo');
    await awake.bridge.idle();
  });

  it('refuses auto when the bridge can start nobody, and for the job of a recipe', async () => {
    const { bridge, claude } = await open({ adapters: [recipeAdapter({ pollMs: 5 })] });
    await expect(
      bridge.createJob(claude.name, { to: 'auto', body: 'Anybody?' })
    ).rejects.toMatchObject({
      code: 'no_session',
      message: expect.stringContaining('The bridge knows no agent it can start a session of'),
    });
    await expect(
      bridge.createJob(claude.name, {
        to: 'auto',
        body: 'Build it',
        recipe: { name: 'build', input: { to: 'codex' } },
      })
    ).rejects.toMatchObject(code('invalid_input'));
  });

  it('does not ask the scoreboard again for a job handed over twice under one id', async () => {
    const { bridge, claude } = await open();
    const first = await bridge.createJob(claude.name, {
      to: 'auto',
      body: 'Once',
      letterId: 'once-1',
    });
    await bridge.idle();
    const again = await bridge.createJob(claude.name, {
      to: 'auto',
      body: 'Once',
      letterId: 'once-1',
    });
    expect(again).toMatchObject({ duplicate: true, job: { number: first.job.number } });
    expect(again.routed).toBe(first.routed);
    expect((await bridge.jobs()).length).toBe(1);

    await expect(bridge.createJob(claude.name, { to: 'auto', body: 'Once' })).rejects.toMatchObject(
      code('loop_detected')
    );
  });

  it('gives a job to no session the caller works for, which would wait for it in turn', async () => {
    const { bridge, claude, codex } = await open();
    const { job } = await bridge.createJob(claude.name, {
      to: codex.name,
      body: 'The whole thing',
    });
    await bridge.inbox(codex.name);

    const part = await bridge.createJob(codex.name, { to: 'auto', body: 'A part of it' });
    expect(part.job.parent).toBe(job.number);
    expect(part.job.to).toBe('claude-2@demo');
    await bridge.idle();

    const byWord = await bridge.createJob(codex.name, { to: 'claude:new', body: 'Another part' });
    expect(byWord.job.to).toBe('claude-3@demo');
    await bridge.idle();
  });

  it('takes the next agent when the bridge can start no more sessions for the first', async () => {
    let release: (session: CreatedSession) => void = () => undefined;
    const hangs = new FakeAdapter({
      harness: 'claude-code',
      createSession: () =>
        new Promise<CreatedSession>((resolve) => {
          release = resolve;
        }),
    });
    const { bridge, claude, codex } = await open({
      adapters: [hangs, starts('codex')],
      limits: { maxStartingSessions: 1 },
    });
    try {
      await bridge.register({
        harness: 'claude-code',
        sessionId: 'session-other',
        cwd: '/work/demo',
        project: '/work/demo',
      });
      const first = await bridge.createJob(claude.name, { to: 'claude:new', body: 'One' });
      expect(first.job.to).toBe('claude-3@demo');

      const second = await bridge.createJob(claude.name, { to: 'auto', body: 'Two' });
      expect(second.job.to).toBe(codex.name);
      expect(second.routed).toContain(
        'The job could not go there (claude: The bridge is already starting 1 sessions'
      );
      expect(second.routed).toMatch(/so codex took it$/);
    } finally {
      release({ sessionId: 'claude-late' });
      await bridge.idle();
    }
  });

  it('has a review done by another agent than the one that did the work, when there is one', async () => {
    const { bridge, claude } = await open();
    const work = await done('claude:new', { type: 'code' });
    const suggestion = await bridge.suggest({ type: 'review' });
    expect(suggestion.best).toBe('codex');
    await done('codex:new');
    expect((await bridge.suggest({ type: 'review' })).best).toBe('claude-code');

    const review = await bridge.createJob(claude.name, {
      to: 'auto:new',
      body: 'Review it',
      type: 'review',
      reviewOf: work,
    });
    expect(review.job.to).toMatch(/^codex-\d@demo$/);
    expect(review.routed).toMatch(/claude did the work this job reviews, so codex took it$/);
    await bridge.idle();
  });
});

describe('what counts for and against an agent', () => {
  it('counts no review the author of the work made, or had made, of its own work', async () => {
    const { bridge, claude, codex } = await open();
    const work = await done(codex.name, { type: 'code' });

    const own = await bridge.createJob(codex.name, {
      to: 'claude:new',
      body: 'Say my work is fine',
      reviewOf: work,
    });
    await bridge.idle();
    await bridge.send(own.job.to, {
      job: own.job.number,
      kind: 'report',
      body: 'Fine',
      findings: [],
    });
    expect((await bridge.job(work)).reviews).toBeUndefined();

    const self = await bridge.createJob(claude.name, {
      to: codex.name,
      body: 'Review your own work',
      reviewOf: work,
    });
    await bridge.send(codex.name, {
      job: self.job.number,
      kind: 'report',
      body: 'Fine',
      findings: [],
    });
    expect((await bridge.job(work)).reviews).toBeUndefined();
    expect((await bridge.results({ type: 'code' }))[0]).toMatchObject({ outcome: 'unknown' });
  });

  it('keeps the first reviews of a job, so later ones cannot push a finding out', async () => {
    const { bridge, codex } = await open({ limits: { jobsPerHour: 200, maxOpenJobs: 200 } });
    const work = await done(codex.name, { type: 'code' });
    await reviewed(work, [MAJOR]);
    for (let index = 0; index < 21; index += 1) await reviewed(work, []);

    const kept = (await bridge.job(work)).reviews ?? [];
    expect(kept).toHaveLength(20);
    expect(kept[0]).toMatchObject({ major: 1 });
    expect((await bridge.results({ type: 'code' }))[0]).toMatchObject({ outcome: 'bad' });
  });

  it('holds against an agent only the failures that were its own doing', async () => {
    const broken = new FakeAdapter({
      harness: 'codex',
      createSession: async () => {
        throw new Error('codex: command not found');
      },
    });
    const { bridge, claude, clock } = await open({ adapters: [starts('claude-code'), broken] });

    const unstarted = await bridge.createJob(claude.name, {
      to: 'codex:new',
      body: 'Never starts',
    });
    await bridge.idle();
    expect(await bridge.job(unstarted.job.number)).toMatchObject({
      state: 'failed',
      failure: 'other',
    });

    const gaveUp = await bridge.createJob(claude.name, { to: 'claude:new', body: 'Too hard' });
    await bridge.idle();
    await bridge.send(gaveUp.job.to, {
      job: gaveUp.job.number,
      kind: 'report',
      body: 'Cannot do it',
      outcome: 'failed',
    });

    const silent = await bridge.createJob(claude.name, { to: 'claude:new', body: 'No answer' });
    await bridge.idle();
    await bridge.send(claude.name, {
      job: silent.job.number,
      kind: 'question',
      body: 'How far are you?',
    });
    clock.advance(31 * 60_000);
    await bridge.sweep();
    clock.advance(31 * 60_000);
    await bridge.sweep();

    const byJob = new Map((await bridge.results()).map((result) => [result.job, result]));
    expect(byJob.get(unstarted.job.number)).toMatchObject({ outcome: 'unknown', state: 'failed' });
    expect(byJob.get(unstarted.job.number)?.grounds[0]).toContain(
      "which was not its agent's doing"
    );
    expect(byJob.get(gaveUp.job.number)).toMatchObject({ outcome: 'bad' });
    expect(await bridge.job(silent.job.number)).toMatchObject({
      state: 'failed',
      failure: 'silent',
    });
    expect(byJob.get(silent.job.number)).toMatchObject({ outcome: 'bad' });
  });

  it('counts one wait at a window once, however often the harness lists it', async () => {
    let waiting: string | undefined = 'permission prompt';
    const listed = new FakeAdapter({
      harness: 'codex',
      liveSessions: async () => [
        { sessionId: 'thread-codex', ...(waiting !== undefined && { waitingFor: waiting }) },
      ],
    });
    const { bridge, claude, codex, clock } = await open({
      adapters: [starts('claude-code'), listed],
      limits: { windowNoticeMs: 60_000 },
    });
    const { job } = await bridge.createJob(claude.name, { to: codex.name, body: 'Deploy it' });
    await bridge.inbox(codex.name);
    for (let look = 0; look < 4; look += 1) {
      clock.advance(61_000);
      await bridge.sweep();
      await bridge.idle();
    }
    expect((await bridge.job(job.number)).personNeeded).toBe(1);

    waiting = undefined;
    clock.advance(61_000);
    await bridge.sweep();
    await bridge.idle();
    waiting = 'permission prompt';
    clock.advance(61_000);
    await bridge.sweep();
    await bridge.idle();
    expect((await bridge.job(job.number)).personNeeded).toBe(2);
  });
});
