import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../cli/main.js';

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(
  argv: string[],
  fetcher: typeof fetch = async () => new Response('{}')
): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const code = await run(
    argv,
    {
      stdout: (text) => (stdout += text),
      stderr: (text) => (stderr += text),
    },
    { fetch: fetcher }
  );
  return { code, stdout, stderr };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('create-cogitator-app CLI', () => {
  it('prints help and the version', async () => {
    const help = await cli(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('npx create-cogitator-app [directory] [options]');
    expect(help.stdout).toContain('--dry-run');

    const version = await cli(['-v']);
    expect(version.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it('lists the presets, also as JSON', async () => {
    expect((await cli(['--list-templates'])).stdout).toContain('durable-workflow');
    const json = JSON.parse((await cli(['--list-presets', '--json'])).stdout) as Array<{
      id: string;
    }>;
    expect(json.map((preset) => preset.id)).toContain('assistant');
  });

  it('shows a dry run as JSON without writing anything', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cca-cli-'));
    roots.push(root);
    const directory = join(root, 'demo');

    const result = await cli([
      directory,
      '--preset',
      'api-server',
      '-p',
      'anthropic',
      '--dry-run',
      '--json',
    ]);

    expect(result.code).toBe(0);
    const plan = JSON.parse(result.stdout) as {
      ok: boolean;
      dryRun: boolean;
      spec: { app: string; server: string; provider: string };
      files: string[];
      env: Array<{ name: string; required: boolean }>;
      command: string;
    };
    expect(plan).toMatchObject({
      ok: true,
      dryRun: true,
      spec: { app: 'server', server: 'express', provider: 'anthropic' },
    });
    expect(plan.files).toContain('src/index.ts');
    expect(plan.env).toContainEqual(
      expect.objectContaining({ name: 'ANTHROPIC_API_KEY', required: true })
    );
    expect(plan.command).toContain('--preset api-server');
    expect(existsSync(directory)).toBe(false);
  });

  it('describes a dry run for people', async () => {
    const result = await cli(['demo', '--dry-run', '--yes']);
    expect(result.stdout).toContain('Dry run: nothing was written.');
    expect(result.stdout).toContain('src/cogitator.ts');
    expect(result.stdout).toContain('Recreate with');
  });

  it('reports errors as JSON with --json and exits 1', async () => {
    const bad = await cli(['--json', '--memory', 'oracle']);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.stdout)).toEqual({
      ok: false,
      error: { message: expect.stringContaining('Invalid --memory "oracle"') },
    });

    const incompatible = await cli([
      '--json',
      '--dry-run',
      '--app',
      'server',
      '--server',
      'tetsu',
      '--pm',
      'npm',
    ]);
    const parsed = JSON.parse(incompatible.stdout) as {
      error: { issues: Array<{ message: string }> };
    };
    expect(parsed.error.issues[0].message).toBe('Tetsu servers run on Bun');
  });

  it('creates a project non-interactively and prints the next steps', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cca-cli-'));
    roots.push(root);
    const directory = join(root, 'demo');

    const result = await cli([
      directory,
      '-y',
      '-p',
      'openai',
      '--api-key',
      'sk-test',
      '--pm',
      'pnpm',
      '--no-install',
      '--no-git',
    ]);

    expect(result.code).toBe(0);
    expect(existsSync(join(directory, '.env'))).toBe(true);
    expect(result.stderr).toContain('Your project is ready.');
    expect(result.stderr).toContain('pnpm doctor');
    expect(result.stderr).not.toContain('cp .env.example .env');
    expect(result.stderr).not.toContain('sk-test');
  });
});
