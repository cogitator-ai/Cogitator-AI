import { describe, it, expect, beforeEach } from 'vitest';
import { MEMORY_FILE_CONFLICT } from '@cogitator-ai/types';
import type { MemoryFileVersion } from '@cogitator-ai/types';
import { InMemoryAdapter } from '../adapters/memory';
import {
  MemoryFiles,
  MemoryFileError,
  REDACTED_CONTENT,
  memoryPath,
  sha256Of,
  type MemoryFileAccess,
} from '../memory-files';

describe('memoryPath', () => {
  it('keeps paths under /memories and refuses the rest', () => {
    expect(memoryPath('/memories')).toBe('/memories');
    expect(memoryPath('/memories/')).toBe('/memories');
    expect(memoryPath('/memories//notes/a.md')).toBe('/memories/notes/a.md');
    expect(() => memoryPath('/etc/passwd')).toThrow(
      'Path must start with /memories, got: /etc/passwd'
    );
    expect(() => memoryPath('/memoriesX/a')).toThrow(/must start with \/memories/);
    expect(() => memoryPath('/memories/../secret')).toThrow(
      'Path /memories/../secret would escape /memories directory'
    );
  });
});

describe('MemoryFiles', () => {
  let adapter: InMemoryAdapter;
  let files: MemoryFiles;
  const access: MemoryFileAccess = { scope: { agentId: 'a', userId: 'ana' } };

  beforeEach(() => {
    adapter = new InMemoryAdapter({ provider: 'memory' });
    files = new MemoryFiles({ adapter });
  });

  it('answers each command as the memory tool does', async () => {
    expect(await files.create(access, '/memories/notes/plan.md', 'one\ntwo\nthree')).toBe(
      'File created successfully at: /memories/notes/plan.md'
    );
    await expect(files.create(access, '/memories/notes/plan.md', 'x')).rejects.toThrow(
      'File /memories/notes/plan.md already exists'
    );

    expect(await files.view(access, '/memories/notes/plan.md')).toBe(
      "Here's the content of /memories/notes/plan.md with line numbers:\n     1\tone\n     2\ttwo\n     3\tthree"
    );
    expect(await files.view(access, '/memories/notes/plan.md', [2, -1])).toBe(
      "Here's the content of /memories/notes/plan.md with line numbers:\n     2\ttwo\n     3\tthree"
    );

    expect(await files.strReplace(access, '/memories/notes/plan.md', 'two', 'TWO')).toBe(
      'The memory file has been edited. Here is the snippet showing the change (with line numbers):\n     1\tone\n     2\tTWO\n     3\tthree'
    );
    await expect(files.strReplace(access, '/memories/notes/plan.md', 'four', 'x')).rejects.toThrow(
      'No replacement was performed, old_str `four` did not appear verbatim in /memories/notes/plan.md.'
    );
    await files.insert(access, '/memories/notes/plan.md', 3, 'o\n');
    await expect(files.strReplace(access, '/memories/notes/plan.md', 'o', 'x')).rejects.toThrow(
      'No replacement was performed. Multiple occurrences of old_str `o` in lines: 1, 4. Please ensure it is unique'
    );

    expect(await files.insert(access, '/memories/notes/plan.md', 0, 'zero')).toBe(
      'The file /memories/notes/plan.md has been edited.'
    );
    await expect(files.insert(access, '/memories/notes/plan.md', 9, 'x')).rejects.toThrow(
      'Invalid `insert_line` parameter: 9. It should be within the range of lines of the file: [0, 5]'
    );
    expect((await files.read(access, '/memories/notes/plan.md'))?.content).toBe(
      'zero\none\nTWO\nthree\no'
    );

    expect(await files.rename(access, '/memories/notes', '/memories/archive')).toBe(
      'Successfully renamed /memories/notes to /memories/archive'
    );
    await expect(files.view(access, '/memories/notes/plan.md')).rejects.toThrow(
      'The path /memories/notes/plan.md does not exist. Please provide a valid path.'
    );
    expect(await files.delete(access, '/memories/archive')).toBe(
      'Successfully deleted /memories/archive'
    );
    await expect(files.delete(access, '/memories/archive')).rejects.toThrow(
      'The path /memories/archive does not exist'
    );
    await expect(files.delete(access, '/memories')).rejects.toThrow(
      'Cannot delete the /memories directory itself'
    );
  });

  it('lists a directory two levels deep with sizes', async () => {
    await files.create(access, '/memories/a.md', 'abc');
    await files.create(access, '/memories/notes/b.md', 'hello');
    await files.create(access, '/memories/notes/deep/c.md', 'x');

    expect(await files.view(access, '/memories')).toBe(
      [
        "Here're the files and directories up to 2 levels deep in /memories, excluding hidden items and node_modules:",
        '9B\t/memories',
        '3B\t/memories/a.md',
        '6B\t/memories/notes/',
        '5B\t/memories/notes/b.md',
        '1B\t/memories/notes/deep/',
      ].join('\n')
    );
    expect(await files.view({ scope: { agentId: 'other' } }, '/memories')).toBe(
      "Here're the files and directories up to 2 levels deep in /memories, excluding hidden items and node_modules:\n0B\t/memories"
    );
  });

  it('keeps every change as a version of its own', async () => {
    await files.create(access, '/memories/a.md', 'v1');
    await files.strReplace(access, '/memories/a.md', 'v1', 'v2');
    await files.delete(access, '/memories/a.md');

    const history = await files.history(access, '/memories/a.md');
    expect(history.map((version) => [version.sequence, version.content])).toEqual([
      [1, 'v1'],
      [2, 'v2'],
      [3, null],
    ]);
    expect(history[1]?.previousId).toBe(history[0]?.id);
  });

  it('shows the narrowest scope of a path, and writes to the access scope', async () => {
    const agentWide: MemoryFileAccess = { scope: { agentId: 'a' } };
    await files.create(agentWide, '/memories/style.md', 'formal');
    expect((await files.read(access, '/memories/style.md'))?.content).toBe('formal');

    await files.strReplace(access, '/memories/style.md', 'formal', 'casual');

    expect((await files.read(access, '/memories/style.md'))?.content).toBe('casual');
    expect((await files.read(agentWide, '/memories/style.md'))?.content).toBe('formal');
    expect(
      (await files.read({ scope: { agentId: 'a', userId: 'bo' } }, '/memories/style.md'))?.content
    ).toBe('formal');
  });

  it("sees in its own thread only the versions of the run's branch", async () => {
    const onBranch = (entryId: string, pathIds: string[]): MemoryFileAccess => ({
      ...access,
      place: { threadId: 't', entryId, pathIds: new Set(pathIds) },
    });
    await files.create(onBranch('e1', ['e1']), '/memories/todo.md', 'start');
    await files.strReplace(onBranch('e2', ['e1', 'e2']), '/memories/todo.md', 'start', 'branch A');

    expect((await files.read(onBranch('e3', ['e1', 'e3']), '/memories/todo.md'))?.content).toBe(
      'start'
    );
    expect((await files.read(onBranch('e2', ['e1', 'e2']), '/memories/todo.md'))?.content).toBe(
      'branch A'
    );
    expect((await files.read(access, '/memories/todo.md'))?.content).toBe('branch A');

    await files.strReplace(onBranch('e3', ['e1', 'e3']), '/memories/todo.md', 'start', 'branch B');
    expect((await files.read(onBranch('e3', ['e1', 'e3']), '/memories/todo.md'))?.content).toBe(
      'branch B'
    );
    expect((await files.read(onBranch('e2', ['e1', 'e2']), '/memories/todo.md'))?.content).toBe(
      'branch A'
    );
  });

  it('changes a path where the version in front of the run stands when that scope is narrower', async () => {
    const threadOnly: MemoryFileAccess = { scope: { agentId: 'a', threadId: 't1' } };
    await files.create(threadOnly, '/memories/plan.md', 'old');
    const user: MemoryFileAccess = {
      scope: { agentId: 'a', userId: 'ana' },
      visibleTo: { agentId: 'a', userId: 'ana', threadId: 't1' },
    };

    await files.strReplace(user, '/memories/plan.md', 'old', 'new');
    expect((await files.read(user, '/memories/plan.md'))?.content).toBe('new');
    await files.delete(user, '/memories/plan.md');
    expect(await files.read(user, '/memories/plan.md')).toBeUndefined();
  });

  it('keeps a renamed file in the narrower scope it came from', async () => {
    const ana: MemoryFileAccess = { scope: { agentId: 'a', userId: 'ana' } };
    await files.create(ana, '/memories/private.md', 'Ana only');
    const agentWide: MemoryFileAccess = {
      scope: { agentId: 'a' },
      visibleTo: { agentId: 'a', userId: 'ana' },
    };

    await files.rename(agentWide, '/memories/private.md', '/memories/moved.md');

    expect((await files.read(ana, '/memories/moved.md'))?.content).toBe('Ana only');
    const bo: MemoryFileAccess = { scope: { agentId: 'a', userId: 'bo' } };
    expect(await files.read(bo, '/memories/moved.md')).toBeUndefined();
  });

  it('plans a change again when another writer added a version after it read the files', async () => {
    await files.create(access, '/memories/a.md', 'one');
    const find = adapter.findFileVersions.bind(adapter);
    let reads = 0;
    adapter.findFileVersions = async (filter) => {
      const found = await find(filter);
      if (reads++ === 0) {
        const head = found.success
          ? found.data.find((v) => v.path === '/memories/a.md')
          : undefined;
        await adapter.putFileVersions([
          {
            ...head!,
            id: 'other-writer',
            sequence: head!.sequence + 1,
            content: 'one and more',
            sha256: sha256Of('one and more'),
            previousId: head!.id,
          },
        ]);
      }
      return found;
    };

    await files.strReplace(access, '/memories/a.md', 'one', 'ONE');

    expect((await files.read(access, '/memories/a.md'))?.content).toBe('ONE and more');
  });

  it('keeps files and directories apart, and text a store cannot hold out', async () => {
    await files.create(access, '/memories/a', 'a file');
    await expect(files.create(access, '/memories/a/b', 'x')).rejects.toThrow(
      'Cannot create /memories/a/b: /memories/a is a file'
    );
    await files.create(access, '/memories/x.md', 'x');
    await expect(files.rename(access, '/memories/x.md', '/memories/a/x.md')).rejects.toThrow(
      'is a file'
    );
    await expect(files.create(access, '/memories/notes/', 'x')).rejects.toThrow(
      'The path /memories/notes/ is not a file.'
    );
    await expect(files.create(access, '/memories/nul.md', 'a\u0000b')).rejects.toThrow(
      'cannot hold NUL'
    );
  });

  it('tells what each command showed or wrote', async () => {
    const seen: [string, string | null][] = [];
    const watched: MemoryFileAccess = { ...access, observe: (path, sha) => seen.push([path, sha]) };

    await files.create(watched, '/memories/a.md', 'one');
    await files.view(watched, '/memories/a.md');
    await files.delete(watched, '/memories/a.md');

    expect(seen).toEqual([
      ['/memories/a.md', sha256Of('one')],
      ['/memories/a.md', sha256Of('one')],
      ['/memories/a.md', null],
    ]);
  });

  it('refuses changes to read-only memory, and edits of a file changed since it was viewed', async () => {
    await files.create(access, '/memories/a.md', 'one');
    await expect(
      files.create({ ...access, readOnly: true }, '/memories/b.md', 'x')
    ).rejects.toThrow('The memory at /memories/b.md is read-only');

    const viewed = sha256Of('one');
    await files.strReplace(access, '/memories/a.md', 'one', 'two');

    await expect(
      files.strReplace(access, '/memories/a.md', 'two', 'three', viewed)
    ).rejects.toThrow('The file /memories/a.md changed since it was viewed');
  });

  it('makes a change again when another writer took its place first', async () => {
    await files.create(access, '/memories/a.md', 'one');
    let refused = 0;
    const put = adapter.putFileVersions.bind(adapter);
    adapter.putFileVersions = async (versions: MemoryFileVersion[]) => {
      if (refused++ === 0) {
        await put([
          {
            ...versions[0]!,
            id: 'other-writer',
            content: 'one and more',
            sha256: sha256Of('one and more'),
          },
        ]);
        return { success: false, error: MEMORY_FILE_CONFLICT };
      }
      return put(versions);
    };

    await files.strReplace(access, '/memories/a.md', 'one', 'ONE');

    expect((await files.read(access, '/memories/a.md'))?.content).toBe('ONE and more');
  });

  it('renames a directory whole or not at all', async () => {
    await files.create(access, '/memories/notes/a.md', 'a');
    await files.create(access, '/memories/notes/b.md', 'b');
    const put = adapter.putFileVersions.bind(adapter);
    adapter.putFileVersions = async () => ({ success: false, error: 'store down' });

    await expect(files.rename(access, '/memories/notes', '/memories/old')).rejects.toThrow(
      'store down'
    );
    adapter.putFileVersions = put;
    expect((await files.list(access)).map((file) => file.path)).toEqual([
      '/memories/notes/a.md',
      '/memories/notes/b.md',
    ]);
  });

  it('redacts every version of a file, keeping its history', async () => {
    await files.create(access, '/memories/a.md', 'my card is 4111');
    await files.strReplace(access, '/memories/a.md', '4111', '4111 1111');

    expect(await files.redact(access, ['/memories/a.md'], 'card number')).toBe(2);

    const history = await files.history(access, '/memories/a.md');
    expect(history.map((version) => version.content)).toEqual([REDACTED_CONTENT, REDACTED_CONTENT]);
    expect(history[0]?.redacted?.reason).toBe('card number');
    expect(JSON.stringify(history)).not.toContain('4111');
  });

  it('redacts a file by its new path back through its renames', async () => {
    await files.create(access, '/memories/a.md', 'SECRET');
    await files.rename(access, '/memories/a.md', '/memories/b.md');

    expect(await files.redact(access, ['/memories/b.md'])).toBe(2);

    const everything = await adapter.findFileVersions({ agentId: 'a' });
    expect(JSON.stringify(everything)).not.toContain('SECRET');
  });

  it('lists the files for a context within a size', async () => {
    expect(await files.index(access)).toBeUndefined();
    await files.create(access, '/memories/plan.md', '# Trip to Lisbon\nday 1');
    await files.create(access, '/memories/people.md', 'Ana: sister');

    expect(await files.index(access)).toBe(
      [
        'Memory files (view them with the memory tool):',
        '- /memories/people.md (11B): Ana: sister',
        '- /memories/plan.md (22B): # Trip to Lisbon',
      ].join('\n')
    );
    expect(await files.index(access, 50)).toBe(
      [
        'Memory files (view them with the memory tool):',
        '- /memories/people.md (11B): Ana: sister',
        '- and 1 more',
      ].join('\n')
    );
  });

  it('runs a command as the tool sends it', async () => {
    await files.run(access, { command: 'create', path: '/memories/a.md', file_text: 'x' });

    expect(await files.run(access, { command: 'view', path: '/memories/a.md' })).toContain('1\tx');
    await expect(files.run(access, { command: 'view', path: '/tmp/a.md' })).rejects.toBeInstanceOf(
      MemoryFileError
    );
  });
});
