import { afterEach, describe, expect, it } from 'vitest';
import type {
  PersonLetter,
  PersonNotice,
  PersonRequest,
  PersonRoute,
  RightsJudge,
  RightsQuestion,
} from '../person';
import {
  BRIDGE_SENDER,
  DEFAULT_LIMITS,
  PERSON,
  type PermissionAsk,
  type RenderedLetter,
  type Rights,
} from '../types';
import { FakeAdapter, makeKit, type Kit } from './bridge-kit';

let kit: Kit;

afterEach(async () => {
  await kit.close();
});

const code = (value: string) => expect.objectContaining({ code: value });

const PUSH: PermissionAsk = {
  tool: 'Bash',
  access: 'command',
  command: 'git push origin main',
  cwd: '/work/demo',
};

/** A route to the person that remembers what it was told. */
class FakeRoute implements PersonRoute {
  readonly asked: PersonRequest[] = [];
  readonly settled: RenderedLetter[] = [];
  ask(request: PersonRequest): void {
    this.asked.push(request);
  }
  settle({ letter }: PersonLetter): void {
    this.settled.push(letter);
  }
}

/** A judge that says the same of every call and remembers what it was asked. */
function judge(rights: Rights): RightsJudge & { asked: RightsQuestion[] } {
  const asked: RightsQuestion[] = [];
  return Object.assign(
    (question: RightsQuestion) => {
      asked.push(question);
      return rights;
    },
    { asked }
  );
}

/** A job Claude handed to Codex, taken, and the request Codex sends for leave to push. */
async function asking(options: Parameters<typeof makeKit>[0] = {}) {
  kit = await makeKit(options);
  const { bridge, claude, codex } = kit;
  const { job } = await bridge.createJob(claude.name, { to: 'codex', body: 'Ship the fix' });
  await bridge.inbox(codex.name);
  const ask = (body = 'Run `git push origin main` in /work/demo') =>
    bridge.send(codex.name, { job: job.number, kind: 'permission', body, ask: PUSH });
  return { bridge, claude, codex, job, ask };
}

