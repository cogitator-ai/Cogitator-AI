import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveDeployInputs } from '../commands/deploy.js';

describe('resolveDeployInputs', () => {
  let dir: string;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-deploy-'));
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('COGITATOR_DEPLOY_')) delete process.env[key];
    }
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...saved };
  });

  it('hands the -c file to the deployer and takes its target', () => {
    mkdirSync(join(dir, 'deploy'));
    writeFileSync(join(dir, 'cogitator.yml'), 'deploy:\n  target: docker\n');
    writeFileSync(join(dir, 'deploy', 'prod.yml'), 'deploy:\n  target: fly\n');

    const inputs = resolveDeployInputs(dir, { config: 'deploy/prod.yml' });

    expect(inputs.configPath).toBe(join(dir, 'deploy', 'prod.yml'));
    expect(inputs.target).toBe('fly');
  });

  it('finds .cogitator.yml like loadConfig does', () => {
    writeFileSync(join(dir, '.cogitator.yml'), 'deploy:\n  target: fly\n');
    expect(resolveDeployInputs(dir, {})).toMatchObject({
      configPath: join(dir, '.cogitator.yml'),
      target: 'fly',
    });
  });

  it('lets --target, then COGITATOR_DEPLOY_TARGET, win over the file', () => {
    writeFileSync(join(dir, 'cogitator.yml'), 'deploy:\n  target: fly\n');
    process.env.COGITATOR_DEPLOY_TARGET = 'docker';
    expect(resolveDeployInputs(dir, {}).target).toBe('docker');
    expect(resolveDeployInputs(dir, { target: 'custom' }).target).toBe('custom');
  });

  it('passes flags and COGITATOR_DEPLOY_* as overrides, never the whole file', () => {
    writeFileSync(join(dir, 'cogitator.yml'), 'deploy:\n  port: 8080\n  secrets: [A]\n');
    process.env.COGITATOR_DEPLOY_REGISTRY = 'ghcr.io/acme';
    expect(resolveDeployInputs(dir, { region: 'ams' }).overrides).toEqual({
      registry: 'ghcr.io/acme',
      region: 'ams',
    });
  });

  it('fails on a missing -c file', () => {
    expect(() => resolveDeployInputs(dir, { config: 'nope.yml' })).toThrow(/not found/);
  });
});
