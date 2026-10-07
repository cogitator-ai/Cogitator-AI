import { describe, it, expect, afterAll } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleDocs } from '../../scripts/bundle-docs';

const SITE_DOCS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../dashboard/content/docs'
);
const temp = mkdtempSync(join(tmpdir(), 'cogitator-docs-'));

afterAll(() => rmSync(temp, { recursive: true, force: true }));

function files(dir: string, extension: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf-8' }).filter((file) =>
    file.endsWith(extension)
  );
}

describe('bundled docs', () => {
  const target = join(temp, 'site');
  const { pages } = bundleDocs({ source: SITE_DOCS, target, version: '9.9.9' });

  it('bundles every page of the site as Markdown', () => {
    expect(pages).toHaveLength(files(SITE_DOCS, '.mdx').length);
    for (const page of pages) {
      const text = readFileSync(join(target, page.path), 'utf-8');
      expect(text.startsWith(`# ${page.title}\n`), page.path).toBe(true);
      expect(text, page.path).not.toMatch(/^---\ntitle:/);
    }
  });

  it('lists every page in index.md, in the sections of the site', () => {
    const index = readFileSync(join(target, 'index.md'), 'utf-8');
    expect(index).toContain('# Cogitator 9.9.9 documentation');
    expect(index).toContain('## Core\n\n- [Cogitator Runtime](core/cogitator.md)');
    for (const page of pages) expect(index).toContain(`](${page.path})`);
  });

  it('turns site links into relative links that resolve', () => {
    for (const file of files(target, '.md')) {
      const text = readFileSync(join(target, file), 'utf-8');
      expect(text, file).not.toMatch(/\]\(\/docs/);
      for (const [, link] of text.matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
        if (/^[a-z]+:/.test(link)) continue;
        expect(existsSync(join(target, dirname(file), link)), `${file} -> ${link}`).toBe(true);
      }
    }
  });

  it('refuses a link to a page that does not exist', () => {
    const source = join(temp, 'broken');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'meta.json'), JSON.stringify({ pages: ['guide'] }));
    writeFileSync(
      join(source, 'index.mdx'),
      '---\ntitle: Home\n---\n\nSee [the guide](/docs/guide).\n'
    );
    writeFileSync(
      join(source, 'guide.mdx'),
      '---\ntitle: Guide\n---\n\nRead [missing](/docs/nowhere#x).\n'
    );
    expect(() => bundleDocs({ source, target: join(temp, 'out'), version: '1.0.0' })).toThrow(
      'guide.md links to /docs/nowhere, which is not a page'
    );
  });
});
