import { afterEach, describe, expect, it } from 'vitest';
import type { BridgeAdapter, CreatedSession, SessionRequest } from '../adapter';
import type { BridgeDispatcherOptions } from '../dispatcher';
import type { PersonNotice, PersonRoute } from '../person';
import { T0 } from './helpers';
import { FakeAdapter, makeKit, type Kit } from './bridge-kit';

let kit: Kit;
let started = 0;

const code = (value: string) => expect.objectContaining({ code: value });
const iso = (ms: number): string => new Date(ms).toISOString();

function starts(harness: string): FakeAdapter {
  return new FakeAdapter({
    harness,
    createSession: async (request: SessionRequest): Promise<CreatedSession> => ({
      sessionId: `${request.harness}-started-${(started += 1)}`,
    }),
  });
}

async function open(options: Omit<Partial<BridgeDispatcherOptions>, 'store' | 'now'> = {}) {
  kit = await makeKit({ adapters: [starts('claude-code'), starts('codex')], ...options });
  return kit;
}

afterEach(async () => {
  await kit.close();
  started = 0;
});

describe('a harness that ran into its limit', () => {
  it('takes no job until the time it named, and is passed over by auto', async () => {
    const { bridge, claude, codex, clock } = await open();
    const until = T0 + 2 * 3_600_000;

    const noted = await bridge.limited(codex.name, {
      until: iso(until),
      detail: "You've hit your usage limit.\nTry again at 3:07 PM.",
    });
    expect(noted).toMatchObject({
      limit: {
        harness: 'codex',
        until: iso(until),
        told: true,
        detail: "You've hit your usage limit. Try again at 3:07 PM.",
        since: iso(T0),
        agent: codex.name,
      },
      redirected: [],
      failed: [],
    });
    expect((await bridge.status()).limited).toEqual([noted.limit]);
    expect(await bridge.limitsInForce()).toEqual([noted.limit]);

    for (const to of ['codex', 'codex:new', codex.name]) {
      await expect(bridge.createJob(claude.name, { to, body: `For ${to}` })).rejects.toMatchObject({
        code: 'limit_reached',
        message: expect.stringMatching(/^codex is out of its limit until \S+/),
        data: { harness: 'codex', until: iso(until) },
      });
    }

    const suggestion = await bridge.suggest();
    expect(suggestion.best).toBe('claude-code');
    expect(suggestion.candidates.find((candidate) => candidate.harness === 'codex')).toMatchObject({
      available: false,
      unavailable: expect.stringMatching(/^out of its limit until \S+ \(You've hit your usage/),
    });
    const routed = await bridge.createJob(claude.name, { to: 'auto', body: 'Anybody' });
    expect(routed.job.to).toBe('claude-2@demo');
    await bridge.idle();

    clock.advance(2 * 3_600_000);
    await bridge.sweep();
    expect((await bridge.status()).limited).toEqual([]);
    await expect(
      bridge.createJob(claude.name, { to: codex.name, body: 'Back again' })
    ).resolves.toMatchObject({ job: { to: codex.name } });
    const lifted = (await bridge.readJournal()).filter((entry) =>
      entry.type.startsWith('harness.')
    );
    expect(lifted.map((entry) => [entry.type, entry.data?.harness])).toEqual([
      ['harness.limited', 'codex'],
      ['harness.unlimited', 'codex'],
    ]);
  });

  it('is tried again after a while when it named no time, or one that cannot be right', async () => {
    const { bridge, codex } = await open({ limits: { limitRetryMs: 10 * 60_000 } });
    const { limit } = await bridge.limited(codex.name, { detail: 'Rate limit reached' });
    expect(limit).toMatchObject({ until: iso(T0 + 10 * 60_000), told: false });

    for (const until of [iso(T0 - 1000), iso(T0 + 40 * 86_400_000)]) {
      const again = await bridge.limited(codex.name, { until });
      expect(again.limit).toMatchObject({ until: iso(T0 + 10 * 60_000), told: false });
    }
    await expect(bridge.limited('nobody@demo')).rejects.toMatchObject(code('not_registered'));
  });

  it('keeps the longer of two limits: a session that names no time cuts none short', async () => {
    const { bridge, claude, codex, clock } = await open();
    const other = await bridge.register({
      harness: 'codex',
      sessionId: 'thread-other',
      cwd: '/work/demo',
      project: '/work/demo',
    });
    const evening = T0 + 5 * 3_600_000;
    const first = await bridge.limited(codex.name, { until: iso(evening), detail: 'resets 8pm' });

    clock.advance(60_000);
    const second = await bridge.limited(other.name, { detail: 'Rate limit reached' });
    expect(second.limit).toEqual(first.limit);

    const later = await bridge.limited(other.name, { until: iso(evening + 3_600_000) });
    expect(later.limit).toMatchObject({
      until: iso(evening + 3_600_000),
      told: true,
      since: iso(T0),
      agent: other.name,
    });
    expect((await bridge.status()).limited).toHaveLength(1);
    await expect(
      bridge.createJob(claude.name, { to: 'codex:new', body: 'Not yet' })
    ).rejects.toMatchObject(code('limit_reached'));
    const refused = (await bridge.readJournal()).filter(
      (entry) => entry.type === 'letter.rejected'
    );
    expect(refused.at(-1)?.data).toMatchObject({ reason: 'limit_reached', to: 'codex:new' });
  });

  it('is taken back by a report of one of its agents, and by the person', async () => {
    const { bridge, claude, codex } = await open();
    const other = await bridge.createJob(codex.name, { to: claude.name, body: 'A job' });
    const failing = await bridge.createJob(codex.name, { to: claude.name, body: 'A third' });
    const { job } = await bridge.createJob(codex.name, { to: 'claude:new', body: 'Another' });
    await bridge.idle();
    await bridge.limited(job.to);
    await bridge.idle();
    expect((await bridge.status()).limited).toHaveLength(1);
    expect((await bridge.job(other.job.number)).to).toBe(claude.name);

    await bridge.send(claude.name, {
      job: failing.job.number,
      kind: 'report',
      body: 'Could not',
      outcome: 'failed',
    });
    expect((await bridge.status()).limited).toHaveLength(1);

    await bridge.send(claude.name, { job: other.job.number, kind: 'report', body: 'Done' });
    expect((await bridge.status()).limited).toEqual([]);

    await bridge.limited(codex.name);
    expect(await bridge.unlimit('codex')).toBe(true);
    expect(await bridge.unlimit('codex')).toBe(false);
    await bridge.limited(codex.name);
    expect(await bridge.unlimit(codex.name)).toBe(true);
    await expect(bridge.unlimit('nobody@demo')).rejects.toMatchObject(code('unknown_agent'));
    expect((await bridge.status()).limited).toEqual([]);
  });

  it('tells the person once, and not again while the limit holds', async () => {
    const told: PersonNotice[] = [];
    const person: PersonRoute = {
      ask: async () => undefined,
      settle: async () => undefined,
      tell: async (notice) => {
        told.push(notice);
      },
    };
    const { bridge, codex } = await open({ person });
    await bridge.limited(codex.name, { detail: 'Rate limit reached' });
    await bridge.limited(codex.name, { detail: 'Rate limit reached' });
    await bridge.idle();
    expect(told).toHaveLength(1);
    expect(told[0].text).toMatch(
      /^codex is out of its limit until \S+, when the bridge tries it again \(Rate limit reached\)\. The bridge hands it no job until then$/
    );
  });
});

describe('the jobs of an agent whose harness ran into its limit', () => {
  it('go to a fresh session of another harness, with what was left in the folder', async () => {
    const { bridge, claude, codex } = await open();
    const { job } = await bridge.createJob(claude.name, {
      to: codex.name,
      body: 'Fix the limiter',
      type: 'fix',
    });
    await bridge.inbox(codex.name);
    await bridge.send(codex.name, { job: job.number, kind: 'question', body: 'Which window?' });
    const part = await bridge.createJob(codex.name, { to: 'claude:new', body: 'A part of it' });
    await bridge.idle();
    await bridge.inbox(claude.name);

    const { redirected, failed } = await bridge.limited(codex.name, {
      detail: "You've hit your usage limit.",
    });
    await bridge.idle();
    expect(failed).toEqual([]);
    expect(redirected).toEqual([{ job: job.number, to: 'claude-3@demo' }]);

    const now = await bridge.job(job.number);
    expect(now).toMatchObject({
      to: 'claude-3@demo',
      state: 'working',
      lettersUsed: 3,
      redirects: [
        {
          from: codex.name,
          to: 'claude-3@demo',
          why: "ran into the limit of codex (You've hit your usage limit.)",
        },
      ],
    });
    expect((await bridge.job(part.job.number)).state).toBe('canceled');

    const claudeAdapter = (await bridge.agents()).find((agent) => agent.name === now.to);
    expect(claudeAdapter).toMatchObject({ harness: 'claude-code', status: 'active', cwd: job.cwd });
    const handed = (await bridge.letters({ job: job.number, to: now.to, kinds: ['task'] }))[0];
    expect(handed.body).toBe('Fix the limiter');
    const [text] = (await bridge.inbox(now.to, { peek: true, unhandled: true }))
      .filter((letter) => letter.kind === 'task')
      .map((letter) => letter.text);
    expect(text).toContain(
      `[agent bridge] ${codex.name} had this job before you, and ran into the limit of codex (You've hit your usage limit.), so the job is yours now.`
    );

    const mail = (await bridge.inbox(claude.name)).map((letter) => letter.body);
    expect(mail.join('\n')).toContain(
      `Job #${job.number}: ${codex.name} ran into the limit of codex (You've hit your usage limit.), so the bridge handed the job to claude-3@demo`
    );
    const left = (await bridge.inbox(codex.name)).map((letter) => letter.body);
    expect(left.join('\n')).not.toContain('no longer yours');
    expect(Date.parse(now.deadlineAt)).toBe(T0 + 4 * 3_600_000);
    await expect(
      bridge.send(codex.name, { job: job.number, kind: 'report', body: 'Too late' })
    ).rejects.toMatchObject(code('not_a_party'));

    await bridge.send(now.to, { job: job.number, kind: 'report', body: 'Fixed' });
    expect((await bridge.results({ type: 'fix' }))[0]).toMatchObject({
      job: job.number,
      agent: 'claude-3@demo',
      harness: 'claude-code',
    });
    const entry = (await bridge.readJournal({ job: job.number })).find(
      (line) => line.type === 'job.redirected'
    );
    expect(entry?.data).toMatchObject({ from: codex.name, to: 'claude-3@demo' });
  });

  it('fail, and not by the doing of their agent, when nobody else takes jobs', async () => {
    const { bridge, claude, codex, clock } = await open({ adapters: [starts('codex')] });
    const { job } = await bridge.createJob(claude.name, { to: codex.name, body: 'Fix it' });
    await bridge.inbox(codex.name);
    clock.advance(60_000);

    const { failed, redirected, limit } = await bridge.limited(codex.name, {
      until: iso(T0 + 3_600_000),
    });
    expect(redirected).toEqual([]);
    expect(failed).toEqual([job.number]);
    expect(limit.told).toBe(true);
    const ended = await bridge.job(job.number);
    expect(ended).toMatchObject({ state: 'failed', failure: 'other', to: codex.name });
    expect(ended.reason).toMatch(
      /^codex@demo ran into the limit of codex \(it takes no more requests\), and no other agent takes jobs now\. codex is back at \S+$/
    );
    expect((await bridge.results())[0]).toMatchObject({ job: job.number, outcome: 'unknown' });
  });

  it('go to a harness of last resort only when no other takes jobs, and never back', async () => {
    const { bridge, claude, codex } = await open({
      adapters: [starts('claude-code'), starts('codex'), starts('qwen')],
      routing: { fallback: ['qwen'] },
    });
    const usual = await bridge.suggest();
    expect(usual.best).toBe('claude-code');
    expect(
      usual.candidates.map((candidate) => [candidate.harness, candidate.lastResort === true])
    ).toEqual([
      ['claude-code', false],
      ['codex', false],
      ['qwen', true],
    ]);

    const { job } = await bridge.createJob(claude.name, { to: codex.name, body: 'Fix it' });
    await bridge.inbox(codex.name);
    const first = await bridge.limited(codex.name);
    await bridge.idle();
    expect(first.redirected).toEqual([{ job: job.number, to: 'claude-2@demo' }]);

    const second = await bridge.limited('claude-2@demo');
    await bridge.idle();
    expect(second.redirected).toEqual([{ job: job.number, to: 'qwen@demo' }]);
    expect((await bridge.job(job.number)).redirects?.map((past) => past.to)).toEqual([
      'claude-2@demo',
      'qwen@demo',
    ]);

    const suggestion = await bridge.suggest();
    expect(suggestion.best).toBe('qwen');
    expect(
      suggestion.candidates.map((candidate) => [candidate.harness, candidate.available])
    ).toEqual([
      ['claude-code', false],
      ['codex', false],
      ['qwen', true],
    ]);

    const third = await bridge.limited('qwen@demo');
    expect(third).toMatchObject({ redirected: [], failed: [job.number] });
    await expect(
      bridge.createJob(claude.name, { to: 'auto', body: 'Anybody' })
    ).rejects.toMatchObject(code('no_session'));
  });

  it('start their new sessions one after another, no more at once than the bridge starts', async () => {
    const releases: ((session: CreatedSession) => void)[] = [];
    const slow = new FakeAdapter({
      harness: 'claude-code',
      createSession: () =>
        new Promise<CreatedSession>((resolve) => {
          releases.push(resolve);
        }),
    });
    const { bridge, claude, codex } = await open({
      adapters: [slow, starts('codex')],
      limits: { maxStartingSessions: 1 },
    });
    const jobs: number[] = [];
    for (const body of ['One', 'Two', 'Three']) {
      const { job } = await bridge.createJob(claude.name, { to: codex.name, body });
      jobs.push(job.number);
    }
    await bridge.inbox(codex.name);

    const { redirected } = await bridge.limited(codex.name);
    expect(redirected.map((moved) => moved.job)).toEqual(jobs);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(slow.sessions).toHaveLength(1);
      expect(await bridge.agents({ statuses: ['starting'] })).toHaveLength(3);

      await bridge.cancel(claude.name, jobs[1]);
      releases[0]({ sessionId: 'claude-a' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(slow.sessions.map((session) => session.job.number)).toEqual([jobs[0], jobs[2]]);
    } finally {
      for (const release of releases) release({ sessionId: `claude-${releases.indexOf(release)}` });
      await new Promise((resolve) => setTimeout(resolve, 20));
      for (const release of releases) release({ sessionId: `claude-${releases.indexOf(release)}` });
      await bridge.idle();
    }
    expect((await bridge.agents({ statuses: ['starting'] })).length).toBe(0);
  });

  it('go back to a harness whose own limit is over, before any job fails', async () => {
    const { bridge, claude, codex, clock } = await open({
      adapters: [starts('claude-code'), starts('codex'), starts('qwen')],
      routing: { fallback: ['qwen'] },
    });
    const { job } = await bridge.createJob(claude.name, { to: codex.name, body: 'Fix it' });
    await bridge.inbox(codex.name);
    clock.advance(3_600_000);
    await bridge.limited(codex.name, { until: iso(T0 + 2 * 3_600_000) });
    await bridge.idle();
    const first = await bridge.job(job.number);
    expect(first.to).toBe('claude-2@demo');
    expect(Date.parse(first.deadlineAt)).toBe(T0 + 5 * 3_600_000);

    clock.advance(2 * 3_600_000);
    await bridge.sweep();
    const second = await bridge.limited('claude-2@demo');
    await bridge.idle();
    expect(second.failed).toEqual([]);
    expect(second.redirected).toEqual([{ job: job.number, to: 'codex-2@demo' }]);
  });

  it('take a session that waits for its mail itself out of the book until it calls again', async () => {
    const waits: BridgeAdapter = {
      harness: 'claude-code',
      delivery: 'wait',
      capabilities: { createSession: true, push: false, steer: false, nativeWindow: true },
      createSession: async (request) => ({
        sessionId: `${request.harness}-started-${(started += 1)}`,
      }),
    };
    const { bridge, claude, codex } = await open({ adapters: [waits, starts('codex')] });
    const { job } = await bridge.createJob(codex.name, { to: claude.name, body: 'Review it' });
    await bridge.inbox(claude.name);

    const { redirected } = await bridge.limited(claude.name, { detail: 'Rate limit reached' });
    await bridge.idle();
    expect(redirected).toEqual([{ job: job.number, to: 'codex-2@demo' }]);
    expect((await bridge.agents({ statuses: ['gone'] })).map((agent) => agent.name)).toEqual([
      claude.name,
    ]);
    const gone = (await bridge.readJournal()).find((entry) => entry.type === 'agent.gone');
    expect(gone?.data?.error).toContain('nothing wakes the session until it is opened again');
    await expect(
      bridge.createJob(codex.name, { to: claude.name, body: 'Are you there' })
    ).rejects.toMatchObject(code('unknown_agent'));

    const mail = (await bridge.inbox(claude.name)).map((letter) => letter.body);
    expect(mail.join('\n')).toContain(`Job #${job.number} is no longer yours`);
    expect((await bridge.agents({ statuses: ['active'] })).map((agent) => agent.name)).toContain(
      claude.name
    );
  });

  it('are handed on when the session of a job could not start for the limit', async () => {
    const limited = new FakeAdapter({
      harness: 'claude-code',
      createSession: async () => {
        throw new Error('claude --bg failed: You have hit your usage limit · resets 3:45pm');
      },
    });
    const { bridge, codex } = await open({ adapters: [limited, starts('codex')] });
    const { job } = await bridge.createJob(codex.name, { to: 'claude:new', body: 'Review it' });
    await bridge.idle();

    const now = await bridge.job(job.number);
    expect(now.to).toBe('codex-2@demo');
    expect(now.state).not.toBe('failed');
    expect(now.redirects?.[0]).toMatchObject({ from: 'claude-2@demo', to: 'codex-2@demo' });
    const first = (await bridge.agents({ statuses: ['gone'] })).map((agent) => agent.name);
    expect(first).toEqual(['claude-2@demo']);
    expect((await bridge.status()).limited).toMatchObject([
      { harness: 'claude-code', detail: expect.stringContaining('hit your usage limit') },
    ]);
  });
});