describe('a call an agent asks leave for', () => {
  it('is for the one who handed the job over to answer when its own rules allow the call', async () => {
    const rights = judge('allow');
    const { bridge, claude, codex, job, ask } = await asking({ rights });

    const sent = await ask();

    expect(sent.letter).toMatchObject({ kind: 'permission', to: claude.name, ask: PUSH });
    expect(sent.letter.needsPerson).toBeUndefined();
    expect(sent.job.state).toBe('input-required');
    expect(rights.asked).toEqual([
      { job: expect.objectContaining({ number: job.number }), delegator: claude, ask: PUSH },
    ]);
    expect(await bridge.verdict(codex.name, { letter: sent.letter.id, timeoutMs: 0 })).toEqual({
      state: 'waiting',
    });
    const [shown] = await bridge.inbox(claude.name);
    expect(shown.text.split('\n').slice(1)).toEqual([
      'Run `git push origin main` in /work/demo',
      '[agent bridge] Yours to decide: answer with the decision allow or deny, or pass it to the person.',
    ]);

    const answered = await bridge.send(claude.name, {
      job: job.number,
      kind: 'answer',
      body: 'The branch is reviewed',
      verdict: 'allow',
    });

    expect(answered.letter).toMatchObject({
      inReplyTo: sent.letter.id,
      verdict: 'allow',
      state: 'handled',
    });
    expect(answered.job.state).toBe('working');
    expect(await bridge.verdict(codex.name, { letter: sent.letter.id })).toEqual({
      state: 'decided',
      verdict: 'allow',
      reason: 'The branch is reviewed',
      by: claude.name,
    });
    expect(await bridge.inbox(codex.name)).toEqual([]);
  });

  it('is refused at once when the rules of the one who handed the job over forbid it', async () => {
    const { bridge, claude, codex, ask } = await asking({ rights: judge('deny') });

    const sent = await ask();

    expect(sent.letter.state).toBe('handled');
    expect(sent.job.state).toBe('working');
    expect(await bridge.verdict(codex.name, { letter: sent.letter.id })).toEqual({
      state: 'decided',
      verdict: 'deny',
      reason: `The rules of ${claude.name} forbid this, so it is refused`,
      by: BRIDGE_SENDER,
    });
    expect(await bridge.inbox(claude.name)).toEqual([]);
    expect(await bridge.inbox(codex.name)).toEqual([]);
  });

  it('waits for the person when the rules leave it to them, and the agent can only refuse', async () => {
    const person = new FakeRoute();
    const { bridge, claude, codex, job, ask } = await asking({ rights: judge('ask'), person });

    const sent = await ask();
    await bridge.idle();

    expect(sent.letter).toMatchObject({ to: claude.name, needsPerson: true });
    expect(sent.job.state).toBe('input-required');
    expect(person.asked).toEqual([
      {
        letter: expect.objectContaining({ id: sent.letter.id, ask: PUSH }),
        job: expect.objectContaining({ number: job.number }),
        again: false,
      },
    ]);
    const [shown] = await bridge.inbox(claude.name);
    expect(shown.text.split('\n').at(-1)).toBe(
      "[agent bridge] This is the person's to allow: your own rules would have you ask them too, and they were asked. You may refuse it: answer with the decision deny."
    );
    await expect(
      bridge.send(claude.name, { job: job.number, kind: 'answer', body: 'Go on', verdict: 'allow' })
    ).rejects.toThrow(code('needs_person'));
    expect(await bridge.verdict(codex.name, { letter: sent.letter.id, timeoutMs: 0 })).toEqual({
      state: 'waiting',
    });

    const answered = await bridge.personAnswer({ letter: sent.letter.id, verdict: 'allow' });
    await bridge.idle();

    expect(answered.letter).toMatchObject({
      from: PERSON,
      to: codex.name,
      verdict: 'allow',
      state: 'handled',
    });
    expect(answered.job.state).toBe('working');
    expect(await bridge.verdict(codex.name, { letter: sent.letter.id })).toEqual({
      state: 'decided',
      verdict: 'allow',
      reason: 'Allowed by the person',
      by: PERSON,
    });
    expect(person.settled.map((letter) => letter.id)).toEqual([sent.letter.id]);
    expect(await bridge.forPerson()).toEqual([]);
  });

  it('can be refused by the agent while it waits for the person', async () => {
    const person = new FakeRoute();
    const { bridge, claude, codex, job, ask } = await asking({ rights: judge('ask'), person });
    const sent = await ask();

    await bridge.send(claude.name, {
      job: job.number,
      kind: 'answer',
      body: 'Not on a Friday',
      verdict: 'deny',
    });
    await bridge.idle();

    expect(await bridge.verdict(codex.name, { letter: sent.letter.id })).toMatchObject({
      verdict: 'deny',
      reason: 'Not on a Friday',
      by: claude.name,
    });
    expect(person.settled.map((letter) => letter.id)).toEqual([sent.letter.id]);
    await expect(bridge.personAnswer({ letter: sent.letter.id, verdict: 'allow' })).rejects.toThrow(
      code('invalid_letter')
    );
  });

  it('is refused when only the person could allow it and nothing reaches them', async () => {
    const { bridge, codex, ask } = await asking({ rights: judge('ask') });

    const sent = await ask();

    expect(sent.job.state).toBe('working');
    expect(await bridge.verdict(codex.name, { letter: sent.letter.id })).toEqual({
      state: 'decided',
      verdict: 'deny',
      reason:
        'Only the person can allow this, and this bridge has no way to reach them, so it is refused',
      by: BRIDGE_SENDER,
    });
  });

  it('is left to the person without a judge, and when the judge throws', async () => {
    const person = new FakeRoute();
    const { ask } = await asking({ person });
    expect((await ask()).letter.needsPerson).toBe(true);
    await kit.close();

    const failing = await asking({
      person,
      rights: () => {
        throw new Error('cannot read the settings');
      },
    });
    expect((await failing.ask()).letter.needsPerson).toBe(true);
    expect(kit.errors.map((error) => error.message)).toEqual(['cannot read the settings']);
  });

  it('is bound by every agent up the chain of jobs it comes from', async () => {
    const person = new FakeRoute();
    const said: Record<string, Rights> = {};
    kit = await makeKit({
      person,
      rights: ({ job }) => said[job.from] ?? 'allow',
    });
    const { bridge, claude, codex } = kit;
    const gemini = await bridge.register({
      harness: 'gemini',
      sessionId: 'g1',
      cwd: '/work/demo',
      project: '/work/demo',
    });
    const outer = await bridge.createJob(claude.name, { to: 'codex', body: 'Ship the fix' });
    await bridge.inbox(codex.name);
    const inner = await bridge.createJob(codex.name, {
      to: 'gemini',
      body: 'Push the branch',
      parent: outer.job.number,
    });
    await bridge.inbox(gemini.name);
    const ask = (body: string) =>
      bridge.send(gemini.name, { job: inner.job.number, kind: 'permission', body, ask: PUSH });

    const first = await ask('First');
    expect(first.letter).toMatchObject({ to: codex.name });
    expect(first.letter.needsPerson).toBeUndefined();

    said[claude.name] = 'ask';
    expect((await ask('Second')).letter).toMatchObject({ to: codex.name, needsPerson: true });

    said[claude.name] = 'deny';
    const refused = await ask('Third');
    expect(await bridge.verdict(gemini.name, { letter: refused.letter.id })).toMatchObject({
      verdict: 'deny',
      by: BRIDGE_SENDER,
    });
  });

  it('takes a decision and not just words, and only from the one it is for', async () => {
    const { bridge, claude, codex, job, ask } = await asking({ rights: judge('allow') });
    const sent = await ask();

    await expect(
      bridge.send(claude.name, { job: job.number, kind: 'answer', body: 'Fine by me' })
    ).rejects.toThrow(/takes a decision: allow or deny/);
    await expect(
      bridge.verdict(claude.name, { letter: sent.letter.id, timeoutMs: 0 })
    ).rejects.toThrow(code('unknown_letter'));
    await expect(
      bridge.send(claude.name, { job: job.number, kind: 'permission', body: 'May I?', ask: PUSH })
    ).rejects.toThrow(/Only codex@demo, who carries job 1 out, asks leave for a call/);
    await expect(
      bridge.send(codex.name, { job: job.number, kind: 'question', body: 'May I?', ask: PUSH })
    ).rejects.toThrow(code('invalid_input'));
    await expect(
      bridge.send(codex.name, { job: job.number, kind: 'note', body: 'Yes', verdict: 'allow' })
    ).rejects.toThrow(code('invalid_input'));
  });

  it('does not put a decision on a question', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    const { job } = await bridge.createJob(claude.name, { to: 'codex', body: 'Ship the fix' });
    await bridge.send(codex.name, { job: job.number, kind: 'question', body: 'Mock Redis?' });

    await expect(
      bridge.send(claude.name, { job: job.number, kind: 'answer', body: 'Yes', verdict: 'allow' })
    ).rejects.toThrow(/takes an answer in words, not a decision/);
  });

  it('may be asked for again once it was allowed, and not once it was refused', async () => {
    const { bridge, claude, job, ask } = await asking({ rights: judge('allow') });
    const decide = (verdict: 'allow' | 'deny', body: string) =>
      bridge.send(claude.name, { job: job.number, kind: 'answer', body, verdict });

    await ask();
    await decide('allow', 'Go on');
    const second = await ask();
    expect(second.duplicate).toBe(false);
    await decide('deny', 'Enough for today');

    await expect(ask()).rejects.toThrow(code('loop_detected'));
  });

  it('tells a waiting agent the decision the moment it comes, and says so when none came', async () => {
    const { bridge, claude, codex, job, ask } = await asking({ rights: judge('allow') });
    const sent = await ask();

    expect(await bridge.verdict(codex.name, { letter: sent.letter.id, timeoutMs: 20 })).toEqual({
      state: 'waiting',
    });
    const waiting = bridge.verdict(codex.name, { letter: sent.letter.id, timeoutMs: 60_000 });
    await bridge.send(claude.name, {
      job: job.number,
      kind: 'answer',
      body: 'No',
      verdict: 'deny',
    });

    expect(await waiting).toMatchObject({ state: 'decided', verdict: 'deny', by: claude.name });
  });

  it('stops waiting when the connection of the one who waits closes', async () => {
    const { bridge, codex, ask } = await asking({ rights: judge('allow') });
    const sent = await ask();
    const gone = new AbortController();

    const waiting = bridge.verdict(
      codex.name,
      { letter: sent.letter.id, timeoutMs: 60_000 },
      gone.signal
    );
    gone.abort();

    expect(await waiting).toEqual({ state: 'waiting' });
  });

  it('counts as refused when its job ends before anybody answered', async () => {
    const person = new FakeRoute();
    const { bridge, claude, codex, job, ask } = await asking({ rights: judge('ask'), person });
    const sent = await ask();
    const waiting = bridge.verdict(codex.name, { letter: sent.letter.id, timeoutMs: 60_000 });

    await bridge.cancel(claude.name, job.number, 'Changed my mind');
    await bridge.idle();

    expect(await waiting).toEqual({
      state: 'decided',
      verdict: 'deny',
      reason: `Nobody answered before job #1 was canceled (canceled by ${claude.name}: Changed my mind)`,
      by: BRIDGE_SENDER,
    });
    expect(person.settled.map((letter) => letter.id)).toEqual([sent.letter.id]);
  });
});

