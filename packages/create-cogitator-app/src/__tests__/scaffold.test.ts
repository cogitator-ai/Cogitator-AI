import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installDependencies } from '../utils/package-manager.js';
import { scaffold } from '../scaffold.js';
import type { ProjectOptions } from '../types.js';

vi.mock('@clack/prompts', () => ({
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
}));

vi.mock('../utils/package-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/package-manager.js')>()),
  installDependencies: vi.fn(),
}));

describe('scaffold', () => {
  let root: string;
  let options: ProjectOptions;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cca-scaffold-'));
    options = {
      name: 'embedded',
      path: join(root, 'embedded'),
      template: 'api-server',
      provider: 'openai',
      packageManager: 'pnpm',
      docker: false,
      git: false,
    };
    vi.mocked(installDependencies).mockReset();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('skips the install with install: false', async () => {
    const result = await scaffold({ ...options, install: false });

    expect(installDependencies).not.toHaveBeenCalled();
    expect(result.install).toEqual({ status: 'skipped' });
    expect(result.files).toContain('src/index.ts');
    expect(existsSync(join(options.path, 'cogitator.yml'))).toBe(true);
  });

  it('installs with the chosen package manager by default', async () => {
    const result = await scaffold(options);

    expect(installDependencies).toHaveBeenCalledExactlyOnceWith(options.path, 'pnpm');
    expect(result.install).toEqual({ status: 'done' });
  });

  it('reports a failed install instead of swallowing it', async () => {
    const failure = new Error('Command failed: pnpm install');
    vi.mocked(installDependencies).mockImplementation(() => {
      throw failure;
    });

    const result = await scaffold(options);

    expect(result.install).toEqual({ status: 'failed', error: failure });
    expect(existsSync(join(options.path, 'package.json'))).toBe(true);
  });

  it('refuses a name that is not a valid package name before writing anything', async () => {
    await expect(scaffold({ ...options, name: "bob's agents", install: false })).rejects.toThrow(
      /Invalid project name/
    );
    expect(existsSync(options.path)).toBe(false);
  });

  it('reports git as skipped when it is turned off', async () => {
    const result = await scaffold({ ...options, install: false });

    expect(result.git).toEqual({ status: 'skipped' });
  });
});
