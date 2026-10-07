import { describe, it, expect, vi, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDev } from '../commands/dev.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'registry-project');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('cogitator dev', () => {
  it('serves the studio for the project and loads its registry', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const studio = await runDev(FIXTURE, { port: '0', watch: false });
    try {
      await studio.ready();
      const response = await fetch(`http://127.0.0.1:${studio.port}/api/state`);
      const state = (await response.json()) as {
        host: { state: string; registry: { agents: Array<{ key: string }> } };
      };
      expect(state.host.state).toBe('ready');
      expect(state.host.registry.agents.map((agent) => agent.key)).toEqual(['assistant', 'writer']);
      expect(studio.url).toMatch(/^http:\/\/localhost:\d+\/$/);
      const page = await fetch(`http://127.0.0.1:${studio.port}/`);
      expect(await page.text()).toContain('<div id="root">');
    } finally {
      await studio.close();
    }
  }, 60_000);

  it('refuses a port that is not one', async () => {
    await expect(runDev(FIXTURE, { port: 'eighty' })).rejects.toThrow('--port takes a port number');
  });
});
