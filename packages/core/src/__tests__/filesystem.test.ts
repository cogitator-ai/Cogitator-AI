import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileRead, fileWrite, fileList, fileExists, fileDelete } from '../tools/filesystem.js';

const mockContext = {
  agentId: 'agent_test',
  runId: 'run_test',
  signal: new AbortController().signal,
};

const TEST_DIR = join(process.cwd(), '.test-temp-fs');

beforeAll(async () => {
  await mkdir(TEST_DIR, { recursive: true });
  await writeFile(join(TEST_DIR, 'test.txt'), 'Hello, World!');
  await mkdir(join(TEST_DIR, 'subdir'), { recursive: true });
  await writeFile(join(TEST_DIR, 'subdir', 'nested.txt'), 'Nested file');
  await writeFile(join(TEST_DIR, '.hidden'), 'Hidden file');
});

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe('fileRead tool', () => {
  it('reads file content', async () => {
    const result = await fileRead.execute({ path: join(TEST_DIR, 'test.txt') }, mockContext);
    expect(result).toHaveProperty('content', 'Hello, World!');
    expect(result).toHaveProperty('encoding', 'utf-8');
    expect(result).toHaveProperty('size', 13);
  });

  it('reads file as base64', async () => {
    const result = await fileRead.execute(
      { path: join(TEST_DIR, 'test.txt'), encoding: 'base64' },
      mockContext
    );
    expect((result as { content: string }).content).toBe(Buffer.from('Hello, World!').toString('base64'));
  });

  it('returns error for non-existent file', async () => {
    const result = await fileRead.execute({ path: join(TEST_DIR, 'nope.txt') }, mockContext);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('not found');
  });

  it('has correct metadata', () => {
    expect(fileRead.name).toBe('file_read');
  });
});

describe('fileWrite tool', () => {
  it('writes file content', async () => {
    const testPath = join(TEST_DIR, 'write-test.txt');
    const result = await fileWrite.execute(
      { path: testPath, content: 'Test content' },
      mockContext
    );
    expect(result).toHaveProperty('success', true);
    expect(result).toHaveProperty('size', 12);

    // Verify
    const read = await fileRead.execute({ path: testPath }, mockContext);
    expect((read as { content: string }).content).toBe('Test content');
  });

  it('creates parent directories', async () => {
    const testPath = join(TEST_DIR, 'new-dir', 'deep', 'file.txt');
    const result = await fileWrite.execute(
      { path: testPath, content: 'Deep content' },
      mockContext
    );
    expect(result).toHaveProperty('success', true);

    // Verify
    const read = await fileRead.execute({ path: testPath }, mockContext);
    expect((read as { content: string }).content).toBe('Deep content');
  });

  it('writes base64 content', async () => {
    const testPath = join(TEST_DIR, 'binary.bin');
    const content = Buffer.from([0x00, 0x01, 0x02, 0xff]).toString('base64');
    await fileWrite.execute({ path: testPath, content, encoding: 'base64' }, mockContext);

    const read = await fileRead.execute({ path: testPath, encoding: 'base64' }, mockContext);
    expect((read as { content: string }).content).toBe(content);
  });

  it('has sideEffects declared', () => {
    expect(fileWrite.sideEffects).toContain('filesystem');
  });
});

describe('fileList tool', () => {
  it('lists directory contents', async () => {
    const result = await fileList.execute({ path: TEST_DIR }, mockContext);
    expect(result).toHaveProperty('entries');
    const entries = (result as { entries: { name: string }[] }).entries;
    const names = entries.map((e) => e.name);
    expect(names).toContain('test.txt');
    expect(names).toContain('subdir');
    expect(names).not.toContain('.hidden'); // Hidden by default
  });

  it('includes hidden files when requested', async () => {
    const result = await fileList.execute({ path: TEST_DIR, includeHidden: true }, mockContext);
    const names = (result as { entries: { name: string }[] }).entries.map((e) => e.name);
    expect(names).toContain('.hidden');
  });

  it('lists recursively', async () => {
    const result = await fileList.execute({ path: TEST_DIR, recursive: true }, mockContext);
    const entries = (result as { entries: { name: string; path: string }[] }).entries;
    const names = entries.map((e) => e.name);
    expect(names).toContain('nested.txt');
  });

  it('returns error for non-existent directory', async () => {
    const result = await fileList.execute({ path: join(TEST_DIR, 'nope') }, mockContext);
    expect(result).toHaveProperty('error');
  });

  it('has correct metadata', () => {
    expect(fileList.name).toBe('file_list');
  });
});

describe('fileExists tool', () => {
  it('returns true for existing file', async () => {
    const result = await fileExists.execute({ path: join(TEST_DIR, 'test.txt') }, mockContext);
    expect(result).toHaveProperty('exists', true);
    expect(result).toHaveProperty('type', 'file');
  });

  it('returns true for existing directory', async () => {
    const result = await fileExists.execute({ path: join(TEST_DIR, 'subdir') }, mockContext);
    expect(result).toHaveProperty('exists', true);
    expect(result).toHaveProperty('type', 'directory');
  });

  it('returns false for non-existent path', async () => {
    const result = await fileExists.execute({ path: join(TEST_DIR, 'nope') }, mockContext);
    expect(result).toHaveProperty('exists', false);
  });

  it('has correct metadata', () => {
    expect(fileExists.name).toBe('file_exists');
  });
});

describe('fileDelete tool', () => {
  it('deletes a file', async () => {
    const testPath = join(TEST_DIR, 'to-delete.txt');
    await fileWrite.execute({ path: testPath, content: 'delete me' }, mockContext);

    const result = await fileDelete.execute({ path: testPath }, mockContext);
    expect(result).toHaveProperty('success', true);
    expect(result).toHaveProperty('type', 'file');

    const exists = await fileExists.execute({ path: testPath }, mockContext);
    expect(exists).toHaveProperty('exists', false);
  });

  it('deletes empty directory', async () => {
    const testPath = join(TEST_DIR, 'empty-dir-2');
    await mkdir(testPath, { recursive: true });

    // Note: rm requires recursive: true even for empty directories in Node.js
    const result = await fileDelete.execute({ path: testPath, recursive: true }, mockContext);
    expect(result).toHaveProperty('success', true);
    expect(result).toHaveProperty('type', 'directory');
  });

  it('deletes non-empty directory with recursive', async () => {
    const testPath = join(TEST_DIR, 'full-dir');
    await mkdir(testPath, { recursive: true });
    await writeFile(join(testPath, 'file.txt'), 'content');

    const result = await fileDelete.execute({ path: testPath, recursive: true }, mockContext);
    expect(result).toHaveProperty('success', true);
  });

  it('returns error for non-existent path', async () => {
    const result = await fileDelete.execute({ path: join(TEST_DIR, 'nope') }, mockContext);
    expect(result).toHaveProperty('error');
  });

  it('has sideEffects declared', () => {
    expect(fileDelete.sideEffects).toContain('filesystem');
  });
});
