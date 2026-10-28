import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OsSandboxExecutor } from '../executors/os';
import { probeOsSandbox } from '../os/probe';
import { SandboxManager } from '../sandbox-manager';

const probe = await probeOsSandbox();

describe('SandboxManager with the os sandbox type', () => {
  let base: string;
  let root: string;
  let manager: SandboxManager;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'os-executor-')));
    root = join(base, 'work');
    await mkdir(root);
    manager = new SandboxManager({ allowNativeFallback: true });
  });

  afterEach(async () => {
    await manager.shutdown();
    await rm(base, { recursive: true, force: true });
  });

  it('reports whether the OS sandbox runs here', async () => {
    expect(await manager.isOsAvailable()).toBe(probe.available);
  });

  it.skipIf(!probe.available)('runs a command confined to its workdir', async () => {
    const result = await manager.execute(
      { command: [`echo ok > inside.txt; echo no > ${join(base, 'outside.txt')}; cat inside.txt`] },
      { type: 'os', workdir: root }
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.stdout).toBe('ok\n');
    expect(await readFile(join(root, 'inside.txt'), 'utf8')).toBe('ok\n');
    expect(existsSync(join(base, 'outside.txt'))).toBe(false);
    expect(result.data.stderr).toContain('<sandbox_violations>');
  });

  it.skipIf(!probe.available)('runs an argv command with exact arguments', async () => {
    const result = await manager.execute(
      { command: ['/bin/echo', 'a b', '$HOME'] },
      { type: 'os', workdir: root }
    );
    expect(result.success && result.data.stdout).toBe('a b $HOME\n');
  });

  it.skipIf(probe.available)(
    'fails instead of running unsandboxed when the sandbox cannot run',
    async () => {
      const result = await manager.execute({ command: ['echo hi'] }, { type: 'os', workdir: root });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toContain('cannot run here');
    }
  );

  it('never runs unsandboxed, even with failIfUnavailable: false', async () => {
    const executor = new OsSandboxExecutor({ platform: 'freebsd', onWarning: () => undefined });
    const result = await executor.execute(
      { command: [`echo ran > ${join(root, 'ran.txt')}`] },
      { type: 'os', workdir: root, os: { failIfUnavailable: false } }
    );
    await executor.disconnect();
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('cannot run here');
    expect(existsSync(join(root, 'ran.txt'))).toBe(false);
  });

  it('refuses a disabled os policy', async () => {
    const result = await manager.execute(
      { command: ['echo hi'] },
      { type: 'os', workdir: root, os: { enabled: false } }
    );
    expect(result).toEqual({
      success: false,
      error: 'The os sandbox policy is disabled (enabled: false): refusing to run',
    });
  });
});
