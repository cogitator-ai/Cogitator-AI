import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as entry from '../tool-entry';
import * as root from '../index';

describe('@cogitator-ai/core/tool', () => {
  it('exports the tool helpers of the package root, the same functions', () => {
    const names = Object.keys(entry);
    expect(names).toEqual(expect.arrayContaining(['tool', 'toolset', 'toolOutput']));
    for (const name of names) {
      expect((root as Record<string, unknown>)[name], name).toBe(
        (entry as Record<string, unknown>)[name]
      );
    }
  });

  it('is an entry of the package', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')
    ) as { exports: Record<string, { import: string }> };
    expect(manifest.exports['./tool'].import).toBe('./dist/tool-entry.js');
  });
});
