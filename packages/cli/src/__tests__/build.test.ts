import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { buildCommand, createGatewayEntry, gatewayBuildOptions } from '../commands/build.js';

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
    const mod: { calls: string[] } = await import(gatewayPath);

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

describe('gatewayBuildOptions', () => {
  it('bundles the project code and leaves every package, native addons included, to node_modules', () => {
    const options = gatewayBuildOptions({
      configPath: '/app/src/gateway.ts',
      outfile: '/app/dist/cogitator.mjs',
      target: 'node22',
      sourcemap: true,
    });
    expect(options).toMatchObject({ bundle: true, packages: 'external', format: 'esm' });
    expect(options).not.toHaveProperty('external');
  });
});

describe('cogitator build', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-build-project-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('bundles a TypeScript gateway with its own esbuild in a project that has none', async () => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(
      join(dir, 'src', 'gateway.ts'),
      `const state: { calls: string[] } = { calls: [] };
(globalThis as { cliBuildTest?: typeof state }).cliBuildTest = state;
export const gateway = {
  async start(): Promise<void> { state.calls.push('start'); },
  async stop(): Promise<void> { state.calls.push('stop'); },
};`
    );
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const once = vi.spyOn(process, 'once');

    await buildCommand.parseAsync(['--quiet', '--no-sourcemap'], { from: 'user' });

    const outfile = join(dir, 'dist', 'cogitator.mjs');
    expect(existsSync(join(dir, 'node_modules'))).toBe(false);
    expect(existsSync(outfile)).toBe(true);

    await import(pathToFileURL(outfile).href);
    const state = (globalThis as { cliBuildTest?: { calls: string[] } }).cliBuildTest;
    expect(state?.calls).toEqual(['start']);

    for (const [event, listener] of once.mock.calls) {
      if (event === 'SIGINT' || event === 'SIGTERM') process.removeListener(event, listener);
    }
  });
});