describe('a letter passed on to the person', () => {
  /** A question Codex asked on a job Claude handed over. */
  async function questioned(options: Parameters<typeof makeKit>[0] = {}) {
    kit = await makeKit(options);
    const { bridge, claude, codex } = kit;
    const { job } = await bridge.createJob(claude.name, { to: 'codex', body: 'Ship the fix' });
    const { letter } = await bridge.send(codex.name, {
      job: job.number,
      kind: 'question',
      body: 'Which release does this go into?',
    });
    return { bridge, claude, codex, job, letter };
  }

  it('gets its answer from them, in their words, sent to the one who asked', async () => {
    const person = new FakeRoute();
    const { bridge, claude, codex, letter } = await questioned({ person });

    const passed = await bridge.escalate(claude.name, { letter: letter.id });
    await bridge.idle();

    expect(passed.needsPerson).toBe(true);
    expect(person.asked.map((request) => [request.letter.id, request.again])).toEqual([
      [letter.id, false],
    ]);
    expect(person.asked[0].letter.text.split('\n').at(-1)).toBe(
      `[agent bridge] The person was asked. Their answer goes to ${codex.name}.`
    );
    expect((await bridge.forPerson()).map((waiting) => waiting.letter.id)).toEqual([letter.id]);

    const answered = await bridge.personAnswer({ letter: letter.id, body: 'The one in March' });
    await bridge.idle();

    expect(answered.job.state).toBe('working');
    const [got] = await bridge.inbox(codex.name);
    expect(got).toMatchObject({
      kind: 'answer',
      from: PERSON,
      body: 'The one in March',
      inReplyTo: letter.id,
    });
    expect(got.text.split('\n')[0]).toContain(`answer from ${PERSON} to ${codex.name}`);
    expect(person.settled.map((settled) => settled.id)).toEqual([letter.id]);
  });

  it('changes nothing the second time, and can still be answered by the agent', async () => {
    const person = new FakeRoute();
    const { bridge, claude, job, letter } = await questioned({ person });

    await bridge.escalate(claude.name, { letter: letter.id });
    await bridge.escalate(claude.name, { letter: letter.id });
    await bridge.send(claude.name, { job: job.number, kind: 'answer', body: 'Found it: March' });
    await bridge.idle();

    expect(person.asked).toHaveLength(1);
    expect(person.settled.map((settled) => settled.id)).toEqual([letter.id]);
    expect(await bridge.forPerson()).toEqual([]);
  });

  it("is refused for a letter that takes no answer, is not the caller's, or when nothing reaches the person", async () => {
    const person = new FakeRoute();
    const { bridge, claude, codex, job, letter } = await questioned({ person });
    const { letter: note } = await bridge.send(codex.name, {
      job: job.number,
      kind: 'note',
      body: 'Half done',
    });

    await expect(bridge.escalate(codex.name, { letter: letter.id })).rejects.toThrow(
      code('unknown_letter')
    );
    await expect(bridge.escalate(claude.name, { letter: note.id })).rejects.toThrow(
      code('invalid_letter')
    );
    await kit.close();

    const alone = await questioned();
    await expect(
      alone.bridge.escalate(alone.claude.name, { letter: alone.letter.id })
    ).rejects.toThrow(code('no_person'));
  });

  it('takes words for a question and a decision for a call, never the other', async () => {
    const person = new FakeRoute();
    const { bridge, claude, letter } = await questioned({ person });

    await expect(bridge.personAnswer({ letter: letter.id, body: 'March' })).rejects.toThrow(
      code('unknown_letter')
    );
    await bridge.escalate(claude.name, { letter: letter.id });
    await expect(bridge.personAnswer({ letter: letter.id, verdict: 'allow' })).rejects.toThrow(
      /takes an answer in words/
    );
    await expect(bridge.personAnswer({ letter: letter.id })).rejects.toThrow(
      /takes an answer in words/
    );
    await kit.close();

    const call = await asking({ person });
    const sent = await call.ask();
    await expect(
      call.bridge.personAnswer({ letter: sent.letter.id, body: 'Sure' })
    ).rejects.toThrow(/takes a decision: allow or deny/);
  });

  it('reminds the person once, then fails the job', async () => {
    const person = new FakeRoute();
    const { bridge, claude, letter } = await questioned({ person });
    const patience = DEFAULT_LIMITS.personReplyTimeoutMs;
    await bridge.escalate(claude.name, { letter: letter.id });

    kit.clock.advance(DEFAULT_LIMITS.budget.replyTimeoutMs + 1);
    expect(await bridge.sweep()).toEqual({ failed: [], reminded: [] });
    kit.clock.advance(patience);
    const reminded = await bridge.sweep();
    await bridge.idle();

    expect(reminded).toEqual({ failed: [], reminded: [letter.id] });
    expect(person.asked.map((request) => request.again)).toEqual([false, true]);
    expect(await bridge.inbox(claude.name, { peek: true })).toHaveLength(1);

    kit.clock.advance(patience + 1);
    const failed = await bridge.sweep();
    await bridge.idle();

    expect(failed.failed).toEqual([1]);
    expect(await bridge.job(1)).toMatchObject({
      state: 'failed',
      reason: `the person did not answer the question ${letter.id} in 8 h`,
    });
    expect(person.settled.map((settled) => settled.id)).toEqual([letter.id]);
  });

  it('does not spend the time of the job while it waits for the person', async () => {
    const person = new FakeRoute();
    const { bridge, claude, job, letter } = await questioned({ person });
    const hour = 3_600_000;
    kit.clock.advance(hour);
    await bridge.escalate(claude.name, { letter: letter.id });

    kit.clock.advance(5 * hour);
    const swept = await bridge.sweep();

    expect(job.budget.durationMs).toBe(4 * hour);
    expect(swept).toEqual({ failed: [], reminded: [letter.id] });

    const answered = await bridge.personAnswer({ letter: letter.id, body: 'March' });

    expect(answered.job.state).toBe('working');
    expect(Date.parse(answered.job.deadlineAt) - Date.parse(job.deadlineAt)).toBe(5 * hour);
    kit.clock.advance(3 * hour + 1);
    expect((await bridge.sweep()).failed).toEqual([job.number]);
    expect((await bridge.job(job.number)).reason).toBe('it ran longer than its 4 h budget');
  });

  it('still counts the letters of a job whose clock is held', async () => {
    const person = new FakeRoute();
    kit = await makeKit({ person });
    const { bridge, claude, codex } = kit;
    const { job } = await bridge.createJob(claude.name, {
      to: 'codex',
      body: 'Ship the fix',
      budget: { letters: 4 },
    });
    const { letter } = await bridge.send(codex.name, {
      job: job.number,
      kind: 'question',
      body: 'Which release?',
    });
    await bridge.escalate(claude.name, { letter: letter.id });
    kit.clock.advance(5 * 3_600_000);
    const note = (body: string) => bridge.send(codex.name, { job: job.number, kind: 'note', body });

    await note('Still waiting');
    await note('And still');

    await expect(note('One more')).rejects.toThrow(code('budget_exhausted'));
    expect(await bridge.job(job.number)).toMatchObject({
      state: 'failed',
      reason: 'the job used all 4 letters of its budget',
    });
  });

  it('counts the time two letters waited together once', async () => {
    const person = new FakeRoute();
    const { bridge, claude, codex, job, letter } = await questioned({ person });
    const hour = 3_600_000;
    await bridge.escalate(claude.name, { letter: letter.id });
    kit.clock.advance(hour);
    const second = await bridge.send(codex.name, {
      job: job.number,
      kind: 'permission',
      body: 'Run `git push origin main`',
      ask: PUSH,
    });
    const deadline = async () => Date.parse((await bridge.job(job.number)).deadlineAt);
    const before = await deadline();

    kit.clock.advance(hour);
    await bridge.personAnswer({ letter: letter.id, body: 'March' });
    expect((await deadline()) - before).toBe(2 * hour);
    expect((await bridge.job(job.number)).state).toBe('input-required');

    kit.clock.advance(hour);
    const answered = await bridge.personAnswer({ letter: second.letter.id, verdict: 'allow' });

    expect((await deadline()) - before).toBe(3 * hour);
    expect(answered.job.state).toBe('working');
    expect(answered.job.personWaitSince).toBeUndefined();
  });

  it('gives no time back when an agent takes the letter back from the person', async () => {
    const person = new FakeRoute();
    const { bridge, claude, job, letter } = await questioned({ person });
    const hour = 3_600_000;
    await bridge.escalate(claude.name, { letter: letter.id });

    kit.clock.advance(5 * hour);
    expect((await bridge.sweep()).failed).toEqual([]);
    const answered = await bridge.send(claude.name, {
      job: job.number,
      kind: 'answer',
      body: 'Found it myself: March',
    });

    expect(answered.job.deadlineAt).toBe(job.deadlineAt);
    expect(answered.job.personWaitSince).toBeUndefined();
    expect((await bridge.sweep()).failed).toEqual([job.number]);
  });

  it('holds the clock of every job a waiting job is part of, and gives each its time back', async () => {
    const person = new FakeRoute();
    kit = await makeKit({ person });
    const { bridge, claude, codex } = kit;
    const gemini = await bridge.register({
      harness: 'gemini',
      sessionId: 'g1',
      cwd: '/work/demo',
      project: '/work/demo',
    });
    const hour = 3_600_000;
    const outer = await bridge.createJob(claude.name, { to: 'codex', body: 'Ship the fix' });
    await bridge.inbox(codex.name);
    const inner = await bridge.createJob(codex.name, {
      to: 'gemini',
      body: 'Push the branch',
      parent: outer.job.number,
    });
    await bridge.inbox(gemini.name);
    const { letter } = await bridge.send(gemini.name, {
      job: inner.job.number,
      kind: 'permission',
      body: 'Run `git push origin main`',
      ask: PUSH,
    });

    kit.clock.advance(6 * hour);
    expect((await bridge.sweep()).failed).toEqual([]);
    expect((await bridge.job(outer.job.number)).personWaitSince).toBeDefined();
    await bridge.personAnswer({ letter: letter.id, verdict: 'allow' });

    for (const before of [outer.job, inner.job]) {
      const after = await bridge.job(before.number);
      expect(Date.parse(after.deadlineAt) - Date.parse(before.deadlineAt)).toBe(6 * hour);
      expect(after.personWaitSince).toBeUndefined();
      expect(after.state).not.toBe('failed');
    }
    expect((await bridge.sweep()).failed).toEqual([]);
  });

  it('does not wait forever for a route that hangs: what comes after is still told', async () => {
    const told: string[] = [];
    let hang = true;
    const person: PersonRoute = {
      ask: ({ letter }) => {
        if (hang) return new Promise<void>(() => undefined);
        told.push(letter.id);
        return undefined;
      },
      settle: () => undefined,
    };
    const { bridge, claude, codex, job, letter } = await questioned({
      person,
      limits: { deliveryTimeoutMs: 40 },
    });

    await bridge.escalate(claude.name, { letter: letter.id });
    hang = false;
    const second = await bridge.send(codex.name, {
      job: job.number,
      kind: 'permission',
      body: 'Run `git push origin main`',
      ask: PUSH,
    });
    await bridge.idle();

    expect(kit.errors.map((error) => error.message)).toEqual([
      'Telling the person of a letter took longer than 40 ms',
    ]);
    expect(told).toEqual([second.letter.id]);
  });

  it('survives a route that throws: the letter still waits in the bridge', async () => {
    const person: PersonRoute = {
      ask: () => {
        throw new Error('the chat is down');
      },
      settle: () => undefined,
    };
    const { bridge, claude, letter } = await questioned({ person });

    await bridge.escalate(claude.name, { letter: letter.id });
    await bridge.idle();

    expect(kit.errors.map((error) => error.message)).toEqual(['the chat is down']);
    expect((await bridge.forPerson()).map((waiting) => waiting.letter.id)).toEqual([letter.id]);
  });
});

