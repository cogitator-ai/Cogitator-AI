import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from 'create-cogitator-app';
import {
  cogitatorDependencies,
  installArgs,
  mustExec,
  packWorkspace,
  useTarballs,
} from '../../helpers/scaffold-harness';

const root = mkdtempSync(join(tmpdir(), 'cca-starters-'));
let online = false;

beforeAll(async () => {
  try {
    const response = await fetch('https://codeload.github.com/', {
      method: 'HEAD',
      signal: AbortSignal.timeout(10_000),
    });
    online = response.status < 500;
  } catch {
    online = false;
  }
  if (!online) console.warn('Skipping the GitHub starters: github.com is not reachable');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

async function cli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) });
  return { code, stdout, stderr };
}

describe('starters from GitHub', () => {
  it('turns an example at the release tag into a project that type-checks', async (context) => {
    if (!online) context.skip();
    const dir = join(root, 'tutor');
    const created = await cli([
      dir,
      '--example',
      'core/basic-agent',
      '--json',
      '--no-install',
      '--no-git',
      '--pm',
      'pnpm',
    ]);
    expect(created.code, created.stdout + created.stderr).toBe(0);
    expect(JSON.parse(created.stdout).source).toMatch(
      /^example core\/basic-agent at create-cogitator-app@/
    );

    useTarballs(dir, 'pnpm', await packWorkspace(cogitatorDependencies(dir)));
    await mustExec('pnpm', installArgs('pnpm'), { cwd: dir });
    await mustExec('pnpm', ['typecheck'], { cwd: dir });
    expect(existsSync(join(dir, 'src/_shared/setup.ts'))).toBe(true);
  }, 600_000);

  it('copies a directory of a GitHub repository at a tag', async (context) => {
    if (!online) context.skip();
    const dir = join(root, 'copied');
    const created = await cli([
      dir,
      '--template',
      'github:cogitator-ai/Cogitator-AI/packages/create-cogitator-app#create-cogitator-app@0.4.0',
      '--json',
      '--no-install',
      '--no-git',
    ]);
    expect(created.code, created.stdout + created.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as {
      name: string;
      dependencies: Record<string, string>;
    };
    expect(manifest.name).toBe('copied');
    expect(
      Object.values(manifest.dependencies).some((range) => range.startsWith('workspace:'))
    ).toBe(false);
    expect(existsSync(join(dir, 'src/index.ts'))).toBe(true);
  }, 300_000);
});
