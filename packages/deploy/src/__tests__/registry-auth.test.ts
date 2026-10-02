import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isRegistryAuthenticated, registryHost } from '../utils/registry-auth';

describe('registryHost', () => {
  it('extracts the host from registry references', () => {
    expect(registryHost('ghcr.io/acme')).toBe('ghcr.io');
    expect(registryHost('https://registry.example.com:5000/team')).toBe(
      'registry.example.com:5000'
    );
    expect(registryHost('localhost:5000')).toBe('localhost:5000');
    expect(registryHost('acme')).toBe('docker.io');
  });
});

describe('isRegistryAuthenticated', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'deploy-docker-config-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const writeConfig = (config: unknown) =>
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));

  it('returns false without a docker config', () => {
    expect(isRegistryAuthenticated('ghcr.io/acme', dir)).toBe(false);
  });

  it('detects inline auth entries', () => {
    writeConfig({ auths: { 'ghcr.io': { auth: 'dXNlcjpwYXNz' } } });
    expect(isRegistryAuthenticated('ghcr.io/acme', dir)).toBe(true);
    expect(isRegistryAuthenticated('quay.io/acme', dir)).toBe(false);
  });

  it('maps Docker Hub namespaces to index.docker.io', () => {
    writeConfig({ auths: { 'https://index.docker.io/v1/': { auth: 'x' } } });
    expect(isRegistryAuthenticated('acme', dir)).toBe(true);
  });

  it('does not treat empty auth entries as logged in', () => {
    writeConfig({ auths: { 'ghcr.io': {} } });
    expect(isRegistryAuthenticated('ghcr.io/acme', dir)).toBe(false);
  });

  it('returns false when the configured credential helper is unavailable', () => {
    writeConfig({ credHelpers: { 'ghcr.io': 'definitely-missing-helper' } });
    expect(isRegistryAuthenticated('ghcr.io/acme', dir)).toBe(false);
  });

  it('handles malformed config files', () => {
    writeFileSync(join(dir, 'config.json'), '{');
    expect(isRegistryAuthenticated('ghcr.io', dir)).toBe(false);
  });
});
