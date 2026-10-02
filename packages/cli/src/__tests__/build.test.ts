import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createGatewayEntry, BUNDLE_EXTERNALS } from '../commands/build.js';

describe('createGatewayEntry', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-build-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('imports the config by absolute path', () => {
    const entry = createGatewayEntry('/p/with "quote"/gateway.ts');
    expect(entry).toContain('import * as entry from "/p/with \\"quote\\"/gateway.ts";');
  });

  it('starts the exported gateway and registers shutdown handlers', async () => {
    const gatewayPath = join(dir, 'gateway.mjs');
    writeFileSync(
      gatewayPath,
      `export const calls = [];
export const gateway = {
  stats: { connectedChannels: ['webchat'] },
  async start() { calls.push('start'); },
  async stop() { calls.push('stop'); },
};`
    );
    const entryPath = join(dir, 'entry.mjs');
    writeFileSync(entryPath, createGatewayEntry(gatewayPath));

    const once = vi.spyOn(process, 'once');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await import(pathToFileURL(entryPath).href);
    const mod: { calls: string[] } = await import(pathToFileURL(gatewayPath).href);

    expect(mod.calls).toEqual(['start']);
    expect(once.mock.calls.map(([event]) => event)).toEqual(
      expect.arrayContaining(['SIGINT', 'SIGTERM'])
    );
    expect(log).toHaveBeenCalledWith('[cogitator] Gateway started: webchat');

    for (const [event, listener] of once.mock.calls) {
      if (event === 'SIGINT' || event === 'SIGTERM') process.removeListener(event, listener);
    }
  });

  it('is a no-op for modules without a gateway export', async () => {
    const modulePath = join(dir, 'plain.mjs');
    writeFileSync(modulePath, 'export const value = 1;');
    const entryPath = join(dir, 'entry-plain.mjs');
    writeFileSync(entryPath, createGatewayEntry(modulePath));
    const once = vi.spyOn(process, 'once');
    await import(pathToFileURL(entryPath).href);
    expect(once).not.toHaveBeenCalled();
  });
});

describe('BUNDLE_EXTERNALS', () => {
  it('keeps native and optional channel dependencies external', () => {
    expect(BUNDLE_EXTERNALS).toEqual(
      expect.arrayContaining(['better-sqlite3', 'pg', 'grammy', 'discord.js', 'playwright'])
    );
  });
});
