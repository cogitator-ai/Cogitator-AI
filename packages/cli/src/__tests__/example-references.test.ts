import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FILES_THAT_RUN_EXAMPLES = ['README.md', 'demo.cast'];
const EXAMPLE_PATH = /examples\/[A-Za-z0-9_./-]+\.ts/g;

describe('examples referenced by the README and the demo recording', () => {
  it('exist', () => {
    const missing = FILES_THAT_RUN_EXAMPLES.flatMap((file) => {
      const text = readFileSync(join(REPO_ROOT, file), 'utf-8');
      return [...new Set(text.match(EXAMPLE_PATH) ?? [])]
        .filter((path) => !existsSync(join(REPO_ROOT, path)))
        .map((path) => `${file}: ${path}`);
    });
    expect(missing).toEqual([]);
  });
});
