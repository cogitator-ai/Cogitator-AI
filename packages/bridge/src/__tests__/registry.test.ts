import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  allocateAgentName,
  aliasOfHarness,
  callerFromEnv,
  harnessOfAlias,
  projectLabel,
  resolveAddress,
} from '../registry';
import { bridgePaths, findCheckoutRoot, findProjectRoot, isInside } from '../paths';
import { SqliteBridgeStore } from '../store/sqlite';
import { agentRecord, at, tempDir } from './helpers';

describe('harness names', () => {
  it('reads claude as claude-code and leaves other words alone', () => {
    expect(harnessOfAlias('claude')).toBe('claude-code');
    expect(harnessOfAlias(' Claude ')).toBe('claude-code');
    expect(harnessOfAlias('codex')).toBe('codex');
    expect(harnessOfAlias('gemini')).toBe('gemini');
    expect(aliasOfHarness('claude-code')).toBe('claude');
    expect(aliasOfHarness('codex')).toBe('codex');
  });

  it('makes a project folder safe for an agent name', () => {
    expect(projectLabel('/work/Cogitator')).toBe('Cogitator');
    expect(projectLabel('/work/my app@home:1')).toBe('my-app-home-1');
    expect(projectLabel('/')).toBe('project');
  });
});

describe('callerFromEnv', () => {
  let dir: string;
  let remove: () => void;

  beforeEach(() => {
    ({ dir, remove } = tempDir());
    mkdirSync(join(dir, '.git'));
    mkdirSync(join(dir, 'packages', 'a'), { recursive: true });
  });

  afterEach(() => remove());

  it('finds no caller in a shell that no harness started', () => {
    expect(callerFromEnv({ PATH: '/bin' }, dir)).toBeUndefined();
  });

  it('reads a Claude Code session and the project its folder is in', () => {
    expect(callerFromEnv({ CLAUDE_CODE_SESSION_ID: 'abc' }, join(dir, 'packages', 'a'))).toEqual({
      harness: 'claude-code',
      sessionId: 'abc',
      cwd: join(dir, 'packages', 'a'),
      project: dir,
    });
  });

  it('reads a Codex thread, the name the bridge gave it and what the person calls it', () => {
    expect(
      callerFromEnv(
        {
          CODEX_THREAD_ID: ' t1 ',
          COGITATOR_BRIDGE_AGENT: 'codex-2@demo',
          COGITATOR_BRIDGE_SESSION_NAME: 'Reviewer',
        },
        dir
      )
    ).toMatchObject({
      harness: 'codex',
      sessionId: 't1',
      agentName: 'codex-2@demo',
      sessionName: 'Reviewer',
    });
  });

  it('refuses to guess when one session runs inside another', () => {
    const env = { CLAUDE_CODE_SESSION_ID: 'abc', CODEX_THREAD_ID: 't1' };

    expect(() => callerFromEnv(env, dir)).toThrow(/COGITATOR_BRIDGE_HARNESS/);
    expect(callerFromEnv({ ...env, COGITATOR_BRIDGE_HARNESS: 'codex' }, dir)).toMatchObject({
      harness: 'codex',
      sessionId: 't1',
    });
    expect(callerFromEnv({ ...env, COGITATOR_BRIDGE_HARNESS: 'claude' }, dir)).toMatchObject({
      harness: 'claude-code',
      sessionId: 'abc',
    });
  });

  it('refuses a harness the environment has no session of', () => {
    expect(() =>
      callerFromEnv({ CODEX_THREAD_ID: 't1', COGITATOR_BRIDGE_HARNESS: 'claude' }, dir)
    ).toThrow(/no session id of that harness/);
  });
});