describe('a request for leave its sender waits on no more', () => {
  it('is taken back: nobody is asked any more, a late answer is refused and the job works again', async () => {
    const person = new FakeRoute();
    const { bridge, claude, codex, job, ask } = await asking({ person, rights: judge('ask') });
    const sent = await ask();
    await bridge.idle();
    expect(person.asked.map((request) => request.letter.id)).toEqual([sent.letter.id]);

    expect(await bridge.withdraw(codex.name, { letter: sent.letter.id })).toEqual({
      state: 'withdrawn',
    });
    await bridge.idle();

    expect(person.settled.map((letter) => letter.id)).toEqual([sent.letter.id]);
    expect(await bridge.forPerson()).toEqual([]);
    const after = await bridge.job(job.number);
    expect(after.state).toBe('working');
    expect(after.personWaitSince).toBeUndefined();
    expect(await bridge.verdict(codex.name, { letter: sent.letter.id, timeoutMs: 0 })).toEqual({
      state: 'decided',
      verdict: 'deny',
      reason: `${codex.name} waits for this decision no more`,
      by: BRIDGE_SENDER,
    });
    await expect(bridge.personAnswer({ letter: sent.letter.id, verdict: 'allow' })).rejects.toThrow(
      expect.objectContaining({
        code: 'invalid_letter',
        message: `The permission ${sent.letter.id} waits no more: ${codex.name} waits for this decision no more`,
      })
    );
    expect(await bridge.stuck(codex.name, { what: 'A dialog' })).toEqual([job.number]);
    expect(await bridge.withdraw(codex.name, { letter: sent.letter.id })).toMatchObject({
      state: 'decided',
      verdict: 'deny',
    });
    await expect(bridge.withdraw(claude.name, { letter: sent.letter.id })).rejects.toThrow(
      code('unknown_letter')
    );
  });

  it('keeps the decision that was made before its sender gave up', async () => {
    const { bridge, claude, codex, job, ask } = await asking({ rights: judge('allow') });
    const sent = await ask();
    await bridge.send(claude.name, {
      job: job.number,
      kind: 'answer',
      body: 'The branch is reviewed',
      verdict: 'allow',
    });

    expect(await bridge.withdraw(codex.name, { letter: sent.letter.id })).toEqual({
      state: 'decided',
      verdict: 'allow',
      reason: 'The branch is reviewed',
      by: claude.name,
    });
  });

  it('is gone from the mail of the agent that was to decide it', async () => {
    const { bridge, claude, codex, job, ask } = await asking({ rights: judge('allow') });
    const sent = await ask();

    await bridge.withdraw(codex.name, { letter: sent.letter.id });

    expect(await bridge.inbox(claude.name)).toEqual([]);
    await expect(
      bridge.send(claude.name, { job: job.number, kind: 'answer', body: 'Go', verdict: 'allow' })
    ).rejects.toThrow(code('invalid_letter'));
    expect((await bridge.job(job.number)).state).toBe('working');
  });
});

