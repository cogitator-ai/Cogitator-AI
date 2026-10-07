import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Deployer } from '../deployer';
import type { DeployProvider } from '../providers/base';

function passingProvider(name: string): DeployProvider {
  return {
    name,
    preflight: async () => ({
      checks: [{ name: 'ok', passed: true, message: 'ok' }],
      passed: true,
    }),
    generate: async () => ({ files: [], outputDir: '.cogitator' }),
    deploy: async () => ({ success: true }),
    status: async () => ({ running: true }),
    destroy: async () => {},
  };
}

describe('Deployer and the project config', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deploy-config-path-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'api', dependencies: { '@cogitator-ai/express': '^1.0.0' } })
    );
    writeFileSync(
      join(dir, 'cogitator.yml'),
      'llm:\n  defaultModel: ollama/qwen3.5:9b\nmemory:\n  adapter: memory\n'
    );
    mkdirSync(join(dir, 'deploy'));
    writeFileSync(
      join(dir, 'deploy', 'prod.yml'),
      'llm:\n  defaultModel: openai/gpt-6\nmemory:\n  adapter: postgres\ndeploy:\n  port: 8080\n'
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads model, services and deploy settings from the file passed as configPath', async () => {
    const deployer = new Deployer();
    deployer.registerProvider(passingProvider('custom'));

    const plan = await deployer.plan({
      projectDir: dir,
      target: 'custom',
      configPath: join(dir, 'deploy', 'prod.yml'),
      env: {},
    });

    expect(plan.config.secrets).toEqual(['OPENAI_API_KEY']);
    expect(plan.config.services).toEqual({ redis: false, postgres: true });
    expect(plan.config.port).toBe(8080);
  });

  it('reads cogitator.yml before cogitator.yaml when both exist, like loadConfig', async () => {
    writeFileSync(join(dir, 'cogitator.yaml'), 'llm:\n  defaultModel: anthropic/claude\n');
    const deployer = new Deployer();
    deployer.registerProvider(passingProvider('custom'));
    const plan = await deployer.plan({ projectDir: dir, target: 'custom', env: {} });
    expect(plan.config.secrets).toEqual([]);
  });

  it('fails preflight on project checks whatever the target', async () => {
    rmSync(join(dir, 'package.json'));
    const deployer = new Deployer();
    deployer.registerProvider(passingProvider('custom'));

    const plan = await deployer.plan({ projectDir: dir, target: 'custom', env: {} });
    expect(plan.preflight.passed).toBe(false);
    expect(plan.preflight.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(['package.json', 'ok'])
    );

    const result = await deployer.deploy({ projectDir: dir, target: 'custom', env: {} });
    expect(result.success).toBe(false);
    expect(result.error).toContain('package.json');
  });
});
