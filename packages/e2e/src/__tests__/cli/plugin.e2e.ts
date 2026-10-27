import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTestModel, ollamaSkipReason } from '../../helpers/setup';

const describeOllama = describe.skipIf((await ollamaSkipReason()) !== null);

const CLI = fileURLToPath(new URL('../../../../cli/dist/index.js', import.meta.url));
const FIXTURE = fileURLToPath(
  new URL('../../../../core/src/__tests__/fixtures/plugins/deploy-tools', import.meta.url)
);

let base: string;

function cli(args: string[], cwd = join(base, 'project')) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      HOME: join(base, 'home'),
      USERPROFILE: join(base, 'home'),
      CLAUDE_CONFIG_DIR: join(base, 'home', '.claude'),
      COGITATOR_PLUGINS_DIR: join(base, 'plugins'),
    },
    encoding: 'utf-8',
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'e2e-cli-plugin-')));
  mkdirSync(join(base, 'project'), { recursive: true });
  mkdirSync(join(base, 'home'), { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('CLI: cogitator plugin', () => {
  it(
    'validates the Claude Code fixture, installs it from a local marketplace, lists, disables and removes it',
    { timeout: 120_000 },
    () => {
      expect(cli(['plugin', 'validate', FIXTURE]).status).toBe(0);
      const market = join(base, 'market');
      cpSync(FIXTURE, join(market, 'plugins', 'deploy-tools'), { recursive: true });
      mkdirSync(join(market, '.claude-plugin'), { recursive: true });
      writeFileSync(
        join(market, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({
          name: 'cli-market',
          owner: { name: 'E2E' },
          plugins: [{ name: 'deploy-tools', source: './plugins/deploy-tools' }],
        })
      );
      const added = cli(['plugin', 'marketplace', 'add', market, '--json']);
      expect(added.status).toBe(0);
      expect(JSON.parse(added.stdout)).toMatchObject({
        command: 'marketplace-add',
        outcome: 'ok',
        marketplace: 'cli-market',
      });
      const installed = cli(['plugin', 'install', 'deploy-tools@cli-market', '--json']);
      expect(installed.status).toBe(0);
      expect(JSON.parse(installed.stdout)).toMatchObject({
        outcome: 'ok',
        pluginId: 'deploy-tools@cli-market',
        version: '1.2.0',
      });
      const listed = JSON.parse(cli(['plugin', 'list', '--json']).stdout) as {
        id: string;
        enabled: boolean;
      }[];
      expect(listed).toEqual([
        expect.objectContaining({ id: 'deploy-tools@cli-market', enabled: true }),
      ]);
      expect(cli(['plugin', 'disable', 'deploy-tools@cli-market']).status).toBe(0);
      expect(
        JSON.parse(readFileSync(join(base, 'home', '.cogitator', 'settings.json'), 'utf8'))
      ).toEqual({
        enabledPlugins: { 'deploy-tools@cli-market': false },
      });
      const removed = cli(['plugin', 'uninstall', 'deploy-tools@cli-market', '--json']);
      expect(JSON.parse(removed.stdout)).toMatchObject({
        outcome: 'ok',
        removed: ['deploy-tools@cli-market'],
      });
      expect(JSON.parse(cli(['plugin', 'list', '--json']).stdout)).toEqual([]);
    }
  );

  it(
    'exits 1 for a plugin that fails validation and for one it cannot find',
    { timeout: 60_000 },
    () => {
      const broken = join(base, 'broken');
      mkdirSync(join(broken, '.claude-plugin'), { recursive: true });
      writeFileSync(
        join(broken, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'has space' })
      );
      const validated = cli(['plugin', 'validate', broken]);
      expect(validated.status).toBe(1);
      expect(validated.stdout).toContain('Validation failed');
      expect(cli(['plugin', 'install', 'missing@nowhere']).status).toBe(1);
    }
  );
});

describeOllama('CLI: cogitator plugin eval on Ollama', () => {
  it('runs the eval suite of a plugin and exits 0 when it passes', { timeout: 180_000 }, () => {
    const plugin = join(base, 'project', 'echo-plugin');
    mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(plugin, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'echo-plugin', version: '1.0.0' })
    );
    const dir = join(plugin, 'evals', 'echoes');
    mkdirSync(join(dir, 'graders'), { recursive: true });
    writeFileSync(
      join(dir, 'prompt.md'),
      '---\nruns: 1\nmax_turns: 2\n---\n\nReply with exactly this text and nothing else: ECHO-OK\n'
    );
    writeFileSync(join(dir, 'graders', 'replied.md'), '---\ntype: regex\npattern: .\n---\n');
    const result = cli([
      'plugin',
      'eval',
      plugin,
      '--model',
      `ollama/${getTestModel()}`,
      '--ablation',
      'none',
      '--json',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      aggregates: { casesPassed: 1, casesTotal: 1 },
    });
  });
});
