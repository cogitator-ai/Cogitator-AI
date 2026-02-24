import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectAnalyzer, ArtifactGenerator, Deployer } from '@cogitator-ai/deploy';

function createTempProject(pkg: Record<string, unknown> = {}, withTsConfig = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'cogitator-deploy-e2e-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test-app', ...pkg }, null, 2));
  if (withTsConfig) {
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true } }, null, 2)
    );
  }
  return dir;
}

describe('deploy E2E', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('ProjectAnalyzer', () => {
    it('analyzes a project with express server', () => {
      tmpDir = createTempProject({
        dependencies: { '@cogitator-ai/express': '^0.1.0' },
      });
      const analyzer = new ProjectAnalyzer();
      const result = analyzer.analyze(tmpDir);
      expect(result.server).toBe('express');
      expect(result.hasTypeScript).toBe(true);
    });

    it('analyzes a project without a server', () => {
      tmpDir = createTempProject({ dependencies: {} });
      const analyzer = new ProjectAnalyzer();
      const result = analyzer.analyze(tmpDir);
      expect(result.server).toBeUndefined();
    });

    it('detects missing tsconfig.json', () => {
      tmpDir = createTempProject({}, false);
      const analyzer = new ProjectAnalyzer();
      const result = analyzer.analyze(tmpDir);
      expect(result.hasTypeScript).toBe(false);
    });

    it('applies config overrides', () => {
      tmpDir = createTempProject({ dependencies: {} });
      const analyzer = new ProjectAnalyzer();
      const result = analyzer.analyze(tmpDir, { server: 'hono', port: 8080 });
      expect(result.server).toBe('hono');
      expect(result.deployConfig.port).toBe(8080);
    });

    it('analyzes project with missing package.json gracefully', () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'cogitator-deploy-e2e-'));
      const analyzer = new ProjectAnalyzer();
      const result = analyzer.analyze(tmpDir);
      expect(result.server).toBeUndefined();
      expect(result.hasTypeScript).toBe(false);
    });
  });

  describe('ArtifactGenerator', () => {
    it('generates docker artifacts with postgres service', () => {
      const generator = new ArtifactGenerator();
      const artifacts = generator.generate(
        { target: 'docker', port: 3000, services: { redis: false, postgres: true } },
        { hasTypeScript: true }
      );
      const compose = artifacts.files.find((f) => f.path === 'docker-compose.prod.yml');
      expect(compose).toBeDefined();
      expect(compose!.content).toContain('postgres');
      expect(compose!.content).toContain('pgvector');
      expect(compose!.content).toContain('DATABASE_URL');
    });

    it('generates JavaScript dockerfile without builder stage', () => {
      const generator = new ArtifactGenerator();
      const artifacts = generator.generate(
        { target: 'docker', port: 4000 },
        { hasTypeScript: false }
      );
      const dockerfile = artifacts.files.find((f) => f.path === 'Dockerfile');
      expect(dockerfile).toBeDefined();
      expect(dockerfile!.content).not.toContain('AS builder');
      expect(dockerfile!.content).toContain('src/server.js');
      expect(dockerfile!.content).toContain('EXPOSE 4000');
    });

    it('fly target does not include docker-compose', () => {
      const generator = new ArtifactGenerator();
      const artifacts = generator.generate({ target: 'fly', port: 3000 }, { hasTypeScript: true });
      const compose = artifacts.files.find((f) => f.path === 'docker-compose.prod.yml');
      const flyToml = artifacts.files.find((f) => f.path === 'fly.toml');
      expect(compose).toBeUndefined();
      expect(flyToml).toBeDefined();
    });

    it('generates valid fly.toml with custom region', () => {
      const generator = new ArtifactGenerator();
      const artifacts = generator.generate(
        { target: 'fly', port: 3000, region: 'lhr', image: 'my-agent' },
        { hasTypeScript: true }
      );
      const flyToml = artifacts.files.find((f) => f.path === 'fly.toml');
      expect(flyToml!.content).toContain('primary_region = "lhr"');
      expect(flyToml!.content).toContain('app = "my-agent"');
    });

    it('parses memory with gb suffix correctly in fly.toml', () => {
      const generator = new ArtifactGenerator();
      const artifacts = generator.generate(
        { target: 'fly', port: 3000, resources: { memory: '1gb', cpu: 2 } },
        { hasTypeScript: true }
      );
      const flyToml = artifacts.files.find((f) => f.path === 'fly.toml');
      expect(flyToml!.content).toContain('memory = "1024mb"');
      expect(flyToml!.content).toContain('cpus = 2');
    });

    it('outputDir is .cogitator', () => {
      const generator = new ArtifactGenerator();
      const artifacts = generator.generate(
        { target: 'docker', port: 3000 },
        { hasTypeScript: true }
      );
      expect(artifacts.outputDir).toBe('.cogitator');
    });
  });

  describe('Deployer', () => {
    it('registers both providers by default', () => {
      const deployer = new Deployer();
      expect(deployer.getProvider('docker').name).toBe('docker');
      expect(deployer.getProvider('fly').name).toBe('fly');
    });

    it('plan returns correct config with target', async () => {
      tmpDir = createTempProject({ dependencies: { '@cogitator-ai/hono': '^0.1.0' } });
      const deployer = new Deployer();
      const plan = await deployer.plan({
        projectDir: tmpDir,
        target: 'docker',
        configOverrides: { port: 8888 },
      });
      expect(plan.config.target).toBe('docker');
      expect(plan.config.port).toBe(8888);
      expect(plan.preflight).toBeDefined();
    });

    it('dry run deploy returns success without executing', async () => {
      tmpDir = createTempProject({ dependencies: {} });
      const deployer = new Deployer();
      const result = await deployer.deploy({
        projectDir: tmpDir,
        target: 'docker',
        dryRun: true,
      });
      expect(result.success).toBe(true);
      expect(result.url).toBe('(dry run)');
    });

    it('noPush removes registry from config', async () => {
      tmpDir = createTempProject({ dependencies: {} });
      const deployer = new Deployer();
      const plan = await deployer.plan({
        projectDir: tmpDir,
        target: 'docker',
        noPush: true,
        configOverrides: { registry: 'ghcr.io/myorg' },
      });
      expect(plan.config.registry).toBeUndefined();
    });
  });
});
