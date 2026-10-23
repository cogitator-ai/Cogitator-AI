import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Tool } from '@cogitator-ai/types';
import { LocalWorkspace } from '../workspace/local-workspace';
import { workspaceTools, WORKSPACE_TOOL_NAMES } from '../tools/workspace-tools';
import { globMatcher } from '../workspace/glob';
import { createToolContext } from './helpers/tool-context';

let base: string;
let workspace: LocalWorkspace;
let tools: Map<string, Tool>;

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-tools-')));
  workspace = new LocalWorkspace({ root: join(base, 'root') });
  await workspace.start();
  tools = new Map(workspaceTools().map((t) => [t.name, t]));
});

afterEach(async () => {
  await workspace.dispose();
  rmSync(base, { recursive: true, force: true });
});

function run(name: string, args: Record<string, unknown>): Promise<unknown> {
  const found = tools.get(name);
  if (!found) throw new Error(`no tool ${name}`);
  return found.execute(found.parameters.parse(args), createToolContext({ workspace }));
}

async function failure(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason
  );
  expect(error).toBeInstanceOf(Error);
  return (error as Error).message;
}

describe('workspaceTools', () => {
  it('has the documented tools, exec the only one asking for approval by default', () => {
    expect([...tools.keys()]).toEqual([...WORKSPACE_TOOL_NAMES]);
    expect([...tools.values()].filter((t) => t.requiresApproval).map((t) => t.name)).toEqual([
      'exec',
    ]);
    const strict = workspaceTools(workspace, { requireApproval: (name) => name !== 'read_file' });
    expect(strict.filter((t) => !t.requiresApproval).map((t) => t.name)).toEqual(['read_file']);
  });

  it('fails clearly without a workspace, and uses the one it was given over the context', async () => {
    const [readFile] = workspaceTools();
    const message = await failure(readFile.execute({ path: 'a.txt' }, createToolContext()));
    expect(message).toContain('No workspace');

    await workspace.write('a.txt', 'from the bound workspace');
    const other = new LocalWorkspace({ root: join(base, 'other') });
    const [bound] = workspaceTools(workspace);
    const result = await bound.execute({ path: 'a.txt' }, createToolContext({ workspace: other }));
    expect(result).toMatchObject({ content: 'from the bound workspace' });
    await other.dispose();
  });

  it('writes, reads by line range and pages with nextOffset', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(await run('write_file', { path: 'notes/a.txt', content: lines })).toMatchObject({
      created: true,
    });
    expect(await run('write_file', { path: 'notes/a.txt', content: lines })).toMatchObject({
      created: false,
    });
    expect(await run('read_file', { path: 'notes/a.txt', offset: 3, limit: 2 })).toEqual({
      path: 'notes/a.txt',
      content: 'line 3\nline 4',
      startLine: 3,
      endLine: 4,
      totalLines: 10,
      nextOffset: 5,
    });
    const rest = await run('read_file', { path: 'notes/a.txt', offset: 9 });
    expect(rest).toMatchObject({ content: 'line 9\nline 10', endLine: 10 });
    expect(rest).not.toHaveProperty('nextOffset');
    expect(await failure(run('read_file', { path: 'notes/a.txt', offset: 50 }))).toContain(
      'past the end'
    );
  });

  it('refuses binary files and paths outside the workspace', async () => {
    await workspace.write('image.bin', new Uint8Array([137, 80, 0, 1]));
    expect(await failure(run('read_file', { path: 'image.bin' }))).toContain('binary');
    expect(await failure(run('read_file', { path: '../secret' }))).toContain('outside');
  });

  it('edits only a unique occurrence unless told to replace all', async () => {
    await workspace.write('code.ts', 'const a = 1;\nconst b = 1;\n');
    expect(
      await failure(run('edit_file', { path: 'code.ts', oldString: '= 1', newString: '= 2' }))
    ).toContain('appears 2 times');
    expect(
      await failure(run('edit_file', { path: 'code.ts', oldString: 'nope', newString: 'x' }))
    ).toContain('not found');

    await run('edit_file', {
      path: 'code.ts',
      oldString: 'const a = 1',
      newString: 'const a = $&2',
    });
    expect(await workspace.read('code.ts')).toBe('const a = $&2;\nconst b = 1;\n');

    expect(
      await run('edit_file', {
        path: 'code.ts',
        oldString: 'const',
        newString: 'let',
        replaceAll: true,
      })
    ).toEqual({ path: 'code.ts', replacements: 2 });
    expect(await workspace.read('code.ts')).toBe('let a = $&2;\nlet b = 1;\n');
  });

  it('lists, globs and skips dependency folders', async () => {
    await workspace.write('src/a.ts', '');
    await workspace.write('src/deep/b.ts', '');
    await workspace.write('src/c.md', '');
    await workspace.write('node_modules/x/index.ts', '');

    expect(await run('list_files', { path: 'src' })).toMatchObject({
      entries: [
        { path: 'src/a.ts', type: 'file' },
        { path: 'src/c.md', type: 'file' },
        { path: 'src/deep', type: 'directory' },
      ],
      truncated: false,
    });
    expect(await run('glob', { pattern: '**/*.ts' })).toEqual({
      pattern: '**/*.ts',
      files: ['src/a.ts', 'src/deep/b.ts'],
      count: 2,
      truncated: false,
    });
    expect(await run('glob', { pattern: '*.ts', path: 'src' })).toMatchObject({
      files: ['src/a.ts'],
    });
  });

  it('greps text files, skipping binary and oversized ones, within its match cap', async () => {
    await workspace.write('a.txt', 'alpha\nTODO first\nbeta\nTODO second\n');
    await workspace.write('b.ts', 'todo lower\n');
    await workspace.write('c.bin', new Uint8Array([84, 79, 68, 79, 0]));
    writeFileSync(join(workspace.root, 'huge.txt'), `TODO\n${'x'.repeat(1024 * 1024)}`);

    expect(await run('grep', { pattern: 'TODO' })).toEqual({
      pattern: 'TODO',
      matches: [
        { path: 'a.txt', line: 2, text: 'TODO first' },
        { path: 'a.txt', line: 4, text: 'TODO second' },
      ],
      filesSearched: 3,
      filesSkipped: 2,
      truncated: false,
    });
    expect(await run('grep', { pattern: 'todo', ignoreCase: true, glob: '*.ts' })).toMatchObject({
      matches: [{ path: 'b.ts', line: 1 }],
    });
    expect(await run('grep', { pattern: 'TODO', maxMatches: 1 })).toMatchObject({
      matches: [{ path: 'a.txt', line: 2 }],
      truncated: true,
    });
    expect(await failure(run('grep', { pattern: '(' }))).toContain('Invalid pattern');
  });

  it('runs commands through the workspace', async () => {
    const result = await run('exec', { command: 'echo hi > out.txt && cat out.txt' });
    expect(result).toMatchObject({ stdout: 'hi\n', exitCode: 0, timedOut: false });
    expect(await workspace.read('out.txt')).toBe('hi\n');
  });
});

describe('globMatcher', () => {
  it.each([
    ['*.ts', 'a.ts', true],
    ['*.ts', 'src/a.ts', false],
    ['**/*.ts', 'a.ts', true],
    ['**/*.ts', 'src/deep/a.ts', true],
    ['src/**', 'src/a/b.md', true],
    ['src/**/test/*.ts', 'src/test/a.ts', true],
    ['*.{ts,tsx}', 'a.tsx', true],
    ['*.{ts,tsx}', 'a.js', false],
    ['file[0-9].txt', 'file7.txt', true],
    ['file[!0-9].txt', 'file7.txt', false],
    ['?.md', 'a.md', true],
    ['?.md', 'ab.md', false],
    ['a+b(c).txt', 'a+b(c).txt', true],
  ])('%s matches %s: %s', (glob, path, expected) => {
    expect(globMatcher(glob)(path)).toBe(expected);
  });
});
