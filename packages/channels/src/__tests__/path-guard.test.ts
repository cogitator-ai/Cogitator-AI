import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { isPathAllowed, restrictFileTools } from '../tools/path-guard';
import type { Tool, ToolContext } from '@cogitator-ai/types';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'guard-'));
  dirs.push(root);
  const allowed = join(root, 'allowed');
  const secret = join(root, 'secret');
  mkdirSync(allowed);
  mkdirSync(secret);
  writeFileSync(join(secret, 'key'), 'top secret');
  return { root, allowed, secret };
}

describe('isPathAllowed', () => {
  it('allows paths inside a root, including not-yet-existing files', async () => {
    const { allowed } = sandbox();
    expect(await isPathAllowed(join(allowed, 'a.txt'), [allowed])).toBe(true);
    expect(await isPathAllowed(join(allowed, 'new', 'deep.txt'), [allowed])).toBe(true);
    expect(await isPathAllowed(allowed, [allowed])).toBe(true);
  });

  it('rejects traversal, sibling prefixes and symlink escapes', async () => {
    const { root, allowed, secret } = sandbox();
    mkdirSync(`${allowed}-evil`);
    symlinkSync(secret, join(allowed, 'link'));

    expect(await isPathAllowed(join(allowed, '..', 'secret', 'key'), [allowed])).toBe(false);
    expect(await isPathAllowed(join(`${allowed}-evil`, 'x'), [allowed])).toBe(false);
    expect(await isPathAllowed(join(allowed, 'link', 'key'), [allowed])).toBe(false);
    expect(await isPathAllowed(join(root, 'secret'), [allowed])).toBe(false);
  });
});

describe('restrictFileTools', () => {
  const ctx = { agentId: 'a', runId: 'r', signal: new AbortController().signal } as ToolContext;

  function fakeTool(): Tool {
    return {
      name: 'file_read',
      description: 'Read a file.',
      parameters: z.object({ path: z.string() }),
      execute: vi.fn().mockResolvedValue({ content: 'ok' }),
      toJSON: () => ({
        name: 'file_read',
        description: '',
        parameters: { type: 'object', properties: {} },
      }),
    } as unknown as Tool;
  }

  it('blocks access outside of the allowed roots', async () => {
    const { allowed, secret } = sandbox();
    const original = fakeTool();
    const [guarded] = restrictFileTools([original], [allowed]);

    const denied = (await guarded.execute({ path: join(secret, 'key') }, ctx)) as {
      error?: string;
    };
    expect(denied.error).toContain('Access denied');
    expect(original.execute).not.toHaveBeenCalled();

    const ok = await guarded.execute({ path: join(allowed, 'x') }, ctx);
    expect(ok).toEqual({ content: 'ok' });
    expect(guarded.name).toBe('file_read');
    expect(guarded.description).toContain(allowed);
  });
});
