import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TextLoader } from '../loaders/text-loader';
import { MarkdownLoader } from '../loaders/markdown-loader';
import { JSONLoader } from '../loaders/json-loader';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), 'cogitator-rag-test-' + Date.now());

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

describe('TextLoader', () => {
  it('loads a single text file', async () => {
    writeFileSync(join(TEST_DIR, 'single.txt'), 'Hello world');
    const loader = new TextLoader();
    const docs = await loader.load(join(TEST_DIR, 'single.txt'));
    expect(docs).toHaveLength(1);
    expect(docs[0].content).toBe('Hello world');
    expect(docs[0].sourceType).toBe('text');
    expect(docs[0].source).toContain('single.txt');
    expect(docs[0].id).toBeDefined();
  });

  it('loads directory of text files', async () => {
    const subdir = join(TEST_DIR, 'texts');
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(subdir, 'a.txt'), 'File A');
    writeFileSync(join(subdir, 'b.txt'), 'File B');
    writeFileSync(join(subdir, 'skip.json'), 'not a txt');
    const loader = new TextLoader();
    const docs = await loader.load(subdir);
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.content).sort()).toEqual(['File A', 'File B']);
  });

  it('has correct supportedTypes', () => {
    const loader = new TextLoader();
    expect(loader.supportedTypes).toContain('txt');
  });
});

describe('JSONLoader', () => {
  it('handles primitive array items gracefully', async () => {
    const file = join(TEST_DIR, 'primitives.json');
    writeFileSync(file, JSON.stringify([42, 'hello', true, null]));
    const loader = new JSONLoader();
    const docs = await loader.load(file);
    expect(docs).toHaveLength(4);
    expect(docs[0].content).toBe('42');
    expect(docs[1].content).toBe('hello');
    expect(docs[2].content).toBe('true');
    expect(docs[3].content).toBe('null');
  });

  it('handles object items normally', async () => {
    const file = join(TEST_DIR, 'objects.json');
    writeFileSync(file, JSON.stringify([{ content: 'test text' }]));
    const loader = new JSONLoader();
    const docs = await loader.load(file);
    expect(docs).toHaveLength(1);
    expect(docs[0].content).toBe('test text');
  });
});

describe('MarkdownLoader', () => {
  it('loads markdown file', async () => {
    writeFileSync(join(TEST_DIR, 'doc.md'), '# Title\n\nContent here.');
    const loader = new MarkdownLoader();
    const docs = await loader.load(join(TEST_DIR, 'doc.md'));
    expect(docs).toHaveLength(1);
    expect(docs[0].sourceType).toBe('markdown');
    expect(docs[0].content).toContain('# Title');
  });

  it('strips frontmatter and extracts metadata', async () => {
    writeFileSync(
      join(TEST_DIR, 'fm.md'),
      '---\ntitle: My Doc\nauthor: Test User\n---\n\nBody text.'
    );
    const loader = new MarkdownLoader({ stripFrontmatter: true });
    const docs = await loader.load(join(TEST_DIR, 'fm.md'));
    expect(docs[0].content.trim()).toBe('Body text.');
    expect(docs[0].metadata?.title).toBe('My Doc');
    expect(docs[0].metadata?.author).toBe('Test User');
  });

  it('keeps frontmatter when stripFrontmatter is false', async () => {
    writeFileSync(join(TEST_DIR, 'keep.md'), '---\ntitle: Keep\n---\n\nBody.');
    const loader = new MarkdownLoader({ stripFrontmatter: false });
    const docs = await loader.load(join(TEST_DIR, 'keep.md'));
    expect(docs[0].content).toContain('---');
  });

  it('loads directory of md files', async () => {
    const subdir = join(TEST_DIR, 'mds');
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(subdir, 'a.md'), 'Doc A');
    writeFileSync(join(subdir, 'b.mdx'), 'Doc B');
    writeFileSync(join(subdir, 'skip.txt'), 'not md');
    const loader = new MarkdownLoader();
    const docs = await loader.load(subdir);
    expect(docs).toHaveLength(2);
  });
});
