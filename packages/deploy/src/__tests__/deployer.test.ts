import { describe, it, expect } from 'vitest';
import { Deployer } from '../deployer';

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
