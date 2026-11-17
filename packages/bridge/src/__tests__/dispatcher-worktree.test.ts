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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BridgeDispatcher, type BridgeDispatcherOptions } from '../dispatcher';
import type { RightsJudge } from '../person';
import { SqliteBridgeStore } from '../store/sqlite';
import { BRIDGE_SENDER, DEFAULT_LIMITS, type AgentRecord, type BridgeJob } from '../types';
import { DISCARDED_REFS } from '../worktree';
import { Clock, FakeAdapter } from './bridge-kit';

let scratch: string;
let repo: string;
let store: SqliteBridgeStore;
let clock: Clock;
let errors: Error[];
let bridges: BridgeDispatcher[];
let codex: FakeAdapter;
let claude: AgentRecord;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trimEnd();

const write = (root: string, path: string, text: string): void => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
};

const read = (root: string, path: string): string => readFileSync(join(root, path), 'utf8');

const code = (value: string) => expect.objectContaining({ code: value });

function dispatcher(options: Partial<BridgeDispatcherOptions> = {}): BridgeDispatcher {
  let letters = 0;
  const bridge = new BridgeDispatcher({
    store,
    now: clock.now,
    newLetterId: () => `ltr_${bridges.length}_${(letters += 1)}`,
    onError: (error) => errors.push(error),
    adapters: [codex],
    rights: () => 'allow',
    ...options,
  });
  bridges.push(bridge);
  return bridge;
}

/** A dispatcher with Claude Code open in the repository, and Codex sessions it can start. */
async function start(options: Partial<BridgeDispatcherOptions> = {}): Promise<BridgeDispatcher> {
  const bridge = dispatcher(options);
  claude = await bridge.register({
    harness: 'claude-code',
    sessionId: 'session-claude',
    cwd: repo,
    project: repo,
  });
  return bridge;
}

/** A job handed to a fresh Codex session, and that session's agent once it started. */
async function handOver(
  bridge: BridgeDispatcher,
  input: Partial<Parameters<BridgeDispatcher['createJob']>[1]> = {}
): Promise<{ job: BridgeJob; worker: string }> {
  const created = await bridge.createJob(claude.name, {
    to: 'codex',
    body: 'Fix the limiter',
    ...input,
  });
  await bridge.idle();
  const job = await bridge.job(created.job.number);
  await bridge.inbox(job.to);
  return { job: await bridge.job(job.number), worker: job.to };
}

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-jobs-')));
  repo = join(scratch, 'demo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  write(repo, 'README.md', 'demo\n');
  write(repo, 'src/limiter.ts', 'export const limit = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');

  store = await SqliteBridgeStore.open(':memory:');
  clock = new Clock();
  errors = [];
  bridges = [];
  let sessions = 0;
  codex = new FakeAdapter({
    harness: 'codex',
    createSession: async () => ({ sessionId: `thread-${(sessions += 1)}` }),
  });
});