describe('findProjectRoot', () => {
  let dir: string;
  let remove: () => void;

  beforeEach(() => {
    ({ dir, remove } = tempDir());
  });

  afterEach(() => remove());

  it('is the nearest folder up the tree with a .git', () => {
    mkdirSync(join(dir, 'repo', '.git'), { recursive: true });
    mkdirSync(join(dir, 'repo', 'src', 'deep'), { recursive: true });

    expect(findProjectRoot(join(dir, 'repo', 'src', 'deep'))).toBe(join(dir, 'repo'));
    expect(findProjectRoot(join(dir, 'repo'))).toBe(join(dir, 'repo'));
  });

  it('is the main checkout for a linked worktree, so every worktree is one project', () => {
    const main = join(dir, 'repo');
    const worktree = join(dir, 'trees', 'feature');
    mkdirSync(join(main, '.git', 'worktrees', 'feature'), { recursive: true });
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(
      join(worktree, '.git'),
      `gitdir: ${join(main, '.git', 'worktrees', 'feature')}\n`
    );
    writeFileSync(
      join(main, '.git', 'worktrees', 'feature', 'gitdir'),
      `${join(worktree, '.git')}\n`
    );

    expect(findProjectRoot(join(worktree, 'src'))).toBe(main);
  });

  it('knows the checkout a folder is in apart from the project: the worktree itself', () => {
    const main = join(dir, 'repo');
    const worktree = join(dir, 'trees', 'feature');
    mkdirSync(join(main, '.git', 'worktrees', 'feature'), { recursive: true });
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(
      join(worktree, '.git'),
      `gitdir: ${join(main, '.git', 'worktrees', 'feature')}\n`
    );

    expect(findCheckoutRoot(join(worktree, 'src'))).toBe(worktree);
    expect(findCheckoutRoot(main)).toBe(main);
  });

  it('does not let a folder join a project that does not name it as its worktree', () => {
    const main = join(dir, 'repo');
    const stranger = join(dir, 'stranger');
    mkdirSync(join(main, '.git', 'worktrees', 'feature'), { recursive: true });
    mkdirSync(stranger, { recursive: true });
    writeFileSync(
      join(stranger, '.git'),
      `gitdir: ${join(main, '.git', 'worktrees', 'feature')}\n`
    );

    expect(findProjectRoot(stranger)).toBe(stranger);
    writeFileSync(join(main, '.git', 'worktrees', 'feature', 'gitdir'), '/somewhere/else/.git\n');
    expect(findProjectRoot(stranger)).toBe(stranger);
  });

  it('reads no .git that is not a small plain file', () => {
    const outside = findProjectRoot(dir);
    const big = join(dir, 'big');
    const linked = join(dir, 'linked');
    mkdirSync(big);
    mkdirSync(linked);
    writeFileSync(join(big, '.git'), `gitdir: ${'x'.repeat(10_000)}`);
    if (process.platform !== 'win32') symlinkSync('/dev/zero', join(linked, '.git'));

    expect([big, outside]).toContain(findProjectRoot(big));
    expect([linked, outside]).toContain(findProjectRoot(linked));
  });

  it('is the folder itself for a submodule, whose .git file points elsewhere', () => {
    const sub = join(dir, 'repo', 'vendor', 'lib');
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(dir, 'repo', '.git', 'modules', 'lib'), { recursive: true });
    writeFileSync(join(sub, '.git'), 'gitdir: ../../.git/modules/lib\n');

    expect(findProjectRoot(sub)).toBe(sub);
  });

  it('is the folder itself outside any repository', () => {
    const plain = join(dir, 'plain', 'folder');
    mkdirSync(plain, { recursive: true });
    const root = findProjectRoot(plain);

    expect([plain, findProjectRoot(dir)]).toContain(root);
  });
});

describe('folders', () => {
  it('tells what lies inside a folder, a name that only starts with two dots included', () => {
    expect(isInside('/work/app', '/work/app')).toBe(true);
    expect(isInside('/work/app', '/work/app/packages/a')).toBe(true);
    expect(isInside('/work/app', '/work/app/..cache/x')).toBe(true);
    expect(isInside('/work/app', '/work/app-wt')).toBe(false);
    expect(isInside('/work/app', '/work')).toBe(false);
    expect(isInside('/work/app', '/etc')).toBe(false);
  });
});

describe('bridgePaths', () => {
  it('puts the files in the home, or where COGITATOR_BRIDGE_HOME says', () => {
    const fromEnv = bridgePaths({ env: { COGITATOR_BRIDGE_HOME: '/tmp/b' }, platform: 'linux' });
    expect(fromEnv).toEqual({
      home: '/tmp/b',
      database: '/tmp/b/bridge.db',
      socket: '/tmp/b/bridge.sock',
    });

    const byDefault = bridgePaths({ env: {}, platform: 'darwin' });
    expect(byDefault.home.endsWith(join('.cogitator', 'bridge'))).toBe(true);
    expect(bridgePaths({ home: '/x', env: { COGITATOR_BRIDGE_HOME: '/tmp/b' } }).home).toBe('/x');
  });

  it('uses a named pipe on Windows, one per user and home', () => {
    const first = bridgePaths({ home: '/a', platform: 'win32' });
    const second = bridgePaths({ home: '/b', platform: 'win32' });

    expect(first.socket).toMatch(/^\\\\\.\\pipe\\cogitator-bridge-[0-9a-f]{16}$/);
    expect(second.socket).not.toBe(first.socket);
  });

  it('refuses a home whose socket path a unix socket cannot hold', () => {
    expect(() => bridgePaths({ home: `/tmp/${'x'.repeat(120)}`, platform: 'darwin' })).toThrow(
      /too long/
    );
  });
});

