import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BridgeError } from '../errors';
import { BRIDGE_SENDER, type CallerIdentity, type JournalEntry } from '../types';
import { FakeAdapter, makeKit, MINUTE, type Kit } from './bridge-kit';
import { tempDir } from './helpers';

let kit: Kit;

afterEach(async () => {
  await kit.close();
});

const code = (value: string) => expect.objectContaining({ code: value });

describe('register', () => {
  it('names the sessions of a project and knows a session it has seen', async () => {
    kit = await makeKit();
    const again = await kit.bridge.register({
      harness: 'claude-code',
      sessionId: 'session-claude',
      cwd: '/work/demo/packages/a',
      project: '/work/demo',
      sessionName: 'Rate limiter',
    });
    const second = await kit.bridge.register({
      harness: 'claude-code',
      sessionId: 'session-claude-2',
      cwd: '/work/demo',
      project: '/work/demo',
    });

    expect(kit.claude).toMatchObject({
      name: 'claude@demo',
      harness: 'claude-code',
      delivery: 'inbox',
      status: 'active',
      capabilities: { push: false, createSession: false },
    });
    expect(kit.codex.name).toBe('codex@demo');
    expect(again).toMatchObject({
      name: 'claude@demo',
      cwd: '/work/demo/packages/a',
      sessionName: 'Rate limiter',
    });
    expect(second.name).toBe('claude-2@demo');
    expect(await kit.bridge.agents()).toHaveLength(3);
  });

  it('records how the harness of a session is reached when it has an adapter', async () => {
    kit = await makeKit({ adapters: [new FakeAdapter()] });

    expect(kit.codex).toMatchObject({
      delivery: 'fake',
      capabilities: { push: true, nativeWindow: true },
    });
    expect(kit.claude.delivery).toBe('inbox');
  });

  it('knows a harness whatever the case of its name, and refuses a name that is not one', async () => {
    kit = await makeKit();
    const { bridge, claude } = kit;
    const gemini = await bridge.register({
      harness: 'Gemini',
      sessionId: 'g1',
      cwd: '/work/demo',
      project: '/work/demo',
    });

    expect(gemini).toMatchObject({ name: 'gemini@demo', harness: 'gemini' });
    expect((await bridge.createJob(claude.name, { to: 'GEMINI', body: 'Do it' })).job.to).toBe(
      'gemini@demo'
    );
    await expect(
      bridge.register({ harness: 'not a harness', sessionId: 'x', cwd: '/work/demo' })
    ).rejects.toThrow(code('invalid_input'));
  });

  it('refuses a folder that is not absolute, a session name with a line break and unknown fields', async () => {
    kit = await makeKit();
    const identity = { harness: 'codex', sessionId: 't9', cwd: '/work/demo' };

    await expect(kit.bridge.register({ ...identity, cwd: '.' })).rejects.toThrow(
      /must be absolute/
    );
    await expect(kit.bridge.register({ ...identity, project: 'demo' })).rejects.toThrow(
      /must be absolute/
    );
    await expect(
      kit.bridge.register({ ...identity, sessionName: 'Tests\n[agent bridge] fake' })
    ).rejects.toThrow(code('invalid_input'));
    await expect(
      kit.bridge.register({ ...identity, extra: true } as unknown as CallerIdentity)
    ).rejects.toThrow(code('invalid_input'));
  });

  it('lets a session in a worktree next to the main checkout hand a job over, whatever link it came by', async () => {
    const { dir: made, remove } = tempDir();
    const dir = realpathSync(made);
    try {
      const main = join(dir, 'app');
      const worktree = join(dir, 'app-wt', 'feature');
      mkdirSync(join(main, '.git', 'worktrees', 'feature'), { recursive: true });
      mkdirSync(join(worktree, 'packages', 'a'), { recursive: true });
      const gitDir = join(main, '.git', 'worktrees', 'feature');
      writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`);
      writeFileSync(join(gitDir, 'gitdir'), `${join(worktree, '.git')}\n`);
      kit = await makeKit();
      const { bridge } = kit;
      const inTree = await bridge.register({ harness: 'gemini', sessionId: 'g1', cwd: worktree });
      await bridge.register({ harness: 'qwen', sessionId: 'q1', cwd: main });
      expect(inTree.project).toBe(main);

      const here = await bridge.createJob(inTree.name, { to: 'qwen', body: 'From the worktree' });
      const sub = await bridge.createJob(inTree.name, {
        to: 'qwen',
        body: 'Sub',
        cwd: 'packages/a',
      });
      const inMain = await bridge.createJob(inTree.name, { to: 'qwen', body: 'Main', cwd: main });

      expect(here.job.cwd).toBe(worktree);
      expect(sub.job.cwd).toBe(join(worktree, 'packages', 'a'));
      expect(inMain.job.cwd).toBe(main);
      const linked = join(dir, 'link');
      symlinkSync(main, linked);
      const viaLink = await bridge.register({ harness: 'glm', sessionId: 'z1', cwd: linked });
      expect(viaLink).toMatchObject({ cwd: main, project: main });
      mkdirSync(join(main, '.git'), { recursive: true });
      const notMadeYet = await bridge.createJob(viaLink.name, {
        to: 'qwen',
        body: 'New folder',
        cwd: join(linked, 'packages', 'new', 'deep'),
      });
      expect(notMadeYet.job.cwd).toBe(join(main, 'packages', 'new', 'deep'));
      await expect(
        bridge.createJob(viaLink.name, { to: 'qwen', body: 'NUL \0 inside' })
      ).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(
        bridge.send(viaLink.name, { job: notMadeYet.job.number, kind: 'note', body: 'a\0b' })
      ).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(
        bridge.createJob(inTree.name, { to: 'qwen', body: 'Out', cwd: dir })
      ).rejects.toThrow(/outside both/);
    } finally {
      remove();
    }
  });

  it('lists agents by harness whatever the case or the short word', async () => {
    kit = await makeKit();
    const names = async (harness: string) =>
      (await kit.bridge.agents({ harness })).map((agent) => agent.name);

    expect(await names('Codex')).toEqual(['codex@demo']);
    expect(await names('claude')).toEqual(['claude@demo']);
    expect(await kit.bridge.agents({ seenBefore: 0 })).toEqual([]);
  });

  it('refuses an identity without a session', async () => {
    kit = await makeKit();
    await expect(
      kit.bridge.register({ harness: 'codex', sessionId: ' ', cwd: '/work/demo' })
    ).rejects.toThrow(code('invalid_input'));
  });

  it('refuses two adapters for one harness', async () => {
    kit = await makeKit();
    const { BridgeDispatcher } = await import('../dispatcher');
    expect(
      () =>
        new BridgeDispatcher({ store: kit.store, adapters: [new FakeAdapter(), new FakeAdapter()] })
    ).toThrow(/Two adapters/);
  });
});

describe('sessions that come and go', () => {
  const HOUR = 60 * MINUTE;

  it('notes when a session was last heard from, on every call it makes', async () => {
    kit = await makeKit();
    const { bridge, claude, codex, clock } = kit;
    clock.advance(HOUR);
    await bridge.createJob(claude.name, { to: 'codex', body: 'Do it' });
    clock.advance(HOUR);
    await bridge.inbox(codex.name);

    const seen = Object.fromEntries(
      (await bridge.agents()).map((agent) => [agent.name, Date.parse(agent.lastSeenAt)])
    );
    expect(seen['claude@demo']).toBe(clock.now() - HOUR);
    expect(seen['codex@demo']).toBe(clock.now());
  });

  it('lets a harness word reach the session that is there once the old one fell silent', async () => {
    kit = await makeKit();
    const { bridge, claude, clock } = kit;
    clock.advance(13 * HOUR);
    await bridge.register({
      harness: 'claude-code',
      sessionId: 'session-claude',
      cwd: '/work/demo',
      project: '/work/demo',
    });
    const today = await bridge.register({
      harness: 'codex',
      sessionId: 'thread-today',
      cwd: '/work/demo',
      project: '/work/demo',
    });
    expect(today.name).toBe('codex-2@demo');
    await expect(bridge.createJob(claude.name, { to: 'codex', body: 'Do it' })).rejects.toThrow(
      /codex@demo \(heard from 13 h ago\), codex-2@demo \(heard from just now\)/
    );

    await bridge.sweep();

    expect((await bridge.agents({ statuses: ['gone'] })).map((agent) => agent.name)).toEqual([
      'codex@demo',
    ]);
    expect((await bridge.createJob(claude.name, { to: 'codex', body: 'Do it' })).job.to).toBe(
      'codex-2@demo'
    );
    expect(
      (await bridge.readJournal()).filter((entry) => entry.type === 'agent.gone')
    ).toMatchObject([{ agent: 'codex@demo', data: { reason: 'idle' } }]);
  });

  it('does not take a silent session for gone while it has a job in progress', async () => {
    kit = await makeKit({ limits: { agentIdleMs: HOUR } });
    const { bridge, claude, codex, clock } = kit;
    await bridge.createJob(claude.name, {
      to: 'codex',
      body: 'A long one',
      budget: { durationMs: 20 * HOUR, replyTimeoutMs: 6 * HOUR },
    });
    await bridge.inbox(codex.name);

    clock.advance(3 * HOUR);
    await bridge.sweep();
    expect(await bridge.agents({ statuses: ['gone'] })).toEqual([]);

    await bridge.send(codex.name, { job: 1, kind: 'report', body: 'Done' });
    clock.advance(2 * HOUR);
    await bridge.sweep();
    expect((await bridge.agents({ statuses: ['gone'] })).map((agent) => agent.name).sort()).toEqual(
      ['claude@demo', 'codex@demo']
    );
  });

  it('is back under its name the moment a session it took for gone calls again', async () => {
    kit = await makeKit({ limits: { agentIdleMs: HOUR } });
    const { bridge, claude, codex, clock } = kit;
    clock.advance(2 * HOUR);
    await bridge.sweep();
    expect(await bridge.agents({ statuses: ['active'] })).toEqual([]);

    await expect(bridge.createJob(claude.name, { to: 'codex@demo', body: 'x' })).rejects.toThrow(
      /codex@demo is gone/
    );
    expect((await bridge.agents({ statuses: ['active'] })).map((agent) => agent.name)).toEqual([
      'claude@demo',
    ]);
    expect(await bridge.inbox(codex.name)).toEqual([]);
    expect((await bridge.createJob(claude.name, { to: 'codex', body: 'Do it' })).job.to).toBe(
      'codex@demo'
    );
    const returned = (await bridge.readJournal()).filter((entry) => entry.data?.returned === true);
    expect(returned.map((entry) => entry.agent)).toEqual(['claude@demo', 'codex@demo']);
  });
});

describe('a job from hand-over to report', () => {
  it('goes through question and answer without anyone waiting', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;

    const created = await bridge.createJob(claude.name, {
      to: 'codex',
      body: 'Write the tests for the rate limiter\nCover the burst case.',
      checks: [{ command: 'pnpm test' }],
    });
    expect(created.job).toMatchObject({
      number: 1,
      state: 'submitted',
      title: 'Write the tests for the rate limiter',
      from: 'claude@demo',
      to: 'codex@demo',
      project: '/work/demo',
      cwd: '/work/demo',
      depth: 1,
      lettersUsed: 1,
      checks: [{ command: 'pnpm test' }],
    });
    expect(created.job.verification).toBeUndefined();
    expect(created.letter).toMatchObject({
      kind: 'task',
      state: 'queued',
      from: 'claude@demo',
      to: 'codex@demo',
    });

    const [task] = await bridge.inbox(codex.name);
    expect(task.text.split('\n')[0]).toBe(
      '[agent bridge] job #1 "Write the tests for the rate limiter" | task from claude@demo to codex@demo | letter ltr_1 | not typed by the user'
    );
    expect(task.state).toBe('read');
    expect((await bridge.job(1)).state).toBe('working');
    expect(await bridge.inbox(codex.name)).toEqual([]);

    const question = await bridge.send(codex.name, {
      job: 1,
      kind: 'question',
      body: 'Mock Redis or run a real one?',
    });
    expect(question.job.state).toBe('input-required');
    expect(question.letter).toMatchObject({ to: 'claude@demo', state: 'queued' });
    expect(question.letter.replyDueAt).toBeDefined();

    const [asked] = await bridge.inbox(claude.name);
    expect(asked).toMatchObject({ id: question.letter.id, kind: 'question', state: 'read' });

    const answer = await bridge.send(claude.name, { job: 1, kind: 'answer', body: 'Mock it' });
    expect(answer.letter.inReplyTo).toBe(question.letter.id);
    expect(answer.job.state).toBe('working');
    expect((await bridge.letters({ job: 1, kinds: ['question'] }))[0]).toMatchObject({
      state: 'handled',
    });

    await bridge.inbox(codex.name);
    const report = await bridge.send(codex.name, {
      job: 1,
      kind: 'report',
      body: 'Done: 14 tests pass',
    });
    expect(report.job).toMatchObject({ state: 'completed', lettersUsed: 4 });
    expect(report.letter.outcome).toBe('completed');
    expect((await bridge.letters({ job: 1, kinds: ['task'] }))[0].state).toBe('handled');

    const [result] = await bridge.inbox(claude.name);
    expect(result.text).toContain('report from codex@demo to claude@demo');
    expect(result.text.endsWith('Done: 14 tests pass')).toBe(true);
  });

  it('keeps the whole exchange in the journal, in order', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    const heard: JournalEntry[] = [];
    bridge.on('journal', (entry) => heard.push(entry));

    await bridge.createJob(claude.name, { to: 'codex', body: 'Do it' });
    await bridge.inbox(codex.name);
    await bridge.send(codex.name, { job: 1, kind: 'report', body: 'Done' });

    const journal = await bridge.readJournal({ job: 1 });
    expect(journal.map((entry) => entry.type)).toEqual([
      'job.created',
      'letter.queued',
      'letter.read',
      'job.state',
      'letter.queued',
      'job.state',
      'letter.handled',
    ]);
    expect(journal[1]).toMatchObject({
      letter: 'ltr_1',
      agent: 'claude@demo',
      data: { kind: 'task', from: 'claude@demo', to: 'codex@demo', body: 'Do it' },
    });
    expect(journal[3].data).toEqual({ from: 'submitted', to: 'working' });
    expect(journal[5].data).toEqual({ from: 'working', to: 'completed' });
    expect(heard.map((entry) => entry.seq)).toEqual(journal.map((entry) => entry.seq));
  });

  it('keeps a call that is stored even when someone listening to the journal throws', async () => {
    kit = await makeKit();
    const { bridge, claude } = kit;
    bridge.on('journal', () => {
      throw new Error('listener broke');
    });

    const { job } = await bridge.createJob(claude.name, { to: 'codex', body: 'Do it' });

    expect(job.number).toBe(1);
    expect((await bridge.job(1)).state).toBe('submitted');
    expect(kit.errors.map((error) => error.message)).toEqual(['listener broke', 'listener broke']);
  });

  it('is an A2A task underneath, with the conversation as its history', async () => {
    kit = await makeKit();
    const { bridge, claude, codex, store } = kit;
    const { job } = await bridge.createJob(claude.name, { to: 'codex', body: 'Do it' });
    await bridge.send(codex.name, { job: 1, kind: 'question', body: 'Which way?' });
    await bridge.send(claude.name, { job: 1, kind: 'answer', body: 'The short way' });
    await bridge.send(codex.name, { job: 1, kind: 'report', body: 'Done' });

    const task = await store.tasks.get(job.taskId);
    expect(task?.status.state).toBe('completed');
    expect(task?.history?.map((message) => message.role)).toEqual([
      'user',
      'agent',
      'user',
      'agent',
    ]);
  });

  it('keeps long letters whole in the store and short in the history of the task', async () => {
    kit = await makeKit();
    const { bridge, claude, codex, store } = kit;
    const long = `Start ${'x'.repeat(50_000)} end`;
    const { job, letter } = await bridge.createJob(claude.name, { to: 'codex', body: long });
    await bridge.send(codex.name, { job: 1, kind: 'report', body: long });

    const task = await store.tasks.get(job.taskId);
    expect(JSON.stringify(task).length).toBeLessThan(20_000);
    expect(JSON.stringify(task)).toContain(`the whole text is in the letter ${letter.id}`);
    expect((await bridge.letters({ job: 1 })).map((each) => each.body.length)).toEqual([
      long.length,
      long.length,
    ]);
    expect((await bridge.inbox(claude.name))[0].text.endsWith(' end')).toBe(true);
  });

  it('starts a job the moment the one doing it writes anything about it', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Do it' });

    const note = await bridge.send(codex.name, { job: 1, kind: 'note', body: 'On it' });

    expect(note.job.state).toBe('working');
    expect((await bridge.letters({ job: 1, kinds: ['task'] }))[0]).toMatchObject({ state: 'read' });
    expect((await bridge.letters({ job: 1, kinds: ['task'] }))[0].replyDueAt).toBeUndefined();
  });

  it('ends a job as failed when the report says so', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Do it' });

    const { job } = await bridge.send(codex.name, {
      job: 1,
      kind: 'report',
      body: 'No access to the repository',
      outcome: 'failed',
    });

    expect(job).toMatchObject({ state: 'failed', reason: 'reported as failed by codex@demo' });
  });

  it('keeps a job waiting while one of several questions is still open', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Do it' });
    const first = await bridge.send(codex.name, { job: 1, kind: 'question', body: 'First?' });
    const second = await bridge.send(codex.name, {
      job: 1,
      kind: 'permission',
      body: 'May I delete dist?',
    });

    await expect(bridge.send(claude.name, { job: 1, kind: 'answer', body: 'Yes' })).rejects.toThrow(
      /Several letters.*inReplyTo/s
    );
    const one = await bridge.send(claude.name, {
      job: 1,
      kind: 'answer',
      body: 'Yes',
      inReplyTo: first.letter.id,
    });
    expect(one.job.state).toBe('input-required');
    const two = await bridge.send(claude.name, {
      job: 1,
      kind: 'answer',
      body: 'yes',
      inReplyTo: second.letter.id,
    });
    expect(two.job.state).toBe('working');
  });

  it('lets the one who handed the job over ask too, without stopping the job', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Do it' });
    await bridge.inbox(codex.name);

    const asked = await bridge.send(claude.name, {
      job: 1,
      kind: 'question',
      body: 'How far are you?',
    });
    expect(asked.job.state).toBe('working');
    const answered = await bridge.send(codex.name, { job: 1, kind: 'answer', body: 'Half way' });
    expect(answered.letter.inReplyTo).toBe(asked.letter.id);
    expect(answered.job.state).toBe('working');
  });

  it('resolves the job folder against the folder of the caller, and keeps it in the project', async () => {
    kit = await makeKit();
    const { bridge, claude } = kit;

    const relative = await bridge.createJob(claude.name, {
      to: 'codex',
      body: 'a',
      cwd: 'packages/a',
    });
    const absolute = await bridge.createJob(claude.name, {
      to: 'codex',
      body: 'b',
      cwd: '/work/demo/docs',
    });

    expect(relative.job.cwd).toBe('/work/demo/packages/a');
    expect(absolute.job.cwd).toBe('/work/demo/docs');
    await expect(
      bridge.createJob(claude.name, { to: 'codex', body: 'c', cwd: '/elsewhere' })
    ).rejects.toThrow(/outside both/);
    await expect(
      bridge.createJob(claude.name, { to: 'codex', body: 'd', cwd: '../../etc' })
    ).rejects.toThrow(code('invalid_input'));
    await expect(
      bridge.createJob(claude.name, { to: 'codex', body: 'e', worktree: '/tmp/wt' } as never)
    ).rejects.toThrow(code('invalid_input'));
  });
});

describe('what the bridge refuses', () => {
  it('a caller it does not know', async () => {
    kit = await makeKit();
    await expect(kit.bridge.createJob('ghost@demo', { to: 'codex', body: 'x' })).rejects.toThrow(
      code('not_registered')
    );
    await expect(kit.bridge.inbox('ghost@demo')).rejects.toThrow(code('not_registered'));
  });

  it('input that makes no sense', async () => {
    kit = await makeKit();
    const { bridge, claude } = kit;
    await expect(bridge.createJob(claude.name, { to: 'codex', body: '   ' })).rejects.toThrow(
      /needs a description/
    );
    await expect(bridge.createJob(claude.name, { to: '', body: 'x' })).rejects.toThrow(
      code('invalid_input')
    );
    await expect(
      bridge.createJob(claude.name, { to: 'codex', body: 'x', budget: { letters: 100_000 } })
    ).rejects.toThrow(code('invalid_input'));
    await expect(
      bridge.createJob(claude.name, { to: 'codex', body: 'x', letterId: 'has spaces' })
    ).rejects.toThrow(code('invalid_input'));
    await expect(bridge.job(99)).rejects.toThrow(code('unknown_job'));
    expect(await bridge.jobs()).toEqual([]);
  });

  it('a field it does not know, instead of dropping it in silence', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await expect(
      bridge.createJob(claude.name, { to: 'codex', body: 'x', id: 'job-a' } as never)
    ).rejects.toThrow(/Unrecognized key/);
    await bridge.createJob(claude.name, { to: 'codex', body: 'x' });
    await expect(
      bridge.send(codex.name, { job: 1, kind: 'note', body: 'x', letterId: 'n' } as never)
    ).rejects.toThrow(code('invalid_input'));
    await expect(bridge.letters({ attemptDueBy: 0 } as never)).rejects.toThrow(
      code('invalid_input')
    );
    expect(await bridge.letters({ replyDueBy: 0 })).toEqual([]);
  });

  it('a letter longer than the limit', async () => {
    kit = await makeKit({ limits: { maxBodyLength: 10 } });
    await expect(
      kit.bridge.createJob(kit.claude.name, { to: 'codex', body: 'x'.repeat(11) })
    ).rejects.toThrow(/limit is 10/);
  });

  it('a letter from someone who is not on the job', async () => {
    kit = await makeKit();
    const { bridge, claude } = kit;
    const other = await bridge.register({
      harness: 'codex',
      sessionId: 't2',
      cwd: '/work/demo',
      project: '/work/demo',
    });
    await bridge.createJob(claude.name, { to: 'codex@demo', body: 'Do it' });

    await expect(bridge.send(other.name, { job: 1, kind: 'note', body: 'Hi' })).rejects.toThrow(
      code('not_a_party')
    );
    await expect(bridge.cancel(other.name, 1)).rejects.toThrow(code('not_a_party'));
  });

  it('a report from the one who handed the job over, and an outcome on anything but a report', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Do it' });

    await expect(
      bridge.send(claude.name, { job: 1, kind: 'report', body: 'Done' })
    ).rejects.toThrow(/Only codex@demo/);
    await expect(
      bridge.send(codex.name, { job: 1, kind: 'note', body: 'x', outcome: 'failed' })
    ).rejects.toThrow(/Only a report has an outcome/);
  });

  it('an answer to nothing, to a letter of another job, to a note, or given twice', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Do it' });
    await bridge.createJob(claude.name, { to: 'codex', body: 'Another' });
    const note = await bridge.send(codex.name, { job: 1, kind: 'note', body: 'FYI' });
    const question = await bridge.send(codex.name, { job: 2, kind: 'question', body: 'Which?' });

    await expect(bridge.send(claude.name, { job: 1, kind: 'answer', body: 'Yes' })).rejects.toThrow(
      /Nothing on job 1 waits/
    );
    await expect(
      bridge.send(claude.name, {
        job: 1,
        kind: 'answer',
        body: 'Yes',
        inReplyTo: question.letter.id,
      })
    ).rejects.toThrow(/Job 1 has no letter/);
    await expect(
      bridge.send(claude.name, { job: 1, kind: 'answer', body: 'Yes', inReplyTo: note.letter.id })
    ).rejects.toThrow(/not a question to you/);
    await bridge.send(claude.name, { job: 2, kind: 'answer', body: 'This one' });
    await expect(
      bridge.send(claude.name, {
        job: 2,
        kind: 'answer',
        body: 'Or that',
        inReplyTo: question.letter.id,
      })
    ).rejects.toThrow(/already answered/);
  });

  it('an answer from the one who asked', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Do it' });
    const asked = await bridge.send(codex.name, {
      job: 1,
      kind: 'permission',
      body: 'May I delete dist?',
    });

    await expect(
      bridge.send(codex.name, { job: 1, kind: 'answer', body: 'Yes, go on' })
    ).rejects.toThrow(/Nothing on job 1 waits for your answer/);
    await expect(
      bridge.send(codex.name, {
        job: 1,
        kind: 'answer',
        body: 'Yes, go on',
        inReplyTo: asked.letter.id,
      })
    ).rejects.toThrow(/not a question to you/);

    expect((await bridge.letters({ job: 1, kinds: ['permission'] }))[0].state).toBe('queued');
    expect((await bridge.job(1)).state).toBe('input-required');
  });

  it('an id used again for a letter that says something else', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Do it', letterId: 'job-a' });
    await bridge.send(codex.name, { job: 1, kind: 'note', body: 'One', id: 'n-1' });

    await expect(
      bridge.createJob(claude.name, { to: 'codex', body: 'Do something else', letterId: 'job-a' })
    ).rejects.toThrow(/belongs to another letter/);
    await expect(
      bridge.send(codex.name, { job: 1, kind: 'note', body: 'Two', id: 'n-1' })
    ).rejects.toThrow(code('invalid_letter'));
  });

  it('anything more on a job that is over', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Do it' });
    await bridge.send(codex.name, { job: 1, kind: 'report', body: 'Done' });

    await expect(
      bridge.send(claude.name, { job: 1, kind: 'note', body: 'Thanks' })
    ).rejects.toThrow(/Job 1 is completed. Hand over a new job/);
    await expect(bridge.cancel(claude.name, 1)).rejects.toThrow(code('job_finished'));
  });

  it('keeps nothing of a call that failed half way', async () => {
    kit = await makeKit();
    const { bridge, claude, store } = kit;
    const insert = store.insertLetter.bind(store);
    store.insertLetter = () => {
      throw new Error('disk full');
    };

    await expect(bridge.createJob(claude.name, { to: 'codex', body: 'Do it' })).rejects.toThrow(
      'disk full'
    );
    store.insertLetter = insert;

    expect(await bridge.jobs()).toEqual([]);
    expect(await bridge.readJournal({ job: 1 })).toEqual([]);
    expect((await bridge.createJob(claude.name, { to: 'codex', body: 'Do it' })).job.number).toBe(
      1
    );
  });
});

describe('a letter sent twice', () => {
  it('is delivered once when it carries the same id', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;

    const first = await bridge.createJob(claude.name, {
      to: 'codex',
      body: 'Do it',
      letterId: 'job-a',
    });
    const again = await bridge.createJob(claude.name, {
      to: 'codex',
      body: 'Do it',
      letterId: 'job-a',
    });
    expect(first.duplicate).toBe(false);
    expect(again).toMatchObject({ duplicate: true, job: { number: 1 }, letter: { id: 'job-a' } });
    expect(await bridge.jobs()).toHaveLength(1);

    const sent = await bridge.send(codex.name, {
      job: 1,
      kind: 'note',
      body: 'On it',
      id: 'note-a',
    });
    const resent = await bridge.send(codex.name, {
      job: 1,
      kind: 'note',
      body: 'On it',
      id: 'note-a',
    });
    expect(resent).toMatchObject({ duplicate: true, letter: { seq: sent.letter.seq } });
    expect((await bridge.job(1)).lettersUsed).toBe(2);
    expect(await bridge.inbox(claude.name)).toHaveLength(1);
  });

  it('is refused when the id belongs to another letter', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Do it', letterId: 'job-a' });

    await expect(
      bridge.createJob(codex.name, { to: 'claude', body: 'x', letterId: 'job-a' })
    ).rejects.toThrow(code('invalid_letter'));
    await expect(
      bridge.send(codex.name, { job: 1, kind: 'note', body: 'x', id: 'job-a' })
    ).rejects.toThrow(code('invalid_letter'));
  });

  it('is held back when it repeats the one before it, and the journal says so', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Do it' });
    await bridge.send(codex.name, { job: 1, kind: 'note', body: 'Please review' });

    await expect(
      bridge.send(codex.name, { job: 1, kind: 'note', body: ' please  REVIEW ' })
    ).rejects.toThrow(code('loop_detected'));

    expect((await bridge.job(1)).lettersUsed).toBe(2);
    const rejected = (await bridge.readJournal()).filter(
      (entry) => entry.type === 'letter.rejected'
    );
    expect(rejected).toMatchObject([
      { job: 1, agent: 'codex@demo', data: { reason: 'loop_detected', kind: 'note' } },
    ]);
    await bridge.send(claude.name, { job: 1, kind: 'note', body: 'Please review' });
    await bridge.send(codex.name, { job: 1, kind: 'note', body: 'Something new' });
    await bridge.send(codex.name, { job: 1, kind: 'note', body: 'Please review' });
  });
});

describe('limits', () => {
  it('stop jobs from nesting deeper than three', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    const gemini = await bridge.register({
      harness: 'gemini',
      sessionId: 'g1',
      cwd: '/work/demo',
      project: '/work/demo',
    });
    const qwen = await bridge.register({
      harness: 'qwen',
      sessionId: 'q1',
      cwd: '/work/demo',
      project: '/work/demo',
    });

    const first = await bridge.createJob(claude.name, { to: 'codex', body: 'Level one' });
    const second = await bridge.createJob(codex.name, { to: 'gemini', body: 'Level two' });
    const third = await bridge.createJob(gemini.name, { to: 'qwen', body: 'Level three' });
    expect([first.job.depth, second.job.depth, third.job.depth]).toEqual([1, 2, 3]);
    expect([second.job.parent, third.job.parent]).toEqual([1, 2]);

    await expect(bridge.createJob(qwen.name, { to: 'claude', body: 'Level four' })).rejects.toThrow(
      code('depth_exceeded')
    );
    expect(await bridge.jobs()).toHaveLength(3);
    expect((await bridge.readJournal()).at(-1)).toMatchObject({
      type: 'letter.rejected',
      agent: 'qwen@demo',
      data: { reason: 'depth_exceeded' },
    });
  });

  it('count depth from the jobs an agent still carries out, not from finished ones', async () => {
    kit = await makeKit({ limits: { maxDepth: 1 } });
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'One' });

    await expect(bridge.createJob(codex.name, { to: 'claude', body: 'Two' })).rejects.toThrow(
      code('depth_exceeded')
    );
    await bridge.send(codex.name, { job: 1, kind: 'report', body: 'Done' });
    expect((await bridge.createJob(codex.name, { to: 'claude', body: 'Two' })).job.depth).toBe(1);
  });

  it('count depth from the parent a job names, and from the deepest job otherwise', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    const gemini = await bridge.register({
      harness: 'gemini',
      sessionId: 'g1',
      cwd: '/work/demo',
      project: '/work/demo',
    });
    await bridge.createJob(claude.name, { to: 'gemini', body: 'Shallow' });
    await bridge.createJob(claude.name, { to: 'codex', body: 'One' });
    await bridge.createJob(codex.name, { to: 'gemini', body: 'Deep' });

    const named = await bridge.createJob(gemini.name, {
      to: 'claude',
      body: 'Part of 1',
      parent: 1,
    });
    const unnamed = await bridge.createJob(gemini.name, { to: 'claude', body: 'Part of 3' });

    expect(named.job).toMatchObject({ parent: 1, depth: 2 });
    expect(unnamed.job).toMatchObject({ parent: 3, depth: 3 });
  });

  it('take a parent only from the jobs the caller carries out', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'One' });

    await expect(
      bridge.createJob(claude.name, { to: 'codex', body: 'Two', parent: 1 })
    ).rejects.toThrow(/not a job you are carrying out/);
    expect(
      (await bridge.createJob(codex.name, { to: 'claude', body: 'Two', parent: 1 })).job.parent
    ).toBe(1);
  });

  it('refuse a job the same agent already has from the caller, until it is over', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Write the tests' });

    await expect(
      bridge.createJob(claude.name, { to: 'codex', body: ' write  the TESTS ' })
    ).rejects.toThrow(/already handed this job to codex@demo as job #1/);
    expect(await bridge.jobs()).toHaveLength(1);
    expect((await bridge.readJournal()).at(-1)).toMatchObject({
      type: 'letter.rejected',
      data: { reason: 'loop_detected' },
    });

    await bridge.send(codex.name, { job: 1, kind: 'report', body: 'Could not', outcome: 'failed' });
    expect(
      (await bridge.createJob(claude.name, { to: 'codex', body: 'Write the tests' })).job.number
    ).toBe(2);
  });

  it('take the same words for another job when the folder is another', async () => {
    kit = await makeKit();
    const { bridge, claude } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Run the tests', cwd: 'packages/a' });

    const other = await bridge.createJob(claude.name, {
      to: 'codex',
      body: 'Run the tests',
      cwd: 'packages/b',
    });

    expect(other.job.number).toBe(2);
    await expect(
      bridge.createJob(claude.name, { to: 'codex', body: 'Run the tests', cwd: 'packages/b' })
    ).rejects.toThrow(code('loop_detected'));
  });

  it('cap how many jobs an agent has out and how fast it hands them over', async () => {
    kit = await makeKit({ limits: { maxOpenJobs: 2, jobsPerHour: 3 } });
    const { bridge, claude, codex, clock } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'One' });
    await bridge.createJob(claude.name, { to: 'codex', body: 'Two' });

    await expect(bridge.createJob(claude.name, { to: 'codex', body: 'Three' })).rejects.toThrow(
      /2 jobs out that are still in progress/
    );
    await bridge.send(codex.name, { job: 1, kind: 'report', body: 'Done' });
    await bridge.createJob(claude.name, { to: 'codex', body: 'Three' });
    await bridge.send(codex.name, { job: 2, kind: 'report', body: 'Done' });

    await expect(bridge.createJob(claude.name, { to: 'codex', body: 'Four' })).rejects.toThrow(
      /3 jobs in the last hour.*looks like a loop/s
    );
    expect(
      (await bridge.createJob(codex.name, { to: 'claude', body: 'Other way' })).job.number
    ).toBe(4);

    clock.advance(61 * MINUTE);
    expect((await bridge.createJob(claude.name, { to: 'codex', body: 'Four' })).job.number).toBe(5);
  });

  it('fail a job at once when a letter comes after its time, without waiting for the clock to tick', async () => {
    kit = await makeKit();
    const { bridge, claude, codex, clock } = kit;
    await bridge.createJob(claude.name, {
      to: 'codex',
      body: 'Do it',
      budget: { durationMs: 10 * MINUTE },
    });
    await bridge.inbox(codex.name);
    clock.advance(10 * MINUTE);

    await expect(bridge.send(codex.name, { job: 1, kind: 'report', body: 'Done' })).rejects.toThrow(
      /ran longer than its 10 min budget/
    );
    expect((await bridge.job(1)).state).toBe('failed');
  });

  it('keep a job whose answer came after the reminder', async () => {
    kit = await makeKit();
    const { bridge, claude, codex, clock } = kit;
    await bridge.createJob(claude.name, {
      to: 'codex',
      body: 'Do it',
      budget: { replyTimeoutMs: 5 * MINUTE },
    });
    await bridge.send(codex.name, { job: 1, kind: 'question', body: 'Mock Redis?' });
    clock.advance(5 * MINUTE);
    expect((await bridge.sweep()).reminded).toHaveLength(1);
    const reminder = (await bridge.inbox(claude.name)).at(-1);
    expect(reminder?.body).toContain('It says:\n> Mock Redis?');

    clock.advance(4 * MINUTE);
    await bridge.send(claude.name, { job: 1, kind: 'answer', body: 'Yes' });
    clock.advance(60 * MINUTE);

    expect(await bridge.sweep()).toEqual({ failed: [], reminded: [] });
    expect((await bridge.job(1)).state).toBe('working');
  });

  it('fail a job that used up its letters, and tell both sides', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Do it', budget: { letters: 3 } });
    await bridge.send(codex.name, { job: 1, kind: 'note', body: 'One' });
    await bridge.send(codex.name, { job: 1, kind: 'note', body: 'Two' });

    await expect(bridge.send(codex.name, { job: 1, kind: 'note', body: 'Three' })).rejects.toThrow(
      /Job 1 has failed: the job used all 3 letters/
    );

    expect(await bridge.job(1)).toMatchObject({
      state: 'failed',
      reason: 'the job used all 3 letters of its budget',
      lettersUsed: 3,
    });
    const notes = await bridge.letters({ job: 1, from: BRIDGE_SENDER });
    expect(notes.map((note) => note.to).sort()).toEqual(['claude@demo', 'codex@demo']);
    expect(notes[0].body).toContain('Job #1 has failed');
  });

  it('let the report through when the letters are used up, so finished work is not thrown away', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Do it', budget: { letters: 1 } });

    const { job } = await bridge.send(codex.name, { job: 1, kind: 'report', body: 'Done' });

    expect(job).toMatchObject({ state: 'completed', lettersUsed: 2 });
  });

  it('fail a job that ran past its time', async () => {
    kit = await makeKit();
    const { bridge, claude, codex, clock } = kit;
    await bridge.createJob(claude.name, {
      to: 'codex',
      body: 'Do it',
      budget: { durationMs: 10 * MINUTE },
    });
    await bridge.inbox(codex.name);

    clock.advance(10 * MINUTE - 1);
    expect(await bridge.sweep()).toEqual({ failed: [], reminded: [] });
    clock.advance(1);
    expect(await bridge.sweep()).toEqual({ failed: [1], reminded: [] });

    expect(await bridge.job(1)).toMatchObject({
      state: 'failed',
      reason: 'it ran longer than its 10 min budget',
    });
    await expect(bridge.send(codex.name, { job: 1, kind: 'report', body: 'Done' })).rejects.toThrow(
      code('job_finished')
    );
  });

  it('remind the one who owes an answer, then fail the job', async () => {
    kit = await makeKit();
    const { bridge, claude, codex, clock } = kit;
    await bridge.createJob(claude.name, {
      to: 'codex',
      body: 'Do it',
      budget: { replyTimeoutMs: 5 * MINUTE },
    });
    await bridge.inbox(codex.name);
    const { letter } = await bridge.send(codex.name, {
      job: 1,
      kind: 'question',
      body: 'Mock Redis?',
    });
    await bridge.inbox(claude.name);

    clock.advance(5 * MINUTE);
    expect(await bridge.sweep()).toEqual({ failed: [], reminded: [letter.id] });
    const [reminder] = await bridge.inbox(claude.name);
    expect(reminder).toMatchObject({ kind: 'note', from: BRIDGE_SENDER });
    expect(reminder.body).toContain(
      `the question ${letter.id} from codex@demo still waits for your answer`
    );
    expect(reminder.body).toContain('fails in 5 min');
    expect(reminder.body).toContain('Mock Redis?');
    expect(await bridge.sweep()).toEqual({ failed: [], reminded: [] });

    clock.advance(5 * MINUTE);
    expect(await bridge.sweep()).toEqual({ failed: [1], reminded: [] });
    expect(await bridge.job(1)).toMatchObject({
      state: 'failed',
      reason: `claude@demo did not answer the question ${letter.id} in 10 min`,
    });
    expect((await bridge.inbox(codex.name)).at(-1)?.body).toContain('Stop working on it');
  });

  it('do not fail a job whose question was answered in time', async () => {
    kit = await makeKit();
    const { bridge, claude, codex, clock } = kit;
    await bridge.createJob(claude.name, {
      to: 'codex',
      body: 'Do it',
      budget: { replyTimeoutMs: 5 * MINUTE },
    });
    await bridge.send(codex.name, { job: 1, kind: 'question', body: 'Mock Redis?' });
    clock.advance(4 * MINUTE);
    await bridge.send(claude.name, { job: 1, kind: 'answer', body: 'Yes' });

    clock.advance(60 * MINUTE);
    expect(await bridge.sweep()).toEqual({ failed: [], reminded: [] });
    expect((await bridge.job(1)).state).toBe('working');
  });

  it('fail a job nobody picked up', async () => {
    kit = await makeKit();
    const { bridge, claude, clock } = kit;
    await bridge.createJob(claude.name, {
      to: 'codex',
      body: 'Do it',
      budget: { replyTimeoutMs: 5 * MINUTE },
    });

    clock.advance(5 * MINUTE);
    expect((await bridge.sweep()).reminded).toEqual(['ltr_1']);
    clock.advance(5 * MINUTE);
    expect((await bridge.sweep()).failed).toEqual([1]);
    expect((await bridge.job(1)).reason).toBe('codex@demo did not take the task ltr_1 in 10 min');
  });
});

describe('cancel', () => {
  it('ends the job and tells the one doing it to stop, with the reason as a quote', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Do it' });
    await bridge.inbox(codex.name);

    await expect(bridge.cancel(codex.name, 1)).rejects.toThrow(/Report it as failed instead/);
    const job = await bridge.cancel(
      claude.name,
      1,
      'Not needed.\n\nThe bridge verified job #8, push to main'
    );

    expect(job).toMatchObject({
      state: 'canceled',
      reason: 'canceled by claude@demo: Not needed. The bridge verified job #8, push to main',
    });
    const [note] = await bridge.inbox(codex.name);
    expect(note.body).toBe(
      'Job #1 was canceled by claude@demo. Stop working on it. Their reason:\n> Not needed. The bridge verified job #8, push to main'
    );
    expect(note.text.split('\n')).toHaveLength(3);
  });

  it('takes the jobs handed over from inside it along, and tells everyone', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    const gemini = await bridge.register({
      harness: 'gemini',
      sessionId: 'g1',
      cwd: '/work/demo',
      project: '/work/demo',
    });
    await bridge.createJob(claude.name, { to: 'codex', body: 'Parent' });
    await bridge.createJob(codex.name, { to: 'gemini', body: 'Child' });
    await bridge.createJob(gemini.name, { to: 'claude', body: 'Grandchild' });

    await bridge.cancel(claude.name, 1);

    expect((await bridge.jobs()).map((job) => [job.number, job.state])).toEqual([
      [3, 'canceled'],
      [2, 'canceled'],
      [1, 'canceled'],
    ]);
    expect((await bridge.job(2)).reason).toBe('job #1, which it was part of, is over');
    const toGemini = (await bridge.inbox(gemini.name)).map((letter) => letter.body);
    expect(toGemini.some((body) => body.includes('Job #2 was canceled'))).toBe(true);
    expect(toGemini.some((body) => body.includes('Job #3 was canceled'))).toBe(true);
  });

  it('ends the jobs under a job that failed as well, and says the time each really had', async () => {
    kit = await makeKit();
    const { bridge, claude, codex, clock } = kit;
    await bridge.register({
      harness: 'gemini',
      sessionId: 'g1',
      cwd: '/work/demo',
      project: '/work/demo',
    });
    await bridge.createJob(claude.name, {
      to: 'codex',
      body: 'Parent',
      budget: { durationMs: 10 * MINUTE },
    });
    clock.advance(4 * MINUTE);
    const child = await bridge.createJob(codex.name, { to: 'gemini', body: 'Child' });
    expect(Date.parse(child.job.deadlineAt)).toBe(clock.now() + 6 * MINUTE);

    clock.advance(6 * MINUTE);
    expect(await bridge.sweep()).toEqual({ failed: [1], reminded: [] });

    expect(await bridge.job(1)).toMatchObject({
      state: 'failed',
      reason: 'it ran longer than its 10 min budget',
    });
    expect(await bridge.job(2)).toMatchObject({
      state: 'canceled',
      reason: 'job #1, which it was part of, is over',
    });
  });

  it('says a job under another ran out of the time its parent had left', async () => {
    kit = await makeKit();
    const { bridge, claude, codex, clock } = kit;
    await bridge.register({
      harness: 'gemini',
      sessionId: 'g1',
      cwd: '/work/demo',
      project: '/work/demo',
    });
    await bridge.createJob(claude.name, {
      to: 'codex',
      body: 'Parent',
      budget: { durationMs: 10 * MINUTE },
    });
    clock.advance(4 * MINUTE);
    await bridge.createJob(codex.name, { to: 'gemini', body: 'Child' });
    clock.advance(6 * MINUTE);

    await expect(
      bridge.send('gemini@demo', { job: 2, kind: 'report', body: 'Done' })
    ).rejects.toThrow(/longer than the 6 min that job #1, which it is part of, had left/);
  });

  it('ends the jobs under a job that was reported on, done or failed', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.register({
      harness: 'gemini',
      sessionId: 'g1',
      cwd: '/work/demo',
      project: '/work/demo',
    });
    await bridge.createJob(claude.name, { to: 'codex', body: 'Parent' });
    await bridge.createJob(codex.name, { to: 'gemini', body: 'Child' });
    await bridge.createJob(claude.name, { to: 'codex', body: 'Other parent' });
    await bridge.createJob(codex.name, { to: 'gemini', body: 'Other child', parent: 3 });

    await bridge.send(codex.name, { job: 1, kind: 'report', body: 'Done' });
    await bridge.send(codex.name, { job: 3, kind: 'report', body: 'No luck', outcome: 'failed' });

    expect((await bridge.jobs({ parent: 1 })).map((job) => job.state)).toEqual(['canceled']);
    expect((await bridge.jobs({ parent: 3 })).map((job) => job.state)).toEqual(['canceled']);
    const told = (await bridge.inbox('gemini@demo', { limit: 100 })).map((letter) => letter.body);
    expect(told.filter((body) => body.includes('Stop working on it'))).toHaveLength(2);
  });
});

describe('inbox', () => {
  it('can be looked at without taking, and shows what is still unanswered', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Do it' });
    await bridge.createJob(claude.name, { to: 'codex', body: 'And this' });

    expect(await bridge.inbox(codex.name, { peek: true })).toMatchObject([
      { state: 'queued' },
      { state: 'queued' },
    ]);
    expect((await bridge.job(1)).state).toBe('submitted');
    expect(await bridge.inbox(codex.name, { job: 2 })).toMatchObject([{ job: 2, state: 'read' }]);
    expect(await bridge.inbox(codex.name)).toMatchObject([{ job: 1 }]);
    expect(await bridge.inbox(codex.name)).toEqual([]);
    expect(await bridge.inbox(codex.name, { unhandled: true })).toHaveLength(2);
  });

  it('hands out a limited number of letters at a time and marks only those', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Carrier', budget: { letters: 100 } });
    for (let index = 1; index <= 24; index += 1) {
      await bridge.send(claude.name, { job: 1, kind: 'note', body: `Note ${index}` });
    }

    const first = await bridge.inbox(codex.name);
    expect(first).toHaveLength(20);
    expect(await bridge.letters({ to: codex.name, states: ['queued'] })).toHaveLength(5);
    const second = await bridge.inbox(codex.name, { limit: 3 });
    expect(second.map((letter) => letter.body)).toEqual(['Note 20', 'Note 21', 'Note 22']);
    expect(await bridge.inbox(codex.name)).toHaveLength(2);
    await expect(bridge.inbox(codex.name, { limit: 101 })).rejects.toThrow(code('invalid_input'));
  });

  it('never returns more text than one answer holds, and loses nothing', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Carrier' });
    for (let index = 0; index < 12; index += 1) {
      await bridge.send(claude.name, {
        job: 1,
        kind: 'note',
        body: `${index} ${'x'.repeat(190_000)}`,
      });
    }

    const batches: number[] = [];
    const seen = new Set<string>();
    for (;;) {
      const batch = await bridge.inbox(codex.name);
      if (batch.length === 0) break;
      batches.push(batch.length);
      for (const letter of batch) seen.add(letter.id);
      expect(batch.reduce((sum, letter) => sum + letter.text.length, 0)).toBeLessThan(2_500_000);
    }

    expect(seen.size).toBe(13);
    expect(batches.length).toBeGreaterThan(2);
    const listed = await bridge.letters({ job: 1 });
    expect(listed.length).toBeLessThan(13);
    const rest = await bridge.letters({ job: 1, afterSeq: listed.at(-1)!.seq });
    expect(rest[0].seq).toBe(listed.at(-1)!.seq + 1);
    const all = kit.store.readJournal();
    const tail = await bridge.readJournal({ tail: 5000 });
    const head = await bridge.readJournal({ limit: 5000 });
    expect(tail.at(-1)?.seq).toBe(all.at(-1)?.seq);
    expect(tail.length).toBeLessThan(all.length);
    expect(head[0].seq).toBe(1);
    expect(head.length).toBeLessThan(all.length);
  });

  it('shows the newest of what was taken before, and looks further on request', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Carrier', budget: { letters: 100 } });
    for (let index = 1; index <= 30; index += 1) {
      await bridge.send(claude.name, { job: 1, kind: 'note', body: `Note ${index}` });
    }
    while ((await bridge.inbox(codex.name)).length > 0);
    await bridge.send(claude.name, { job: 1, kind: 'note', body: 'The missed answer' });

    const again = await bridge.inbox(codex.name, { unhandled: true });
    expect(again).toHaveLength(20);
    expect(again.at(-1)?.body).toBe('The missed answer');
    expect(again[0].body).toBe('Note 12');
    expect(again.map((letter) => letter.seq)).toEqual(
      [...again].sort((a, b) => a.seq - b.seq).map((letter) => letter.seq)
    );

    const all: string[] = [];
    let afterSeq = 0;
    for (;;) {
      const page = await bridge.inbox(codex.name, { unhandled: true, afterSeq, peek: true });
      if (page.length === 0) break;
      all.push(...page.map((letter) => letter.body));
      afterSeq = page.at(-1)!.seq;
    }
    expect(all).toHaveLength(32);
    expect(all[0]).toBe('Carrier');
  });

  it('returns a new letter however much text of the ones taken before is still unanswered', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Carrier' });
    for (let index = 0; index < 6; index += 1) {
      await bridge.send(claude.name, {
        job: 1,
        kind: 'question',
        body: `Question ${index} ${'x'.repeat(190_000)}`,
      });
    }
    while ((await bridge.inbox(codex.name)).length > 0);
    await bridge.send(claude.name, { job: 1, kind: 'question', body: 'The new one' });

    const polled = await bridge.inbox(codex.name, { unhandled: true });

    expect(polled.at(-1)).toMatchObject({ body: 'The new one', state: 'read' });
    expect(polled.length).toBeGreaterThan(1);
    expect(polled.reduce((sum, letter) => sum + letter.text.length, 0)).toBeLessThan(2_500_000);
    expect(await bridge.letters({ to: codex.name, states: ['queued'] })).toEqual([]);
  });

  it('is done with a question nobody answered once its job is over', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Do it' });
    await bridge.send(claude.name, { job: 1, kind: 'question', body: 'How far?' });
    await bridge.inbox(codex.name);
    await bridge.send(codex.name, { job: 1, kind: 'report', body: 'Done' });

    expect(await bridge.inbox(codex.name, { unhandled: true })).toEqual([]);
    expect((await bridge.letters({ job: 1, kinds: ['question'] }))[0].state).toBe('handled');
  });

  it('lets a note be dismissed, but not a question or a job', async () => {
    kit = await makeKit();
    const { bridge, claude, codex } = kit;
    const { letter: task } = await bridge.createJob(claude.name, { to: 'codex', body: 'Do it' });
    const note = await bridge.send(codex.name, { job: 1, kind: 'note', body: 'FYI' });
    const question = await bridge.send(codex.name, { job: 1, kind: 'question', body: 'Which?' });

    expect((await bridge.acknowledge(claude.name, note.letter.id)).state).toBe('handled');
    expect((await bridge.acknowledge(claude.name, question.letter.id)).state).toBe('read');
    expect((await bridge.acknowledge(codex.name, task.id)).state).toBe('read');
    await expect(bridge.acknowledge(codex.name, note.letter.id)).rejects.toThrow(
      code('unknown_letter')
    );
    await expect(bridge.acknowledge(claude.name, 'nope')).rejects.toThrow(code('unknown_letter'));
  });
});

describe('verification', () => {
  it('is recorded on the job and in the journal', async () => {
    kit = await makeKit();
    const { bridge, claude, codex, clock } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Do it' });
    await bridge.send(codex.name, { job: 1, kind: 'report', body: 'Done' });
    clock.advance(1000);

    const job = await bridge.recordVerification(1, { verified: true, summary: '14 of 14 pass' });

    expect(job.verification).toEqual({
      verified: true,
      checkedAt: new Date(clock.now()).toISOString(),
      summary: '14 of 14 pass',
    });
    expect((await bridge.readJournal({ job: 1 })).at(-1)).toMatchObject({
      type: 'job.verified',
      data: { verified: true, summary: '14 of 14 pass' },
    });
    await expect(bridge.recordVerification(9, { verified: false })).rejects.toThrow(
      code('unknown_job')
    );
  });
});

describe('status and close', () => {
  it('counts what is going on', async () => {
    kit = await makeKit({ adapters: [new FakeAdapter({ harness: 'gemini' })] });
    const { bridge, claude } = kit;
    await bridge.createJob(claude.name, { to: 'codex', body: 'Do it' });

    expect(await bridge.status()).toEqual({
      agents: 2,
      activeJobs: 1,
      queuedLetters: 1,
      adapters: ['gemini'],
      waiting: [],
    });
  });

  it('takes no calls once closed', async () => {
    kit = await makeKit();
    await kit.bridge.close();

    await expect(kit.bridge.status()).rejects.toThrow(code('not_running'));
    await expect(
      kit.bridge.createJob(kit.claude.name, { to: 'codex', body: 'x' })
    ).rejects.toBeInstanceOf(BridgeError);
  });
});
