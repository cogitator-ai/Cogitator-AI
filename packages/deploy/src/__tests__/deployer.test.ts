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
    expect(() => deployer.getProvider('unknown' as any)).toThrow();
  });
});
