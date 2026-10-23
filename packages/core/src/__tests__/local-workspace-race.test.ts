import {
  existsSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceError } from '@cogitator-ai/types';

const hooks = vi.hoisted(() => ({
  beforeOpen: undefined as undefined | ((path: string) => void),
  beforeRename: undefined as undefined | ((from: string, to: string, call: number) => boolean),
  renames: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      const hook = hooks.beforeOpen;
      hooks.beforeOpen = undefined;
      hook?.(String(args[0]));
      return actual.open(...args);
    },
    rename: (from: string, to: string) => {
      hooks.renames++;
      if (hooks.beforeRename?.(from, to, hooks.renames)) hooks.beforeRename = undefined;
      return actual.rename(from, to);
    },
  };
});

const { LocalWorkspace } = await import('../workspace/local-workspace');

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-race-')));
  root = join(base, 'root');
  outside = join(base, 'outside');
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, 'docs', 'notes.md'), 'inside');
  writeFileSync(join(outside, 'notes.md'), 'outside secret');
});

afterEach(() => {
  hooks.beforeOpen = undefined;
  hooks.beforeRename = undefined;
  hooks.renames = 0;
  rmSync(base, { recursive: true, force: true });
});

async function refusal(promise: Promise<unknown>): Promise<WorkspaceError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason
  );
  expect(error).toBeInstanceOf(WorkspaceError);
  return error as WorkspaceError;
}

describe('LocalWorkspace races between the check and the open', () => {
  it('refuses a file swapped for a symlink to outside after the check', async () => {
    const workspace = new LocalWorkspace({ root });
    await workspace.start();
    hooks.beforeOpen = (path) => {
      rmSync(path);
      symlinkSync(join(outside, 'notes.md'), path);
    };
    const error = await refusal(workspace.read('docs/notes.md'));
    expect(error.code).toBe('OUTSIDE_ROOT');
  });

  it('refuses a parent directory swapped for a symlink to outside after the check', async () => {
    const workspace = new LocalWorkspace({ root });
    await workspace.start();
    hooks.beforeOpen = () => {
      renameSync(join(root, 'docs'), join(root, 'docs-moved'));
      symlinkSync(outside, join(root, 'docs'));
    };
    const error = await refusal(workspace.read('docs/notes.md'));
    expect(error.code).toBe('OUTSIDE_ROOT');
  });

  it('writes nothing outside when a parent directory is swapped before a write', async () => {
    const workspace = new LocalWorkspace({ root });
    await workspace.start();
    hooks.beforeOpen = () => {
      renameSync(join(root, 'docs'), join(root, 'docs-moved'));
      symlinkSync(outside, join(root, 'docs'));
    };
    const error = await refusal(workspace.write('docs/notes.md', 'overwritten'));
    expect(error.code).toBe('OUTSIDE_ROOT');
    expect(readFileSync(join(outside, 'notes.md'), 'utf8')).toBe('outside secret');
    expect(readdirSync(outside)).toEqual(['notes.md']);
  });

  const swapDocs = () => {
    renameSync(join(root, 'docs'), join(root, 'docs-moved'));
    symlinkSync(outside, join(root, 'docs'));
    return true;
  };

  it('deletes nothing outside when a parent is swapped right before a remove', async () => {
    const workspace = new LocalWorkspace({ root });
    await workspace.start();
    hooks.beforeRename = swapDocs;
    const error = await refusal(workspace.remove('docs/notes.md'));
    expect(error.code).toBe('OUTSIDE_ROOT');
    expect(readFileSync(join(outside, 'notes.md'), 'utf8')).toBe('outside secret');
    expect(readFileSync(join(root, 'docs-moved', 'notes.md'), 'utf8')).toBe('inside');
  });

  it('pulls nothing in when a parent is swapped right before a rename', async () => {
    const workspace = new LocalWorkspace({ root });
    await workspace.start();
    hooks.beforeRename = swapDocs;
    const error = await refusal(workspace.rename('docs/notes.md', 'stolen.md'));
    expect(error.code).toBe('OUTSIDE_ROOT');
    expect(readFileSync(join(outside, 'notes.md'), 'utf8')).toBe('outside secret');
    expect(existsSync(join(root, 'stolen.md'))).toBe(false);
  });

  it('pushes nothing out when the target directory is swapped right before a rename lands', async () => {
    const workspace = new LocalWorkspace({ root });
    await workspace.start();
    await workspace.write('secret-inside.md', 'keep me in');
    mkdirSync(join(root, 'dest'));
    hooks.beforeRename = (_from, to) => {
      if (!to.endsWith(join('dest', 'secret-inside.md'))) return false;
      renameSync(join(root, 'dest'), join(root, 'dest-moved'));
      symlinkSync(outside, join(root, 'dest'));
      return true;
    };
    const error = await refusal(workspace.rename('secret-inside.md', 'dest/secret-inside.md'));
    expect(error.code).toBe('OUTSIDE_ROOT');
    expect(existsSync(join(outside, 'secret-inside.md'))).toBe(false);
    expect(readFileSync(join(root, 'secret-inside.md'), 'utf8')).toBe('keep me in');
  });
});
