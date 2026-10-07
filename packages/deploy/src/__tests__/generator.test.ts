import { describe, it, expect } from 'vitest';
import { ArtifactGenerator } from '../generator';
import type { DeployConfig } from '@cogitator-ai/types';

describe('ArtifactGenerator', () => {
  const generator = new ArtifactGenerator();

  it('generates Dockerfile for docker target', () => {
    const config: DeployConfig = { target: 'docker', server: 'express', port: 3000 };
    const artifacts = generator.generate(config, { hasTypeScript: true });
    const dockerfile = artifacts.files.find((f) => f.path === 'Dockerfile');
    expect(dockerfile).toBeDefined();
    expect(dockerfile!.content).toContain('FROM node:24-alpine AS base');
    expect(dockerfile!.content).toContain('EXPOSE 3000');
  });

  it('generates docker-compose.prod.yml with redis when services.redis=true', () => {
    const config: DeployConfig = {
      target: 'docker',
      server: 'express',
      port: 3000,
      services: { redis: true },
    };
    const artifacts = generator.generate(config, { hasTypeScript: true });
    const compose = artifacts.files.find((f) => f.path === 'docker-compose.prod.yml');
    expect(compose).toBeDefined();
    expect(compose!.content).toContain('redis');
  });

  it('generates fly.toml for fly target', () => {
    const config: DeployConfig = {
      target: 'fly',
      server: 'express',
      port: 3000,
      region: 'iad',
    };
    const artifacts = generator.generate(config, { hasTypeScript: true });
    const flyToml = artifacts.files.find((f) => f.path === 'fly.toml');
    expect(flyToml).toBeDefined();
    expect(flyToml!.content).toContain('internal_port = 3000');
    expect(flyToml!.content).toContain('primary_region');
  });

  it('generates .dockerignore', () => {
    const config: DeployConfig = { target: 'docker', port: 3000 };
    const artifacts = generator.generate(config, { hasTypeScript: true });
    const ignore = artifacts.files.find((f) => f.path === '.dockerignore');
    expect(ignore).toBeDefined();
    expect(ignore!.content).toContain('node_modules');
    for (const artifact of ['.pnp.cjs', '.pnp.loader.mjs', '.yarn/cache', '.yarn/install-state.gz'])
      expect(ignore!.content.split('\n')).toContain(artifact);
    expect(ignore!.content).not.toMatch(/^\.yarn\/?$/m);
  });

  it('includes multi-stage build for TypeScript projects', () => {
    const config: DeployConfig = { target: 'docker', port: 3000 };
    const artifacts = generator.generate(config, { hasTypeScript: true });
    const dockerfile = artifacts.files.find((f) => f.path === 'Dockerfile');
    expect(dockerfile!.content).toContain('AS builder');
    expect(dockerfile!.content).toContain('AS runtime');
  });

  it('generates single-stage Dockerfile for non-TypeScript projects', () => {
    const config: DeployConfig = { target: 'docker', port: 4000 };
    const artifacts = generator.generate(config, { hasTypeScript: false });
    const dockerfile = artifacts.files.find((f) => f.path === 'Dockerfile');
    expect(dockerfile!.content).not.toContain('AS builder');
    expect(dockerfile!.content).toContain('src/server.js');
    expect(dockerfile!.content).toContain('EXPOSE 4000');
    expect(dockerfile!.content).toContain('--prod');
  });

  it('parses gb memory suffix correctly in fly.toml', () => {
    const config: DeployConfig = {
      target: 'fly',
      port: 3000,
      resources: { memory: '1gb', cpu: 2 },
    };
    const artifacts = generator.generate(config, { hasTypeScript: true });
    const flyToml = artifacts.files.find((f) => f.path === 'fly.toml');
    expect(flyToml!.content).toContain('memory = "1024mb"');
    expect(flyToml!.content).toContain('cpus = 2');
  });

  it('parses mb memory suffix correctly in fly.toml', () => {
    const config: DeployConfig = {
      target: 'fly',
      port: 3000,
      resources: { memory: '512mb', cpu: 1 },
    };
    const artifacts = generator.generate(config, { hasTypeScript: true });
    const flyToml = artifacts.files.find((f) => f.path === 'fly.toml');
    expect(flyToml!.content).toContain('memory = "512mb"');
  });

  it('fly target does not generate docker-compose', () => {
    const config: DeployConfig = { target: 'fly', port: 3000 };
    const artifacts = generator.generate(config, { hasTypeScript: true });
    const compose = artifacts.files.find((f) => f.path === 'docker-compose.prod.yml');
    expect(compose).toBeUndefined();
  });

  it('docker target does not generate fly.toml', () => {
    const config: DeployConfig = { target: 'docker', port: 3000 };
    const artifacts = generator.generate(config, { hasTypeScript: true });
    const flyToml = artifacts.files.find((f) => f.path === 'fly.toml');
    expect(flyToml).toBeUndefined();
  });

  it('outputDir is always .cogitator', () => {
    const config: DeployConfig = { target: 'docker', port: 3000 };
    const artifacts = generator.generate(config, { hasTypeScript: true });
    expect(artifacts.outputDir).toBe('.cogitator');
  });
});

describe('ArtifactGenerator dockerignore', () => {
  it('emits a Dockerfile-specific ignore file so .env never enters the build context', () => {
    const artifacts = new ArtifactGenerator().generate(
      { target: 'docker' },
      { hasTypeScript: true }
    );
    const ignore = artifacts.files.find((f) => f.path === 'Dockerfile.dockerignore');
    expect(ignore?.content).toContain('.env');
    expect(ignore?.content).toContain('node_modules');
  });
});
