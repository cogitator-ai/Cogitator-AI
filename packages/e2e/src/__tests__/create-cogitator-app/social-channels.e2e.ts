import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatProject, scaffold } from 'create-cogitator-app';
import {
  cogitatorDependencies,
  exec,
  hasBinary,
  installArgs,
  mustExec,
  packWorkspace,
  runArgs,
  useTarballs,
} from '../../helpers/scaffold-harness';

/**
 * A messaging bot on Bluesky and Threads, generated, installed from the
 * workspace tarballs the way npm would ship them, and checked: it
 * typechecks, lints, passes its own tests and builds.
 */
const root = mkdtempSync(join(tmpdir(), 'cca-social-'));
const dir = join(root, 'social-bot');
let available = false;
let scripts: Record<string, string> = {};

beforeAll(async () => {
  available = await hasBinary('pnpm');
  if (!available) return;
  await scaffold(
    {
      name: 'social-bot',
      preset: 'channels',
      app: 'channels',
      channels: ['bluesky', 'threads'],
      memory: 'sqlite',
      features: [],
      provider: 'ollama',
      model: 'qwen3.5:4b',
      packageManager: 'pnpm',
    },
    { directory: dir, install: false, git: false }
  );
  useTarballs(dir, 'pnpm', await packWorkspace(cogitatorDependencies(dir)));
  await mustExec('pnpm', installArgs('pnpm'), { cwd: dir, timeoutMs: 900_000, env: { CI: '1' } });
  const formatted = await formatProject(dir);
  if (formatted.status === 'failed') throw formatted.error;
  scripts = (
    JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;
}, 1_000_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('a generated bot on Bluesky and Threads', () => {
  for (const script of ['typecheck', 'lint', 'test', 'build']) {
    it(`runs ${script}`, async (context) => {
      if (!available) return context.skip('pnpm is not installed');
      if (!scripts[script]) return context.skip(`the project has no ${script} script`);
      const [command, args] = runArgs('pnpm', script);
      const result = await exec(command, args, { cwd: dir, env: { CI: '1' }, timeoutMs: 600_000 });
      expect(result.code, result.output.split('\n').slice(-40).join('\n')).toBe(0);
    }, 620_000);
  }
});
