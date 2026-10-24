import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FlyProvider, formatSecretsForImport } from '../providers/fly';
import { isCommandAvailable, run } from '../utils/exec';

vi.mock('../utils/exec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/exec')>();
  return { ...actual, run: vi.fn(), isCommandAvailable: vi.fn() };
});

const runMock = vi.mocked(run);
const commandAvailable = vi.mocked(isCommandAvailable);

beforeEach(() => {
  commandAvailable.mockImplementation((command) => command === 'fly');
  runMock.mockReturnValue({ success: true, output: 'dev@example.com' });
});

afterEach(() => vi.resetAllMocks());

describe('FlyProvider', () => {
  const provider = new FlyProvider();

  it('has correct name', () => {
    expect(provider.name).toBe('fly');
  });

  it('passes preflight with the installed binary and a logged-in account', async () => {
    const result = await provider.preflight({ target: 'fly', port: 3000 }, process.cwd());

    expect(result.checks).toEqual([
      expect.objectContaining({ name: 'flyctl installed', passed: true }),
      expect.objectContaining({
        name: 'Fly.io authenticated',
        passed: true,
        message: 'Logged in as dev@example.com',
      }),
    ]);
    expect(result.passed).toBe(true);
    expect(runMock).toHaveBeenCalledWith(
      'fly',
      ['auth', 'whoami'],
      expect.objectContaining({ timeout: expect.any(Number) })
    );
  });

  it('asks to log in when the account is not authenticated', async () => {
    runMock.mockReturnValue({ success: false, output: '', error: 'not logged in' });

    const result = await provider.preflight({ target: 'fly', port: 3000 }, process.cwd());

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: 'Fly.io authenticated',
        passed: false,
        fix: 'Run: fly auth login',
      })
    );
    expect(result.passed).toBe(false);
  });

  it('reports a missing flyctl without calling it', async () => {
    commandAvailable.mockReturnValue(false);

    const result = await provider.preflight({ target: 'fly', port: 3000 }, process.cwd());

    expect(result.checks.map((c) => [c.name, c.passed])).toEqual([
      ['flyctl installed', false],
      ['Fly.io authenticated', false],
    ]);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('fails preflight on an app name Fly would refuse, before calling flyctl with it', async () => {
    const result = await provider.preflight({ target: 'fly', image: 'Acme_API' }, process.cwd());

    expect(result.checks[0]).toMatchObject({
      name: 'Fly app name',
      passed: false,
      message: '"Acme_API" is not a valid Fly app name (taken from deploy.image)',
    });
    expect(result.passed).toBe(false);
  });

  it('checks deploy.app over the image and the organization slug', async () => {
    const valid = await provider.preflight(
      { target: 'fly', image: 'Acme_API', app: 'acme-api', org: 'acme' },
      process.cwd()
    );
    expect(valid.passed).toBe(true);

    const invalid = await provider.preflight(
      { target: 'fly', app: '-acme', org: '--help' },
      process.cwd()
    );
    expect(invalid.checks.filter((c) => !c.passed).map((c) => c.name)).toEqual([
      'Fly app name',
      'Fly organization',
    ]);
  });
});

describe('FlyProvider.logsCommand', () => {
  const provider = new FlyProvider();

  it('prints the recent logs of the app and exits', () => {
    expect(provider.logsCommand({ app: 'acme-api', image: 'api' }, '/srv/app')).toEqual({
      command: 'fly',
      args: ['logs', '--app', 'acme-api', '--no-tail'],
      cwd: '/srv/app',
    });
  });

  it('streams with follow, from the image name without deploy.app', () => {
    expect(provider.logsCommand({ image: 'api' }, '/srv/app', { follow: true }).args).toEqual([
      'logs',
      '--app',
      'api',
    ]);
  });

  it('refuses options flyctl logs has no equivalent of', () => {
    expect(() => provider.logsCommand({ app: 'api' }, '/srv', { service: 'ollama' })).toThrow(
      /no service name/
    );
    expect(() => provider.logsCommand({ app: 'api' }, '/srv', { tail: '50' })).toThrow(
      /no line count/
    );
  });

  it('fails without flyctl', () => {
    commandAvailable.mockReturnValue(false);
    expect(() => provider.logsCommand({ app: 'api' }, '/srv')).toThrow(/not installed/);
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
