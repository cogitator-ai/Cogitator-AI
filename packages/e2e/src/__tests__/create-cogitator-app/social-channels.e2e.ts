import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatProject, scaffold, type ChannelKind } from 'create-cogitator-app';
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
 * A messaging bot on Bluesky, Threads, GitHub, email, Microsoft Teams and WebChat
 * (the GitHub and Teams webhooks served on the WebChat port), generated, installed from the workspace
 * tarballs the way npm would ship them, and checked: it typechecks, lints,
 * passes its own tests and builds.
 */
const root = mkdtempSync(join(tmpdir(), 'cca-social-'));
const dir = join(root, 'social-bot');
let available = false;
let scripts: Record<string, string> = {};

/**
 * Smaller bots that serve webhooks without WebChat: GitHub's on the Teams port, and Teams
 * alone on its own port. Each is generated and typechecked.
 */
const webhookBots = [
  { name: 'github-teams-bot', channels: ['github', 'teams'] as const },
  { name: 'teams-bot', channels: ['teams'] as const },
];

async function generate(name: string, channels: readonly ChannelKind[]): Promise<string> {
  const directory = join(root, name);
  await scaffold(
    {
      name,
      preset: 'channels',
      app: 'channels',
      channels: [...channels],
      memory: 'sqlite',
      features: [],
      provider: 'ollama',
      model: 'qwen3.5:4b',
      packageManager: 'pnpm',
    },
    { directory, install: false, git: false }
  );
  useTarballs(directory, 'pnpm', await packWorkspace(cogitatorDependencies(directory)));
  await mustExec('pnpm', installArgs('pnpm'), {
    cwd: directory,
    timeoutMs: 900_000,
    env: { CI: '1' },
  });
  const formatted = await formatProject(directory);
  if (formatted.status === 'failed') throw formatted.error;
  return directory;
}

beforeAll(async () => {
  available = await hasBinary('pnpm');
  if (!available) return;
  await generate('social-bot', ['bluesky', 'threads', 'github', 'email', 'teams', 'webchat']);
  scripts = (
    JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  for (const bot of webhookBots) await generate(bot.name, bot.channels);
}, 2_000_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('a generated bot on Bluesky, Threads, GitHub, email, Teams and WebChat', () => {
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

describe('generated bots that serve webhooks without WebChat', () => {
  for (const bot of webhookBots) {
    it(`typechecks ${bot.channels.join(' and ')}`, async (context) => {
      if (!available) return context.skip('pnpm is not installed');
      const [command, args] = runArgs('pnpm', 'typecheck');
      const result = await exec(command, args, {
        cwd: join(root, bot.name),
        env: { CI: '1' },
        timeoutMs: 600_000,
      });
      expect(result.code, result.output.split('\n').slice(-40).join('\n')).toBe(0);
    }, 620_000);
  }
});