describe('address book', () => {
  let store: SqliteBridgeStore;
  const context = { project: '/work/demo', caller: 'claude@demo', canSpawn: () => false };

  beforeEach(async () => {
    store = await SqliteBridgeStore.open(':memory:');
    store.putAgent(agentRecord());
  });

  afterEach(() => store.close());

  const addCodex = (
    name: string,
    sessionId: string,
    extra: Parameters<typeof agentRecord>[0] = {}
  ) => store.putAgent(agentRecord({ name, harness: 'codex', sessionId, ...extra }));

  it('gives names nobody has: codex@demo, codex-2@demo', () => {
    expect(allocateAgentName(store, 'codex', '/work/demo')).toBe('codex@demo');
    addCodex('codex@demo', 't1');
    expect(allocateAgentName(store, 'codex', '/work/demo')).toBe('codex-2@demo');
    expect(allocateAgentName(store, 'claude-code', '/elsewhere/demo')).toBe('claude-2@demo');
  });

  it('reaches the only session of a harness in the project', () => {
    addCodex('codex@demo', 't1');
    addCodex('codex@other', 't2', { project: '/work/other' });

    expect(resolveAddress(store, 'codex', context)).toMatchObject({
      kind: 'agent',
      agent: { name: 'codex@demo' },
    });
  });

  it('never reaches the caller itself, and asks to start a session instead', () => {
    expect(() => resolveAddress(store, 'claude', context)).toThrow(/cannot start one/);
    expect(resolveAddress(store, 'claude', { ...context, canSpawn: () => true })).toEqual({
      kind: 'spawn',
      harness: 'claude-code',
    });
    expect(() => resolveAddress(store, 'claude@demo', context)).toThrow(/itself/);
  });

  it('asks which one when several sessions fit, naming them', () => {
    addCodex('codex@demo', 't1', { sessionName: 'Reviewer' });
    addCodex('codex-2@demo', 't2', { registeredAt: at(1_000) });

    expect(() => resolveAddress(store, 'codex', context)).toThrow(
      /codex@demo \("Reviewer"\), codex-2@demo.*codex:new/s
    );
    expect(() => resolveAddress(store, 'codex', context)).toThrow(
      expect.objectContaining({ code: 'ambiguous_agent' })
    );
  });

  it('picks a session by its name, its id or the start of either', () => {
    addCodex('codex@demo', 'thread-aaaa1111', { sessionName: 'Reviewer' });
    addCodex('codex-2@demo', 'thread-bbbb2222', { sessionName: 'Rate limiter' });
    const name = (address: string) => {
      const resolution = resolveAddress(store, address, context);
      return resolution.kind === 'agent' ? resolution.agent.name : resolution.kind;
    };

    expect(name('codex:reviewer')).toBe('codex@demo');
    expect(name('codex:rate')).toBe('codex-2@demo');
    expect(name('codex:thread-bbbb2222')).toBe('codex-2@demo');
    expect(() => name('codex:thread-')).toThrow(
      expect.objectContaining({ code: 'ambiguous_agent' })
    );
    expect(() => name('codex:r')).toThrow(expect.objectContaining({ code: 'ambiguous_agent' }));
    expect(name('codex-2@demo')).toBe('codex-2@demo');
  });

  it('starts a session when none fits, named as asked, or says it cannot', () => {
    addCodex('codex@demo', 't1', { sessionName: 'Reviewer' });
    const spawning = { ...context, canSpawn: (harness: string) => harness === 'codex' };

    expect(resolveAddress(store, 'codex:new', spawning)).toEqual({
      kind: 'spawn',
      harness: 'codex',
    });
    expect(resolveAddress(store, 'codex:tests', spawning)).toEqual({
      kind: 'spawn',
      harness: 'codex',
      sessionName: 'tests',
    });
    expect(() => resolveAddress(store, 'codex:tests', context)).toThrow(
      expect.objectContaining({ code: 'no_session' })
    );
    expect(() => resolveAddress(store, 'gemini', spawning)).toThrow(
      expect.objectContaining({ code: 'no_session' })
    );
  });

  it('does not reach a session that is gone, and treats one that is starting as there', () => {
    addCodex('codex@demo', 't1', { status: 'gone' });
    expect(() => resolveAddress(store, 'codex', context)).toThrow(
      expect.objectContaining({ code: 'no_session' })
    );
    expect(() => resolveAddress(store, 'codex@demo', context)).toThrow(
      expect.objectContaining({ code: 'unknown_agent' })
    );

    addCodex('codex-2@demo', '', { status: 'starting' });
    expect(resolveAddress(store, 'codex', context)).toMatchObject({
      agent: { name: 'codex-2@demo' },
    });
  });

  it('takes any name a session may have, except one that would read as an option', () => {
    const spawning = { ...context, canSpawn: () => true };
    const invalid = expect.objectContaining({ code: 'invalid_input' });
    addCodex('codex@demo', 't1', { sessionName: 'fix: login (#12)' });

    expect(resolveAddress(store, 'codex:fix: login (#12)', spawning)).toMatchObject({
      kind: 'agent',
      agent: { name: 'codex@demo' },
    });
    expect(resolveAddress(store, 'codex:Rate limiter 2', spawning)).toMatchObject({
      sessionName: 'Rate limiter 2',
    });
    expect(() => resolveAddress(store, 'codex:--dangerous-flag', spawning)).toThrow(invalid);
    expect(() => resolveAddress(store, 'codex:-x', spawning)).toThrow(/does not start with "-"/);
  });

  it('refuses an empty address and one with nothing after the colon', () => {
    expect(() => resolveAddress(store, '  ', context)).toThrow(
      expect.objectContaining({ code: 'invalid_input' })
    );
    expect(() => resolveAddress(store, 'codex:', context)).toThrow(
      expect.objectContaining({ code: 'invalid_input' })
    );
    expect(() => resolveAddress(store, 'nobody@demo', context)).toThrow(
      expect.objectContaining({ code: 'unknown_agent' })
    );
  });
});
