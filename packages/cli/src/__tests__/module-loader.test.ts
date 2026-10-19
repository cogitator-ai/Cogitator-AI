import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importUserModule, isTypeScriptFile } from '../utils/module-loader.js';

describe('isTypeScriptFile', () => {
  it('matches ts, mts, cts and tsx', () => {
    for (const file of ['a.ts', 'a.mts', 'a.cts', 'a.tsx'])
      expect(isTypeScriptFile(file)).toBe(true);
    for (const file of ['a.js', 'a.mjs', 'a.d', 'ts']) expect(isTypeScriptFile(file)).toBe(false);
  });
});

describe('importUserModule', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-loader with space-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('imports modules from paths containing spaces', async () => {
    const file = join(dir, 'mod.mjs');
    writeFileSync(file, 'export const gateway = 42; export default "d";');
    const mod = await importUserModule(file);
    expect(mod.gateway).toBe(42);
    expect(mod.default).toBe('d');
  });

  it('propagates evaluation errors', async () => {
    const file = join(dir, 'broken.mjs');
    writeFileSync(file, 'throw new Error("boom");');
    await expect(importUserModule(file)).rejects.toThrow('boom');
  });
});