describe('an agent that waits for a person at its own window', () => {
  /** A route that also takes notices. */
  class NoticedRoute extends FakeRoute {
    readonly told: PersonNotice[] = [];
    tell(notice: PersonNotice): void {
      this.told.push(notice);
    }
  }

  it('is said so to whoever handed it a job, and to the person, once in a while', async () => {
    const person = new NoticedRoute();
    kit = await makeKit({ person });
    const { bridge, claude, codex } = kit;
    const { job } = await bridge.createJob(claude.name, { to: 'codex', body: 'Ship the fix' });
    await bridge.inbox(codex.name);
    await bridge.inbox(claude.name);

    const told = await bridge.stuck(codex.name, { what: 'Codex wants to run git push' });
    const again = await bridge.stuck(codex.name, { what: 'Codex wants to run git push' });
    await bridge.idle();

    expect(told).toEqual([job.number]);
    expect(again).toEqual([]);
    const notes = await bridge.inbox(claude.name);
    expect(notes.map((note) => [note.kind, note.from])).toEqual([['note', BRIDGE_SENDER]]);
    expect(notes[0].body.split('\n')).toEqual([
      `${codex.name} waits for a person at its own window, and job #1 stands still until they answer there. It shows:`,
      '> Codex wants to run git push',
      'Nobody can answer that from here. If the user is with you, tell them in one line.',
    ]);
    expect(person.told).toEqual([
      {
        agent: codex.name,
        jobs: [expect.objectContaining({ number: job.number })],
        text: `${codex.name} waits for you at its own window: Codex wants to run git push`,
      },
    ]);
    expect((await bridge.job(job.number)).state).toBe('working');

    kit.clock.advance(DEFAULT_LIMITS.windowNoticeMs + 1);
    expect(await bridge.stuck(codex.name, { what: 'Still there' })).toEqual([job.number]);
  });

  it("is nobody's news when it carries out no job", async () => {
    const person = new NoticedRoute();
    kit = await makeKit({ person });
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Ship the fix' });

    expect(await bridge.stuck(claude.name, { what: 'A dialog' })).toEqual([]);
    await bridge.cancel(claude.name, 1);
    expect(await bridge.stuck(codex.name, { what: 'A dialog' })).toEqual([]);
    await bridge.idle();

    expect(person.told).toEqual([]);
    await expect(bridge.stuck(codex.name, { what: '   ' })).rejects.toThrow(code('invalid_input'));
  });

  it('is noticed in what its harness lists, without any hook', async () => {
    const person = new NoticedRoute();
    const waitingFor: { value?: string } = {};
    kit = await makeKit({
      person,
      adapters: [
        new FakeAdapter({
          harness: 'codex',
          liveSessions: async () => [
            {
              sessionId: 'thread-codex',
              ...(waitingFor.value && { waitingFor: waitingFor.value }),
            },
          ],
        }),
      ],
    });
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Ship the fix' });
    await bridge.inbox(codex.name);
    await bridge.inbox(claude.name);

    await bridge.sweep();
    await bridge.idle();
    expect(await bridge.inbox(claude.name)).toEqual([]);

    waitingFor.value = 'permission prompt';
    kit.clock.advance(DEFAULT_LIMITS.presenceCheckMs + 1);
    await bridge.sweep();
    await bridge.idle();

    const [note] = await bridge.inbox(claude.name);
    expect(note.body).toContain('> It waits for: permission prompt');
    expect(person.told.map((notice) => notice.text)).toEqual([
      `${codex.name} waits for you at its own window: It waits for: permission prompt`,
    ]);
  });

  it('is no news while the call it holds waits for a verdict through the bridge', async () => {
    const person = new NoticedRoute();
    const waitingFor: { value?: string } = {};
    const { bridge, claude, codex, job, ask } = await asking({
      person,
      rights: judge('ask'),
      adapters: [
        new FakeAdapter({
          harness: 'codex',
          liveSessions: async () => [
            {
              sessionId: 'thread-codex',
              ...(waitingFor.value && { waitingFor: waitingFor.value }),
            },
          ],
        }),
      ],
    });
    await bridge.inbox(claude.name);
    await bridge.sweep();
    const sent = await ask();
    await bridge.inbox(claude.name);

    waitingFor.value = 'permission prompt';
    kit.clock.advance(DEFAULT_LIMITS.presenceCheckMs + 1);
    await bridge.sweep();
    await bridge.idle();

    expect(await bridge.stuck(codex.name, { what: 'Claude needs your permission' })).toEqual([]);
    await bridge.idle();
    expect(await bridge.inbox(claude.name)).toEqual([]);
    expect(person.told).toEqual([]);

    await bridge.personAnswer({ letter: sent.letter.id, verdict: 'allow', body: 'Go on' });
    expect(await bridge.stuck(codex.name, { what: 'Claude needs your permission' })).toEqual([
      job.number,
    ]);
    await bridge.idle();
    expect(person.told.map((notice) => notice.text)).toEqual([
      `${codex.name} waits for you at its own window: Claude needs your permission`,
    ]);
  });

  it('is still news when the request it sent holds no call', async () => {
    const person = new NoticedRoute();
    kit = await makeKit({ person });
    const { bridge, claude, codex } = kit;
    const { job } = await bridge.createJob(claude.name, { to: 'codex', body: 'Ship the fix' });
    await bridge.inbox(codex.name);
    await bridge.send(codex.name, {
      job: job.number,
      kind: 'permission',
      body: 'May I push when the tests pass?',
    });

    expect(await bridge.stuck(codex.name, { what: 'A dialog' })).toEqual([job.number]);
  });
});