afterEach(async () => {
  for (const bridge of bridges) await bridge.close();
  store.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('a job in a worktree of its own', () => {
  it('starts its session in a checkout the bridge made for it, and tells the session so', async () => {
    const bridge = await start();

    const { job } = await handOver(bridge, { worktree: true, title: 'Fix the limiter' });

    const path = join(repo, '.cogitator', 'worktrees', 'job-1-fix-the-limiter');
    expect(job).toMatchObject({
      isolation: 'worktree',
      cwd: path,
      project: repo,
      worktree: {
        path,
        branch: 'cogitator/job-1-fix-the-limiter',
        base: git(repo, 'rev-parse', 'HEAD'),
      },
    });
    expect(codex.sessions).toHaveLength(1);
    expect(codex.sessions[0]).toMatchObject({ cwd: path, project: repo });
    expect(codex.sessions[0].job.worktree?.path).toBe(path);
    expect(codex.sessions[0].firstLetter.text.split('\n').at(-1)).toBe(
      `[agent bridge] You work in a git worktree of your own: ${path}, on the branch cogitator/job-1-fix-the-limiter, made from commit ${git(repo, 'rev-parse', 'HEAD').slice(0, 10)}. Change files only there. When you report, the bridge reads what you changed, committed or not. Nothing git ignores is there, such as installed dependencies and build output: install and build only what the job needs.`
    );
    expect((await bridge.agents({ harness: 'codex' }))[0].cwd).toBe(path);
    expect(read(path, 'src/limiter.ts')).toBe('export const limit = 1;\n');
    expect((await bridge.readJournal({ job: 1 })).map((entry) => entry.type)).toContain(
      'job.worktree'
    );
    expect(errors).toEqual([]);
  });

  it('gets a session of its own even when one of that harness is open', async () => {
    const bridge = await start();
    const open = await bridge.register({
      harness: 'codex',
      sessionId: 'thread-open',
      cwd: repo,
      project: repo,
    });

    const { job } = await handOver(bridge, { worktree: true });

    expect(job.to).not.toBe(open.name);
    expect(codex.sessions).toHaveLength(1);
    await expect(
      bridge.createJob(claude.name, { to: open.name, body: 'Another', worktree: true })
    ).rejects.toThrow(code('no_worktree'));
  });

  it('is refused outside a git repository, and when the project has as many as it may', async () => {
    const bridge = await start({ limits: { worktreesPerProject: 1 } });
    const plain = join(scratch, 'plain');
    mkdirSync(plain);
    const elsewhere = await bridge.register({
      harness: 'claude-code',
      sessionId: 'session-plain',
      cwd: plain,
      project: plain,
    });
    await expect(
      bridge.createJob(elsewhere.name, { to: 'codex', body: 'Anything', worktree: true })
    ).rejects.toThrow(code('no_worktree'));

    await handOver(bridge, { worktree: true });
    await expect(
      bridge.createJob(claude.name, { to: 'codex', body: 'A second one', worktree: true })
    ).rejects.toThrow(
      expect.objectContaining({
        code: 'worktree_limit',
        message: expect.stringContaining('(#1)'),
      })
    );
    await bridge.createJob(claude.name, { to: 'codex:new', body: 'One without a worktree' });
  });

  it('fails with what git said when the worktree cannot be made', async () => {
    const empty = join(scratch, 'empty');
    mkdirSync(empty);
    git(empty, 'init', '-q');
    const bridge = await start();
    const owner = await bridge.register({
      harness: 'claude-code',
      sessionId: 'session-empty',
      cwd: empty,
      project: empty,
    });

    const created = await bridge.createJob(owner.name, {
      to: 'codex',
      body: 'Anything',
      worktree: true,
    });
    await bridge.idle();

    const job = await bridge.job(created.job.number);
    expect(job.state).toBe('failed');
    expect(job.reason).toContain('the worktree of the job could not be made');
    expect(codex.sessions).toEqual([]);
  });
});

describe('the report of a job in a worktree', () => {
  it('says what was changed there, committed or not', async () => {
    const bridge = await start();
    const { job, worker } = await handOver(bridge, { worktree: true });
    const path = job.worktree!.path;
    write(path, 'src/limiter.ts', 'export const limit = 2;\n');
    git(path, 'commit', '-q', '-am', 'raise the limit');
    write(path, 'src/burst.ts', 'export const burst = 3;\n');

    const sent = await bridge.send(worker, { job: 1, kind: 'report', body: 'Raised the limit' });

    expect(sent.job.changes).toMatchObject({
      files: 2,
      insertions: 2,
      deletions: 1,
      commits: 1,
      paths: ['src/burst.ts', 'src/limiter.ts'],
    });
    const [report] = await bridge.inbox(claude.name);
    expect(report.text.split('\n').slice(1)).toEqual([
      'Raised the limit',
      `[agent bridge] Changed in the worktree of the job, ${path}: 2 files, +2 -1, 1 commit: src/burst.ts, src/limiter.ts. Nothing of it is in your checkout yet: look at it with diff, take it with accept, drop it with reject.`,
    ]);
  });

  it('says so when nothing was changed', async () => {
    const bridge = await start();
    const { job, worker } = await handOver(bridge, { worktree: true });

    await bridge.send(worker, { job: 1, kind: 'report', body: 'Nothing to fix' });

    const [report] = await bridge.inbox(claude.name);
    expect(report.text.split('\n').at(-1)).toBe(
      `[agent bridge] Nothing was changed in the worktree of the job, ${job.worktree!.path}.`
    );
  });
});

describe('the changes of a job', () => {
  it('are shown to its two agents while it runs, as files and as a patch', async () => {
    const bridge = await start();
    const { job, worker } = await handOver(bridge, { worktree: true });
    write(job.worktree!.path, 'src/limiter.ts', 'export const limit = 2;\n');
    write(job.worktree!.path, 'notes.txt', 'new\n');

    const seen = await bridge.diff(claude.name, { job: 1 });
    const listed = await bridge.diff(worker, { job: 1, maxChars: 0 });
    const one = await bridge.diff(claude.name, { job: 1, paths: ['notes.txt'] });

    expect(seen).toMatchObject({
      job: 1,
      worktree: job.worktree!.path,
      branch: job.worktree!.branch,
      base: job.worktree!.base,
      files: [
        { path: 'notes.txt', kind: 'added', insertions: 1, deletions: 0 },
        { path: 'src/limiter.ts', kind: 'modified', insertions: 1, deletions: 1 },
      ],
      insertions: 2,
      deletions: 1,
      commits: 0,
      truncated: false,
    });
    expect(seen.patch).toContain('+export const limit = 2;');
    expect(listed).toMatchObject({ patch: '', truncated: true });
    expect(listed.files).toHaveLength(2);
    expect(one.patch).toContain('+new');
    expect(one.patch).not.toContain('limit = 2');
  });

  it("are nobody else's to see, and there are none to show for a job done in place", async () => {
    const bridge = await start();
    await handOver(bridge, { worktree: true });
    const stranger = await bridge.register({
      harness: 'gemini',
      sessionId: 'gemini-1',
      cwd: repo,
      project: repo,
    });
    await expect(bridge.diff(stranger.name, { job: 1 })).rejects.toThrow(code('not_a_party'));

    await bridge.createJob(claude.name, { to: 'codex:new', body: 'Done in place' });
    await bridge.idle();
    await expect(bridge.diff(claude.name, { job: 2 })).rejects.toThrow(
      expect.objectContaining({
        code: 'no_worktree',
        message: `Job 2 was done in ${repo}, not in a worktree of its own: what it changed is there`,
      })
    );
  });
});

describe('taking the work of a job', () => {
  async function reported(bridge: BridgeDispatcher): Promise<BridgeJob> {
    const { job, worker } = await handOver(bridge, { worktree: true });
    write(job.worktree!.path, 'src/limiter.ts', 'export const limit = 2;\n');
    write(job.worktree!.path, 'src/burst.ts', 'export const burst = 3;\n');
    await bridge.send(worker, { job: job.number, kind: 'report', body: 'Done' });
    return bridge.job(job.number);
  }

  it('brings it into the checkout of whoever handed the job over, staged and not committed', async () => {
    const bridge = await start();
    const job = await reported(bridge);
    write(repo, 'README.md', 'my own edit\n');
    const head = git(repo, 'rev-parse', 'HEAD');

    const taken = await bridge.accept(claude.name, { job: 1 });

    expect(taken).toMatchObject({
      state: 'accepted',
      into: repo,
      files: 2,
      insertions: 2,
      deletions: 1,
    });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'status', '--porcelain').split('\n')).toEqual([
      ' M README.md',
      'A  src/burst.ts',
      'M  src/limiter.ts',
    ]);
    expect(existsSync(job.worktree!.path)).toBe(false);
    expect(git(repo, 'branch', '--list', 'cogitator/*')).toBe('');
    expect(taken.job.worktree?.end).toMatchObject({ how: 'accepted', into: repo });
    expect((await bridge.readJournal({ job: 1 })).at(-1)).toMatchObject({
      type: 'job.accepted',
      data: { how: 'accepted', into: repo, files: 2 },
    });
    await expect(bridge.diff(claude.name, { job: 1 })).rejects.toThrow(
      expect.objectContaining({
        code: 'no_worktree',
        message: `The work of job 1 was taken into ${repo}, and its worktree is gone`,
      })
    );
    await expect(bridge.accept(claude.name, { job: 1 })).rejects.toThrow(code('no_worktree'));
  });

  it('names the files that would conflict, touches nothing, and can be dropped then', async () => {
    const bridge = await start();
    const job = await reported(bridge);
    write(repo, 'src/limiter.ts', 'export const limit = 9;\n');
    git(repo, 'commit', '-q', '-am', 'mine');

    const taken = await bridge.accept(claude.name, { job: 1 });

    expect(taken).toMatchObject({ state: 'conflict', into: repo, files: ['src/limiter.ts'] });
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(existsSync(job.worktree!.path)).toBe(true);

    const dropped = await bridge.reject(claude.name, { job: 1, reason: 'Superseded' });

    expect(dropped.worktree?.end).toMatchObject({ how: 'rejected' });
    expect(existsSync(job.worktree!.path)).toBe(false);
    expect(git(repo, 'branch', '--list', 'cogitator/*')).toBe('');
    expect((await bridge.readJournal({ job: 1 })).at(-1)).toMatchObject({
      type: 'job.rejected',
      data: { how: 'rejected', reason: 'Superseded' },
    });
  });

  it('says what git said when the checkout has changes in the way, and keeps the worktree', async () => {
    const bridge = await start();
    const job = await reported(bridge);
    write(repo, 'src/limiter.ts', 'export const limit = 1; // mine\n');

    await expect(bridge.accept(claude.name, { job: 1 })).rejects.toThrow(
      expect.objectContaining({
        code: 'invalid_input',
        message: expect.stringMatching(
          /^Git refused to bring the changes of job 1 into .+, which is as it was\. Commit or stash what is in the way there, then take the work again: .*would be overwritten/
        ),
      })
    );
    expect(read(repo, 'src/limiter.ts')).toBe('export const limit = 1; // mine\n');
    expect(existsSync(job.worktree!.path)).toBe(true);
  });

  it('is refused while changes are staged in the checkout, and what is staged there stays', async () => {
    const bridge = await start({ limits: { worktreesPerProject: 5 } });
    await reported(bridge);
    const second = await reported(bridge);
    await bridge.accept(claude.name, { job: 1 });
    const staged = git(repo, 'status', '--porcelain');

    await expect(bridge.accept(claude.name, { job: second.number })).rejects.toThrow(
      expect.objectContaining({
        code: 'invalid_input',
        message: `Nothing can be brought into ${repo} right now: changes are staged there. Taking the work of a job stages it, so commit or stash what is there first, then take the work again`,
      })
    );

    expect(git(repo, 'status', '--porcelain')).toBe(staged);
    expect(read(repo, 'src/burst.ts')).toBe('export const burst = 3;\n');
    expect(existsSync(second.worktree!.path)).toBe(true);

    git(repo, 'commit', '-q', '-m', 'the work of job 1');
    expect(await bridge.accept(claude.name, { job: second.number })).toMatchObject({
      state: 'accepted',
    });
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('leaves it as a branch when asked, the one of the worktree or one that is named', async () => {
    const bridge = await start({ limits: { worktreesPerProject: 5 } });
    const first = await reported(bridge);
    const second = await reported(bridge);
    const third = await reported(bridge);

    const kept = await bridge.accept(claude.name, { job: first.number, asBranch: true });
    const named = await bridge.accept(claude.name, {
      job: second.number,
      asBranch: 'feat/burst',
    });

    expect(kept).toMatchObject({ state: 'branch', branch: first.worktree!.branch });
    expect(named).toMatchObject({ state: 'branch', branch: 'feat/burst' });
    expect(git(repo, 'show', `${first.worktree!.branch}:src/burst.ts`)).toBe(
      'export const burst = 3;'
    );
    expect(git(repo, 'show', 'feat/burst:src/limiter.ts')).toBe('export const limit = 2;');
    expect(git(repo, 'branch', '--list', second.worktree!.branch)).toBe('');
    expect(existsSync(first.worktree!.path)).toBe(false);
    expect(existsSync(second.worktree!.path)).toBe(false);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(named.job.worktree?.end).toMatchObject({ how: 'branch', ref: 'feat/burst' });

    await expect(
      bridge.accept(claude.name, { job: third.number, asBranch: 'feat/burst' })
    ).rejects.toThrow(code('invalid_input'));
    expect(existsSync(third.worktree!.path)).toBe(true);
    await expect(
      bridge.accept(claude.name, { job: third.number, asBranch: '../escape' })
    ).rejects.toThrow(code('invalid_input'));
  });

  it('finds nothing to take in a worktree nobody changed, and removes it', async () => {
    const bridge = await start();
    const { job, worker } = await handOver(bridge, { worktree: true });
    await bridge.send(worker, { job: 1, kind: 'report', body: 'Nothing to fix' });

    const taken = await bridge.accept(claude.name, { job: 1 });

    expect(taken.state).toBe('nothing');
    expect(existsSync(job.worktree!.path)).toBe(false);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('is for whoever handed the job over, once the job is finished', async () => {
    const bridge = await start();
    const { worker } = await handOver(bridge, { worktree: true });

    await expect(bridge.accept(claude.name, { job: 1 })).rejects.toThrow(
      expect.objectContaining({
        code: 'invalid_input',
        message: 'Job 1 is still working. Wait for its report, or cancel it first',
      })
    );
    await expect(bridge.reject(claude.name, { job: 1 })).rejects.toThrow(code('invalid_input'));
    await bridge.send(worker, { job: 1, kind: 'report', body: 'Done' });
    await expect(bridge.accept(worker, { job: 1 })).rejects.toThrow(code('not_a_party'));
    await expect(bridge.reject(worker, { job: 1 })).rejects.toThrow(code('not_a_party'));
  });

  it('can take what a canceled job left behind', async () => {
    const bridge = await start();
    const { job } = await handOver(bridge, { worktree: true });
    write(job.worktree!.path, 'half.txt', 'half done\n');
    await bridge.cancel(claude.name, 1, 'Changed my mind');

    const taken = await bridge.accept(claude.name, { job: 1 });

    expect(taken.state).toBe('accepted');
    expect(read(repo, 'half.txt')).toBe('half done\n');
  });
});

describe('the session started in a worktree', () => {
  it("is its job's alone: a later job for the harness gets a session of its own", async () => {
    const bridge = await start();
    const { job, worker } = await handOver(bridge, { worktree: true });

    const later = await bridge.createJob(claude.name, { to: 'codex', body: 'Something else' });
    await bridge.idle();

    expect(later.job.to).not.toBe(worker);
    expect(codex.sessions).toHaveLength(2);
    expect(codex.sessions[1].cwd).toBe(repo);

    await bridge.send(worker, { job: job.number, kind: 'report', body: 'Done' });
    await bridge.reject(claude.name, { job: job.number });

    expect((await bridge.agents({})).find((agent) => agent.name === worker)?.status).toBe('gone');
    await expect(
      bridge.createJob(claude.name, { to: worker, body: 'One more for you' })
    ).rejects.toThrow(code('unknown_agent'));
  });

  it('cannot be asked for in a repository of its own inside the project', async () => {
    const nested = join(repo, 'vendor', 'lib');
    mkdirSync(nested, { recursive: true });
    git(nested, 'init', '-q');
    const bridge = await start();

    await expect(
      bridge.createJob(claude.name, {
        to: 'codex',
        body: 'Fix the library',
        cwd: nested,
        worktree: true,
      })
    ).rejects.toThrow(
      expect.objectContaining({
        code: 'no_worktree',
        message: expect.stringContaining('is in a repository of its own inside the project'),
      })
    );
  });
});

describe('a worktree nobody came for', () => {
  it('is put away after a while, with its work kept under a ref and a word to whoever handed the job over', async () => {
    const bridge = await start();
    const { job, worker } = await handOver(bridge, { worktree: true });
    write(job.worktree!.path, 'kept.txt', 'do not lose me\n');
    await bridge.send(worker, { job: 1, kind: 'report', body: 'Done' });
    await bridge.inbox(claude.name);

    clock.advance(DEFAULT_LIMITS.worktreeKeepMs - 60_000);
    await bridge.sweep();
    await bridge.idle();
    expect(existsSync(job.worktree!.path)).toBe(true);

    clock.advance(3_600_000 + 60_000);
    await bridge.sweep();
    await bridge.idle();

    const ref = `${DISCARDED_REFS}/job-1`;
    expect(existsSync(job.worktree!.path)).toBe(false);
    expect(git(repo, 'show', `${ref}:kept.txt`)).toBe('do not lose me');
    expect(git(repo, 'branch', '--list', 'cogitator/*')).toBe('');
    expect((await bridge.job(1)).worktree?.end).toMatchObject({ how: 'discarded', ref });
    const [note] = await bridge.inbox(claude.name);
    expect(note).toMatchObject({ kind: 'note', from: BRIDGE_SENDER });
    expect(note.body).toContain(`look at it with git show ${ref}`);
    expect(errors).toEqual([]);
  });
});

describe('a worktree that cannot be put away as it is', () => {
  const overdue = async (bridge: BridgeDispatcher): Promise<void> => {
    clock.advance(DEFAULT_LIMITS.worktreeKeepMs + 3_600_000);
    await bridge.sweep();
    await bridge.idle();
  };

  it('keeps the commits of its branch when its folder was removed by hand', async () => {
    const bridge = await start();
    const { job, worker } = await handOver(bridge, { worktree: true });
    write(job.worktree!.path, 'kept.txt', 'committed\n');
    git(job.worktree!.path, 'add', '-A');
    git(job.worktree!.path, 'commit', '-q', '-m', 'kept');
    await bridge.send(worker, { job: 1, kind: 'report', body: 'Done' });
    rmSync(job.worktree!.path, { recursive: true, force: true });

    await overdue(bridge);

    const ref = `${DISCARDED_REFS}/job-1`;
    expect(git(repo, 'show', `${ref}:kept.txt`)).toBe('committed');
    expect((await bridge.job(1)).worktree?.end).toMatchObject({ how: 'discarded', ref });
    expect(git(repo, 'branch', '--list', 'cogitator/*')).toBe('');
    expect(errors).toEqual([]);
  });

  it('stays, with its work, when git cannot read it', async () => {
    const bridge = await start();
    const { job, worker } = await handOver(bridge, { worktree: true });
    write(job.worktree!.path, 'kept.txt', 'not committed\n');
    mkdirSync(join(job.worktree!.path, 'nested'));
    git(join(job.worktree!.path, 'nested'), 'init', '-q');
    await bridge.send(worker, { job: 1, kind: 'report', body: 'Done' });

    await overdue(bridge);

    expect(read(job.worktree!.path, 'kept.txt')).toBe('not committed\n');
    expect((await bridge.job(1)).worktree?.end).toBeUndefined();
    expect(errors.map((error) => error.message)).toEqual([
      expect.stringMatching(/^git add failed: /),
      expect.stringMatching(/^The worktree of job 1, .+, could not be put away and stays: /),
    ]);
    errors.length = 0;
  });
});

describe('the checks of a job', () => {
  it('run where the job was done once it is reported on, and the report comes with what they showed', async () => {
    const asked: string[] = [];
    const rights: RightsJudge = ({ ask }) => {
      asked.push(`${ask.command} in ${ask.cwd}`);
      return 'allow';
    };
    const bridge = await start({ rights });
    const { job, worker } = await handOver(bridge, {
      worktree: true,
      checks: [
        { name: 'the burst is there', command: 'test -f src/burst.ts' },
        { command: 'grep -q "limit = 2" limiter.ts', cwd: 'src' },
      ],
    });
    const path = job.worktree!.path;
    expect(codex.sessions[0].firstLetter.text.split('\n').at(-1)).toBe(
      '[agent bridge] When you report, the bridge runs the checks of the job where you worked: `the burst is there`, `grep -q "limit = 2" limiter.ts`.'
    );
    write(path, 'src/limiter.ts', 'export const limit = 2;\n');
    write(path, 'src/burst.ts', 'export const burst = 3;\n');

    const sent = await bridge.send(worker, { job: 1, kind: 'report', body: 'Done' });

    expect(sent.letter.state).toBe('held');
    expect(sent.job).toMatchObject({ state: 'completed', checking: { letter: sent.letter.id } });
    expect(await bridge.inbox(claude.name, { peek: true })).toEqual([]);
    await expect(bridge.accept(claude.name, { job: 1 })).rejects.toThrow(
      expect.objectContaining({ message: expect.stringContaining('The checks of job 1 still run') })
    );
    await bridge.idle();

    const done = await bridge.job(1);
    expect(done.checking).toBeUndefined();
    expect(done.verification).toMatchObject({
      verified: true,
      checks: [
        { name: 'the burst is there', ok: true, code: 0 },
        { name: 'grep -q "limit = 2" limiter.ts', ok: true, code: 0 },
      ],
    });
    expect(asked).toEqual([
      `test -f src/burst.ts in ${path}`,
      `grep -q "limit = 2" limiter.ts in ${join(path, 'src')}`,
    ]);
    const [report] = await bridge.inbox(claude.name);
    const lines = report.text.split('\n');
    expect(lines[1]).toBe('Done');
    expect(lines[2]).toMatch(/^\[agent bridge\] Changed in the worktree of the job/);
    expect(lines[3]).toBe('[agent bridge] Checks. Verified: all 2 checks passed.');
    expect(lines.slice(4)).toEqual([
      expect.stringMatching(/^- passed: the burst is there \(/),
      expect.stringMatching(/^- passed: grep -q "limit = 2" limiter\.ts \(/),
    ]);
    expect((await bridge.readJournal({ job: 1 })).map((entry) => entry.type)).toContain(
      'job.verified'
    );
    expect(errors).toEqual([]);
  });

  it('do not confirm a result when one fails, and say what it printed', async () => {
    const bridge = await start();
    const { worker } = await handOver(bridge, {
      checks: [
        { name: 'ok', command: 'true' },
        { name: 'broken', command: 'echo "1 test failed: limiter" >&2; exit 3' },
      ],
    });

    await bridge.send(worker, { job: 1, kind: 'report', body: 'Done' });
    await bridge.idle();

    expect((await bridge.job(1)).verification).toMatchObject({
      verified: false,
      checks: [
        { name: 'ok', ok: true },
        { name: 'broken', ok: false, code: 3, output: '1 test failed: limiter' },
      ],
    });
    const [report] = await bridge.inbox(claude.name);
    expect(report.text.split('\n').slice(2)).toEqual([
      '[agent bridge] Checks. Not verified: 1 of 2 checks passed.',
      expect.stringMatching(/^- passed: ok \(/),
      expect.stringMatching(/^- failed: broken: exit code 3 \(/),
      'The end of what "broken" printed:',
      '1 test failed: limiter',
    ]);
  });

  it('are run only when the rules of whoever handed the job over allow the command without asking', async () => {
    const rights: RightsJudge = ({ ask }) =>
      ask.command?.startsWith('rm') ? 'deny' : ask.command?.startsWith('curl') ? 'ask' : 'allow';
    const bridge = await start({ rights });
    const { worker } = await handOver(bridge, {
      checks: [
        { command: 'rm -rf build && touch removed' },
        { command: 'curl -s example.com && touch fetched' },
        { command: 'true', cwd: '/' },
        { command: 'true' },
      ],
    });

    await bridge.send(worker, { job: 1, kind: 'report', body: 'Done' });
    await bridge.idle();

    expect(existsSync(join(repo, 'removed'))).toBe(false);
    expect(existsSync(join(repo, 'fetched'))).toBe(false);
    expect((await bridge.job(1)).verification).toMatchObject({ verified: false });
    const [report] = await bridge.inbox(claude.name);
    expect(report.text.split('\n').slice(2)).toEqual([
      '[agent bridge] Checks. Not verified: 1 of 4 checks passed.',
      `- not run: rm -rf build && touch removed: the rules of ${claude.name} forbid the command`,
      `- not run: curl -s example.com && touch fetched: the rules of ${claude.name} do not allow the command without asking. Allow it in the settings of the project, or run it yourself`,
      '- not run: true: it would run in /, outside the project',
      expect.stringMatching(/^- passed: true \(/),
    ]);
  });

  it('end a command that runs too long, with everything it started', async () => {
    const bridge = await start();
    const { worker } = await handOver(bridge, {
      checks: [{ name: 'slow', command: 'sleep 30 & sleep 30', timeoutMs: 300 }],
    });

    const before = Date.now();
    await bridge.send(worker, { job: 1, kind: 'report', body: 'Done' });
    await bridge.idle();

    expect(Date.now() - before).toBeLessThan(10_000);
    expect((await bridge.job(1)).verification).toMatchObject({
      verified: false,
      checks: [{ name: 'slow', ok: false, timedOut: true }],
    });
    const [report] = await bridge.inbox(claude.name);
    expect(report.text).toMatch(/- failed: slow: did not end in time \(/);
  });

  it('run for a job handed over from a linked worktree outside the main checkout', async () => {
    const linked = join(scratch, 'feature');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', linked);
    const bridge = await start();
    const there = await bridge.register({
      harness: 'claude-code',
      sessionId: 'session-feature',
      cwd: linked,
      project: repo,
    });
    const created = await bridge.createJob(there.name, {
      to: 'codex',
      body: 'Check the feature',
      checks: [{ command: 'pwd' }],
    });
    await bridge.idle();
    await bridge.inbox(created.job.to);

    await bridge.send(created.job.to, { job: 1, kind: 'report', body: 'Done' });
    await bridge.idle();

    expect((await bridge.job(1)).verification).toMatchObject({
      verified: true,
      checks: [{ ok: true, output: linked }],
    });
  });

  it('refuses a command with a NUL character when the job is handed over', async () => {
    const bridge = await start();
    await expect(
      bridge.createJob(claude.name, {
        to: 'codex',
        body: 'Anything',
        checks: [{ command: 'true\0false' }],
      })
    ).rejects.toThrow(code('invalid_input'));
  });

  it('are not run for a job that was reported as failed', async () => {
    const bridge = await start();
    const { worker } = await handOver(bridge, { checks: [{ command: 'touch ran' }] });

    const sent = await bridge.send(worker, {
      job: 1,
      kind: 'report',
      outcome: 'failed',
      body: 'Could not do it',
    });
    await bridge.idle();

    expect(sent.letter.state).toBe('queued');
    expect(existsSync(join(repo, 'ran'))).toBe(false);
    expect((await bridge.job(1)).verification).toBeUndefined();
  });

  it('are run again by the next dispatcher when one closed in the middle of them', async () => {
    const first = await start();
    const { worker } = await handOver(first, {
      checks: [{ name: 'gate', command: 'test -f go || sleep 30' }],
    });
    await first.send(worker, { job: 1, kind: 'report', body: 'Done' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await first.close();
    bridges.length = 0;

    expect((await store.tasks.list()).length).toBe(1);
    const second = dispatcher();
    expect((await second.job(1)).checking).toBeDefined();
    expect(await second.inbox(claude.name, { peek: true })).toEqual([]);
    write(repo, 'go', '');

    await second.sweep();
    await second.idle();

    expect((await second.job(1)).verification).toMatchObject({ verified: true });
    const [report] = await second.inbox(claude.name);
    expect(report.text).toContain('[agent bridge] Checks. Verified: the check passed.');
  });
});
