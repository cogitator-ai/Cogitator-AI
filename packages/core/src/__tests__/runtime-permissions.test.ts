import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DurableRunHolder } from '@cogitator-ai/types';

const manifest = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
) as { version: string };

async function freshVersionModule() {
  vi.resetModules();
  return import('../version');
}

describe('what the runtime reads without being asked', () => {
  afterEach(() => {
    vi.doUnmock('node:module');
    vi.doUnmock('node:os');
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('importing the runtime reads no file and loads no node:module', async () => {
    const actual = await vi.importActual<typeof import('node:module')>('node:module');
    const createRequire = vi.fn(actual.createRequire);
    vi.doMock('node:module', () => ({ ...actual, default: actual, createRequire }));
    const getBuiltinModule = vi.spyOn(process, 'getBuiltinModule');
    vi.resetModules();

    await import('../runtime');

    expect(createRequire).not.toHaveBeenCalled();
    expect(getBuiltinModule).not.toHaveBeenCalledWith('node:module');
  });

  it('a runtime without durable runs or plugins asks for neither host name nor home folder', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');
    const refused = (name: string) =>
      vi.fn((): string => {
        throw new Error(`Requires sys access to "${name}", run again with the --allow-sys flag`);
      });
    const hostname = refused('hostname');
    const homedir = refused('homedir');
    vi.doMock('node:os', () => ({
      ...actual,
      default: { ...actual, hostname, homedir },
      hostname,
      homedir,
    }));
    vi.resetModules();
    const { Cogitator } = await import('../runtime');

    const cog = new Cogitator({});

    expect(hostname).not.toHaveBeenCalled();
    expect(homedir).not.toHaveBeenCalled();
    const { durableHolder } = cog as unknown as { durableHolder: DurableRunHolder };
    expect(durableHolder.owner).toMatch(/^unknown-host:\d+:/);
    expect(durableHolder.owner).toBe(durableHolder.owner);
    expect(hostname).toHaveBeenCalledTimes(1);
    await cog.close();
  });

  it('takes durable.owner over the host name', async () => {
    const { Cogitator } = await import('../runtime');

    const cog = new Cogitator({ durable: { owner: 'worker-1' } });

    expect((cog as unknown as { durableHolder: DurableRunHolder }).durableHolder.owner).toBe(
      'worker-1'
    );
    await cog.close();
  });
});

describe('coreVersion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('reads the version from package.json on first use and keeps it', async () => {
    const { coreVersion } = await freshVersionModule();
    const getBuiltinModule = vi.spyOn(process, 'getBuiltinModule');

    expect(coreVersion()).toBe(manifest.version);
    expect(coreVersion()).toBe(manifest.version);
    expect(getBuiltinModule.mock.calls.filter(([id]) => id === 'node:module')).toHaveLength(1);
  });

  it('is undefined where the runtime has no Node modules', async () => {
    const { coreVersion } = await freshVersionModule();
    vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined);

    expect(coreVersion()).toBeUndefined();
  });

  it('is undefined when reading the file is refused', async () => {
    const { coreVersion } = await freshVersionModule();
    vi.spyOn(process, 'getBuiltinModule').mockImplementation(() => ({
      createRequire: () => () => {
        throw new Error('Requires read access to "package.json", run again with --allow-read');
      },
    }));

    expect(coreVersion()).toBeUndefined();
  });
});
