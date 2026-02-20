import { describe, it, expect } from 'vitest';
import { DockerProvider } from '../providers/docker';

describe('DockerProvider', () => {
  const provider = new DockerProvider();

  it('has correct name', () => {
    expect(provider.name).toBe('docker');
  });

  it('preflight checks for docker availability', async () => {
    const config = { target: 'docker' as const, port: 3000 };
    const result = await provider.preflight(config, process.cwd());
    const dockerCheck = result.checks.find((c) => c.name === 'Docker installed');
    expect(dockerCheck).toBeDefined();
  });

  it('preflight checks for registry auth when registry specified', async () => {
    const config = { target: 'docker' as const, port: 3000, registry: 'ghcr.io/test' };
    const result = await provider.preflight(config, process.cwd());
    const registryCheck = result.checks.find((c) => c.name === 'Registry authentication');
    expect(registryCheck).toBeDefined();
  });
});
