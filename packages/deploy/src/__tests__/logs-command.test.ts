import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DeployConfig } from '@cogitator-ai/types';
import { Deployer } from '../deployer';
import { DockerProvider } from '../providers/docker';
import type { DeployProvider } from '../providers/base';

describe('DockerProvider.logsCommand', () => {
  let dir: string;
  const provider = new DockerProvider();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deploy-logs-'));
    mkdirSync(join(dir, '.cogitator'));
    writeFileSync(join(dir, '.cogitator', 'docker-compose.prod.yml'), 'services: {}\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const composeFile = () => join(dir, '.cogitator', 'docker-compose.prod.yml');

  it('shows the last 100 lines of every service of the compose project', () => {
    const command = provider.logsCommand({ image: 'api' }, dir);

    expect(command.command).toBe('docker');
    expect(command.args).toEqual([
      'compose',
      '-p',
      'api',
      '-f',
      composeFile(),
      'logs',
      '--tail',
      '100',
    ]);
    expect(command.cwd).toBe(dir);
    expect(command.env).toBeDefined();
  });

  it('follows one service with timestamps and the tail asked for', () => {
    const command = provider.logsCommand({ image: 'api' }, dir, {
      follow: true,
      tail: 'all',
      timestamps: true,
      service: 'ollama-pull',
    });

    expect(command.args.slice(5)).toEqual([
      'logs',
      '--follow',
      '--tail',
      'all',
      '--timestamps',
      'ollama-pull',
    ]);
  });

  it('refuses a service or tail that would read as a flag', () => {
    expect(() => provider.logsCommand({}, dir, { service: '--help' })).toThrow(/service name/);
    expect(() => provider.logsCommand({}, dir, { tail: '-5' })).toThrow(/number of lines/);
  });

  it('fails without a docker deployment', () => {
    rmSync(join(dir, '.cogitator'), { recursive: true });
    expect(() => provider.logsCommand({}, dir)).toThrow(/No docker deployment found/);
  });
});

describe('Deployer.logsCommand', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deployer-logs-'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'acme-api', dependencies: { '@cogitator-ai/express': '^1.0.0' } })
    );
    writeFileSync(join(dir, 'cogitator.yml'), 'deploy:\n  app: acme-prod\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const silentProvider = (): DeployProvider => ({
    name: 'custom',
    preflight: async () => ({ checks: [], passed: true }),
    generate: async () => ({ files: [], outputDir: '.cogitator' }),
    deploy: async () => ({ success: true }),
    status: async () => ({ running: false }),
    destroy: async () => undefined,
  });

  function recordingProvider(): DeployProvider & { seen: DeployConfig[] } {
    const seen: DeployConfig[] = [];
    return {
      ...silentProvider(),
      seen,
      logsCommand: (config, _projectDir, options) => {
        seen.push(config);
        return { command: 'logs', args: options.follow ? ['-f'] : [] };
      },
    };
  }

  it('hands the provider the config resolved from the project', () => {
    const deployer = new Deployer();
    const provider = recordingProvider();
    deployer.registerProvider(provider);

    const command = deployer.logsCommand('custom', {}, dir, { follow: true });

    expect(command).toEqual({ command: 'logs', args: ['-f'] });
    expect(provider.seen[0]).toMatchObject({ app: 'acme-prod', image: 'acme-api' });
  });

  it('fails for a provider without logs', () => {
    const deployer = new Deployer();
    deployer.registerProvider(silentProvider());
    expect(() => deployer.logsCommand('custom', {}, dir)).toThrow(/has no logs command/);
  });
});
