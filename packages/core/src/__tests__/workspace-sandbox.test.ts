import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OsSandbox } from '@cogitator-ai/sandbox';
import {
  CogitatorError,
  ErrorCode,
  WorkspaceError,
  type WorkspaceCommandSandbox,
  type WorkspaceExecResult,
  type WorkspaceLaunch,
} from '@cogitator-ai/types';
import { workspaceTools } from '../tools/workspace-tools';
import { LocalWorkspace, WORKSPACE_TRASH_DIR } from '../workspace/local-workspace';

let base: string;
let root: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-sandbox-')));
  root = join(base, 'project');
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('LocalWorkspace exec.launch', () => {
  it('keeps the old synchronous form that returns a program and arguments', async () => {
    const seen: WorkspaceLaunch[] = [];
    const workspace = new LocalWorkspace({
      root,
      exec: {
        launch: (launch) => {
          seen.push(launch);
          return { file: '/bin/sh', args: ['-c', 'echo wrapped'] };
        },
      },
    });
    const result = await workspace.exec('echo original');
    expect(result.stdout).toBe('wrapped\n');
    expect(seen[0]).toMatchObject({
      file: '/bin/sh',
      args: ['-c', 'echo original'],
      command: 'echo original',
      root: workspace.root,
      request: {},
    });
    await workspace.dispose();
  });

  it('takes an async form with its own environment and a cleanup that reports', async () => {
    const cleanup = vi.fn((result: WorkspaceExecResult | undefined) => ({
      notice: `<note>${result?.exitCode}</note>`,
      sandbox: { sandboxed: true, kind: 'seatbelt' as const, violations: [] },
    }));
    const workspace = new LocalWorkspace({
      root,
      exec: {
        env: { KEPT: 'no' },
        launch: async (launch) => ({
          file: launch.file,
          args: launch.args,
          env: { PATH: launch.env.PATH ?? '', ONLY: 'this' },
          cleanup,
        }),
      },
    });
    const result = await workspace.exec('echo "$ONLY ${KEPT:-gone}" >&2; exit 3');
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe('this gone\n<note>3</note>');
    expect(result.sandbox).toEqual({ sandboxed: true, kind: 'seatbelt', violations: [] });
    expect(cleanup).toHaveBeenCalledTimes(1);
    await workspace.dispose();
  });

  it('returns the output a cleanup gives instead, and feeds extra inputs on descriptor 3', async () => {
    const workspace = new LocalWorkspace({
      root,
      exec: {
        launch: (launch) => ({
          file: launch.file,
          args: launch.args,
          extraInputs: [new TextEncoder().encode('from fd 3')],
          cleanup: (result) => ({
            output: {
              stdout: (result?.stdout ?? '').toUpperCase(),
              stderr: 'rewritten',
            },
            notice: '<n/>',
          }),
        }),
      },
    });
    const result = await workspace.exec('cat <&3; echo raw >&2');
    expect(result.stdout).toBe('FROM FD 3');
    expect(result.stderr).toBe('rewritten\n<n/>');
    await workspace.dispose();
  });

  it('runs the cleanup when the command is aborted, and a failing cleanup loses nothing', async () => {
    const cleanups: Array<WorkspaceExecResult | undefined> = [];
    const workspace = new LocalWorkspace({
      root,
      exec: {
        launch: async (launch) => ({
          ...launch,
          cleanup: (result) => {
            cleanups.push(result);
            if (result) throw new Error('cleanup broke');
          },
        }),
      },
    });
    const controller = new AbortController();
    const running = workspace.exec('sleep 5', { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(running).rejects.toSatisfy((error: unknown) =>
      WorkspaceError.is(error, 'ABORTED')
    );
    expect(cleanups).toEqual([undefined]);
    expect((await workspace.exec('echo fine')).stdout).toBe('fine\n');
    expect(cleanups).toHaveLength(2);
    await workspace.dispose();
  });

  it('passes the sandbox options of a call to the launcher', async () => {
    const seen: WorkspaceLaunch[] = [];
    const decider = async () => true;
    const workspace = new LocalWorkspace({
      root,
      exec: {
        launch: async (launch) => {
          seen.push(launch);
          return launch;
        },
      },
    });
    await workspace.exec('true', {
      dangerouslyDisableSandbox: true,
      allowedDomains: ['example.com'],
      onUnknownHost: decider,
    });
    expect(seen[0].request).toEqual({
      dangerouslyDisableSandbox: true,
      allowedDomains: ['example.com'],
      onUnknownHost: decider,
    });
    await workspace.dispose();
  });
});

describe('LocalWorkspace exec.sandbox', () => {
  const fake = (start: () => Promise<void> = async () => undefined): WorkspaceCommandSandbox => ({
    kind: 'bubblewrap',
    autoAllow: true,
    acceptsCommandDomains: true,
    route: async () => ({ sandboxed: true }),
    start,
    launch: async (launch) => ({ file: launch.file, args: launch.args }),
  });

  it('is the workspace sandbox, shared by withRoot and withCwd', async () => {
    const sandbox = fake();
    const workspace = new LocalWorkspace({ root, exec: { sandbox } });
    expect(workspace.sandbox).toBe(sandbox);
    expect(workspace.withCwd('.').sandbox).toBe(sandbox);
    expect(workspace.withRoot(base).sandbox).toBe(sandbox);
    expect(new LocalWorkspace({ root }).sandbox).toBeUndefined();
  });

  it('refuses both a launch hook and a sandbox', () => {
    expect(
      () =>
        new LocalWorkspace({
          root,
          exec: { sandbox: fake(), launch: (launch) => launch },
        })
    ).toThrow(RangeError);
  });

  it('fails to start with UNAVAILABLE, caused by SANDBOX_UNAVAILABLE, when the sandbox cannot run', async () => {
    const workspace = new LocalWorkspace({
      root,
      exec: {
        sandbox: fake(async () => {
          throw new CogitatorError({
            message: 'The OS sandbox cannot run here: no bwrap',
            code: ErrorCode.SANDBOX_UNAVAILABLE,
          });
        }),
      },
    });
    const error = await workspace.start().catch((caught: unknown) => caught);
    expect(WorkspaceError.is(error, 'UNAVAILABLE')).toBe(true);
    expect((error as WorkspaceError).cause).toMatchObject({ code: ErrorCode.SANDBOX_UNAVAILABLE });
    await expect(workspace.exec('true')).rejects.toSatisfy((caught: unknown) =>
      WorkspaceError.is(caught, 'UNAVAILABLE')
    );
  });
});

describe('the trash of a LocalWorkspace', () => {
  let workspace: LocalWorkspace;

  beforeEach(async () => {
    workspace = new LocalWorkspace({ root });
    mkdirSync(join(root, 'src', 'deep'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'a');
    writeFileSync(join(root, 'src', 'deep', 'b.ts'), 'bb');
    await workspace.start();
  });

  afterEach(async () => {
    await workspace.dispose();
  });

  it('lists what was trashed, oldest first, with where it came from', async () => {
    const first = await workspace.remove('src/a.ts', { trash: true });
    const second = await workspace.remove('src/deep', { trash: true, recursive: true });
    const entries = await workspace.listTrash();
    expect(entries.map((entry) => [entry.path, entry.type, entry.size])).toEqual([
      ['src/a.ts', 'file', 1],
      ['src/deep', 'directory', 2],
    ]);
    expect(entries[0].trashedTo).toBe(first.trashedTo);
    expect(entries[1].trashedTo).toBe(second.trashedTo);
    expect(entries[0].trashedAt).toBeLessThanOrEqual(entries[1].trashedAt);
  });

  it('restores an entry where it was, refusing to overwrite unless told', async () => {
    await workspace.remove('src/a.ts', { trash: true });
    const [entry] = await workspace.listTrash();
    writeFileSync(join(root, 'src', 'a.ts'), 'new');
    await expect(workspace.restoreFromTrash(entry.id)).rejects.toSatisfy((error: unknown) =>
      WorkspaceError.is(error, 'EXISTS')
    );
    expect(await workspace.restoreFromTrash(entry.id, { overwrite: true })).toEqual({
      path: 'src/a.ts',
    });
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('a');
    expect(await workspace.listTrash()).toEqual([]);
    expect(existsSync(join(root, WORKSPACE_TRASH_DIR, entry.id))).toBe(false);
    expect(existsSync(join(root, WORKSPACE_TRASH_DIR, `${entry.id}.json`))).toBe(false);
  });

  it('restores to another place and creates the parents', async () => {
    await workspace.remove('src/deep', { trash: true, recursive: true });
    const [entry] = await workspace.listTrash();
    expect(await workspace.restoreFromTrash(entry.id, { to: 'restored/deep' })).toEqual({
      path: 'restored/deep',
    });
    expect(readFileSync(join(root, 'restored', 'deep', 'b.ts'), 'utf8')).toBe('bb');
  });

  it('refuses an id the trash does not hold, and odd ids', async () => {
    for (const id of ['nope', '../src', '']) {
      await expect(workspace.restoreFromTrash(id)).rejects.toSatisfy((error: unknown) =>
        WorkspaceError.is(error, 'NOT_FOUND')
      );
    }
  });

  it('lists an entry trashed without a record by the path under its folder', async () => {
    const legacy = join(
      root,
      WORKSPACE_TRASH_DIR,
      '2026-01-02T03-04-05-678Z-abc123',
      'old',
      'x.txt'
    );
    mkdirSync(join(legacy, '..'), { recursive: true });
    writeFileSync(legacy, 'old');
    const [entry] = await workspace.listTrash();
    expect(entry).toMatchObject({
      id: '2026-01-02T03-04-05-678Z-abc123',
      path: 'old/x.txt',
      trashedAt: Date.parse('2026-01-02T03:04:05.678Z'),
    });
    await workspace.restoreFromTrash(entry.id);
    expect(readFileSync(join(root, 'old', 'x.txt'), 'utf8')).toBe('old');
  });

  it('empties the trash, or only what was trashed long enough ago', async () => {
    await workspace.remove('src/a.ts', { trash: true });
    expect(await workspace.emptyTrash({ olderThan: 60_000 })).toEqual({ deleted: [] });
    const [entry] = await workspace.listTrash();
    expect(await workspace.emptyTrash()).toEqual({ deleted: [entry.id] });
    expect(await workspace.listTrash()).toEqual([]);
    await expect(workspace.emptyTrash({ olderThan: -1 })).rejects.toThrow(RangeError);
  });

  it('empties folders whose entry is gone and records without a folder too', async () => {
    await workspace.remove('src/a.ts', { trash: true });
    const [entry] = await workspace.listTrash();
    rmSync(join(root, WORKSPACE_TRASH_DIR, entry.id, 'src', 'a.ts'));
    const record = '2026-01-02T03-04-05-678Z-zzz999';
    writeFileSync(
      join(root, WORKSPACE_TRASH_DIR, `${record}.json`),
      JSON.stringify({ version: 1, path: 'gone.txt', trashedAt: Date.now(), type: 'file' })
    );
    expect(await workspace.listTrash()).toEqual([]);
    expect(await workspace.emptyTrash({ olderThan: 60_000 })).toEqual({ deleted: [] });
    expect(existsSync(join(root, WORKSPACE_TRASH_DIR, entry.id))).toBe(true);
    expect(await workspace.emptyTrash()).toEqual({ deleted: [] });
    expect(existsSync(join(root, WORKSPACE_TRASH_DIR, entry.id))).toBe(false);
    expect(existsSync(join(root, WORKSPACE_TRASH_DIR, `${entry.id}.json`))).toBe(false);
    expect(existsSync(join(root, WORKSPACE_TRASH_DIR, `${record}.json`))).toBe(false);
  });

  it('refuses to trash the trash or what it holds', async () => {
    await workspace.remove('src/a.ts', { trash: true });
    const [entry] = await workspace.listTrash();
    for (const path of [WORKSPACE_TRASH_DIR, entry.trashedTo]) {
      await expect(workspace.remove(path, { trash: true, recursive: true })).rejects.toSatisfy(
        (error: unknown) => WorkspaceError.is(error, 'INVALID_PATH')
      );
    }
    expect((await workspace.listTrash()).map((listed) => listed.id)).toEqual([entry.id]);
  });

  it('never lists or restores an entry reached through a symlink in its folder', async () => {
    const outside = join(base, 'outside');
    mkdirSync(join(outside, 'k'), { recursive: true });
    writeFileSync(join(outside, 'k', 'big.bin'), 'x'.repeat(1000));
    const id = '2026-01-02T03-04-05-678Z-sym111';
    mkdirSync(join(root, WORKSPACE_TRASH_DIR, id), { recursive: true });
    symlinkSync(outside, join(root, WORKSPACE_TRASH_DIR, id, 'a'));
    writeFileSync(
      join(root, WORKSPACE_TRASH_DIR, `${id}.json`),
      JSON.stringify({ version: 1, path: 'a/k', trashedAt: Date.now(), type: 'directory' })
    );
    expect(await workspace.listTrash()).toEqual([]);
    await expect(workspace.restoreFromTrash(id)).rejects.toSatisfy((error: unknown) =>
      WorkspaceError.is(error, 'NOT_FOUND')
    );
    await workspace.emptyTrash();
    expect(existsSync(join(outside, 'k', 'big.bin'))).toBe(true);
    expect(existsSync(join(root, WORKSPACE_TRASH_DIR, id))).toBe(false);
  });

  it('refuses to empty the trash while a command runs', async () => {
    await workspace.remove('src/a.ts', { trash: true });
    const running = workspace.exec('sleep 0.5');
    await new Promise((done) => setTimeout(done, 50));
    await expect(workspace.emptyTrash()).rejects.toSatisfy((error: unknown) =>
      WorkspaceError.is(error, 'BUSY')
    );
    await running;
  });
});

describe('the delete_file tool', () => {
  it('moves what it deletes to the trash, a directory only with recursive', async () => {
    const workspace = new LocalWorkspace({ root });
    mkdirSync(join(root, 'dir'));
    writeFileSync(join(root, 'dir', 'f.txt'), 'f');
    const [deleteFile] = workspaceTools(workspace, { tools: ['delete_file'] });
    const context = { agentId: 'a', runId: 'r', signal: new AbortController().signal };
    await expect(deleteFile.execute({ path: 'dir' }, context)).rejects.toThrow(/recursive/);
    const result = await deleteFile.execute({ path: 'dir', recursive: true }, context);
    expect(result).toMatchObject({ path: 'dir', recoverable: true });
    expect(existsSync(join(root, 'dir'))).toBe(false);
    expect((await workspace.listTrash())[0].path).toBe('dir');
    await workspace.dispose();
  });
});

const probe = await OsSandbox.probe();

describe.skipIf(!probe.available)(`a LocalWorkspace with an OsSandbox (${probe.kind})`, () => {
  it('runs run_command confined, reporting what the sandbox refused', async () => {
    const sandbox = new OsSandbox({ onWarning: () => undefined });
    const workspace = new LocalWorkspace({ root, exec: { sandbox } });
    await workspace.start();
    const [runCommand] = workspaceTools(workspace, { tools: ['run_command'] });
    const context = { agentId: 'a', runId: 'r', signal: new AbortController().signal };
    const result = (await runCommand.execute(
      { command: `echo in > in.txt; echo out > ${join(base, 'out.txt')}` },
      context
    )) as WorkspaceExecResult & { command: string };
    expect(readFileSync(join(root, 'in.txt'), 'utf8')).toBe('in\n');
    expect(existsSync(join(base, 'out.txt'))).toBe(false);
    expect(result.sandbox?.sandboxed).toBe(true);
    expect(result.stderr).toContain('<sandbox_violations>');
    await workspace.dispose();
    await sandbox.dispose();
  });
});
