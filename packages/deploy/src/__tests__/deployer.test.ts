import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DeployConfig, GeneratedArtifacts } from '@cogitator-ai/types';
import { Deployer } from '../deployer';
import { DockerProvider } from '../providers/docker';

describe('Deployer', () => {
  it('resolves docker provider', () => {
    const deployer = new Deployer();
    const provider = deployer.getProvider('docker');
    expect(provider.name).toBe('docker');
  });

  it('resolves fly provider', () => {
    const deployer = new Deployer();
    const provider = deployer.getProvider('fly');
    expect(provider.name).toBe('fly');
  });

  it('throws for unknown provider', () => {
    const deployer = new Deployer();
    expect(() => deployer.getProvider('k8s')).toThrow('Available: docker, fly');
  });
});

describe('Deployer.availableTargets', () => {
  it('lists only targets with a registered provider', () => {
    expect(new Deployer().availableTargets()).toEqual(['docker', 'fly']);
  });
});

describe('custom providers', () => {
  it('can be registered and used by name', async () => {
    const deployer = new Deployer();
    const provider = {
      name: 'custom',
      preflight: async () => ({ checks: [], passed: true }),
      generate: async () => ({ files: [], outputDir: '.cogitator' }),
      deploy: async () => ({ success: true, url: 'custom://deployed' }),
      status: async () => ({ running: true }),
      destroy: async () => {},
    };
    deployer.registerProvider(provider);

    expect(deployer.availableTargets()).toContain('custom');
    const plan = await deployer.plan({ projectDir: process.cwd(), target: 'custom' });
    expect(plan.provider).toBe(provider);
    expect(plan.config.target).toBeUndefined();
    expect((await deployer.status('custom', {}, process.cwd())).running).toBe(true);
  });
});

describe('Deployer.deploy', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deploy-deployer-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("deploys the artifacts the target's provider generates", async () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'api', dependencies: { '@cogitator-ai/express': 'latest' } })
    );
    const artifacts: GeneratedArtifacts = {
      files: [{ path: 'Procfile', content: 'web: node server.js' }],
      outputDir: '.cogitator',
    };
    const generate = vi.fn(async (_config: DeployConfig, _projectDir: string) => artifacts);
    const deploy = vi.fn(async () => ({ success: true, url: 'custom://deployed' }));
    const deployer = new Deployer();
    deployer.registerProvider({
      name: 'custom',
      preflight: async () => ({ checks: [], passed: true }),
      generate,
      deploy,
      status: async () => ({ running: true }),
      destroy: async () => {},
    });

    const result = await deployer.deploy({ projectDir: dir, target: 'custom' });

    expect(result).toEqual({ success: true, url: 'custom://deployed' });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ port: 3000 }), dir);
    expect(deploy).toHaveBeenCalledWith(expect.objectContaining({ port: 3000 }), artifacts, dir);
  });

  it("probes the health path the project's cogitator.yml configures", async () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'api',
        scripts: { start: 'node dist/index.js' },
        dependencies: { '@cogitator-ai/express': 'latest' },
      })
    );
    writeFileSync(join(dir, 'cogitator.yml'), 'deploy:\n  health:\n    path: /api/health\n');
    const deployer = new Deployer();

    const docker = await deployer.plan({ projectDir: dir, target: 'docker', noPush: true });
    const fly = await deployer.plan({ projectDir: dir, target: 'fly', noPush: true });
    const dockerfile = (await docker.provider.generate(docker.config, dir)).files.find(
      (f) => f.path === 'Dockerfile'
    )?.content;
    const flyToml = (await fly.provider.generate(fly.config, dir)).files.find(
      (f) => f.path === 'fly.toml'
    )?.content;

    expect(dockerfile).toContain('http://127.0.0.1:3000/api/health');
    expect(flyToml).toContain('path = "/api/health"');
  });

  it('builds the Dockerfile from the detected package manager and start command', async () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { start: 'node dist/main.js', build: 'tsc' } })
    );
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    writeFileSync(join(dir, 'tsconfig.json'), '{}');

    const artifacts = await new DockerProvider().generate({ port: 3000 }, dir);
    const dockerfile = artifacts.files.find((f) => f.path === 'Dockerfile')?.content;

    expect(dockerfile).toContain('target=/root/.npm npm ci');
    expect(dockerfile).toContain('CMD ["node","dist/main.js"]');
  });
});
