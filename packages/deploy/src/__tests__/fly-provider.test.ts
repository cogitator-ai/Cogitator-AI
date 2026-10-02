import { describe, it, expect } from 'vitest';
import { FlyProvider, formatSecretsForImport } from '../providers/fly';

describe('FlyProvider', () => {
  const provider = new FlyProvider();

  it('has correct name', () => {
    expect(provider.name).toBe('fly');
  });

  it('preflight checks for flyctl availability', async () => {
    const config = { target: 'fly' as const, port: 3000 };
    const result = await provider.preflight(config, process.cwd());
    const flyCheck = result.checks.find((c) => c.name === 'flyctl installed');
    expect(flyCheck).toBeDefined();
  });

  it('preflight checks for fly auth', async () => {
    const config = { target: 'fly' as const, port: 3000 };
    const result = await provider.preflight(config, process.cwd());
    const authCheck = result.checks.find((c) => c.name === 'Fly.io authenticated');
    expect(authCheck).toBeDefined();
  });
});

describe('formatSecretsForImport', () => {
  it('builds NAME=VALUE lines for set secrets only', () => {
    const { payload, skipped } = formatSecretsForImport(['A', 'B', 'C'], { A: '1', C: 'x=y' });
    expect(payload).toBe('A=1\nC=x=y');
    expect(skipped).toEqual([]);
  });

  it('flags multi-line values which fly secrets import cannot represent', () => {
    expect(formatSecretsForImport(['KEY'], { KEY: 'line1\nline2' }).skipped).toEqual(['KEY']);
  });
});
