import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DaytonaWorkspace,
  E2BWorkspace,
  RemoteShellWorkspace,
  VercelSandboxWorkspace,
} from '@cogitator-ai/sandbox';
import { hasRemoteShellTools, LocalShellDriver } from '../../helpers/local-shell-driver';

const localBase = realpathSync(mkdtempSync(join(tmpdir(), 'remote-workspace-e2e-')));
afterAll(() => rmSync(localBase, { recursive: true, force: true }));

const vercelCredentials =
  !!process.env.VERCEL_OIDC_TOKEN ||
  (!!process.env.VERCEL_TOKEN && !!process.env.VERCEL_TEAM_ID && !!process.env.VERCEL_PROJECT_ID);

const providers: { name: string; enabled: boolean; make: () => RemoteShellWorkspace }[] = [
  {
    name: 'a local shell',
    enabled: hasRemoteShellTools(),
    make: () => new RemoteShellWorkspace({ driver: new LocalShellDriver(join(localBase, 'root')) }),
  },
  {
    name: 'E2B',
    enabled: !!process.env.E2B_API_KEY,
    make: () => new E2BWorkspace({ root: 'cogitator-e2e', lifetime: 10 * 60_000 }),
  },
  {
    name: 'Daytona',
    enabled: !!process.env.DAYTONA_API_KEY,
    make: () => new DaytonaWorkspace({ root: 'cogitator-e2e', autoStopInterval: 15 }),
  },
  {
    name: 'Vercel Sandbox',
    enabled: vercelCredentials,
    make: () => new VercelSandboxWorkspace({ root: 'cogitator-e2e', lifetime: 10 * 60_000 }),
  },
];

for (const provider of providers) {
  describe.skipIf(!provider.enabled)(`RemoteShellWorkspace on ${provider.name}`, () => {
    let workspace: RemoteShellWorkspace;

    beforeAll(async () => {
      workspace = provider.make();
      await workspace.start();
    }, 180_000);

    afterAll(async () => {
      await workspace?.dispose();
    }, 120_000);

    it('reads and writes files and lists them in order', async () => {
      const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
      await workspace.write('src/data.bin', bytes);
      await workspace.write('src/a.ts', 'export const a = 1;\n');
      await workspace.write("src/it's here.txt", 'quoted\n');
      expect(
        Buffer.from(await workspace.readBytes('src/data.bin')).equals(Buffer.from(bytes))
      ).toBe(true);
      expect(await workspace.read("src/it's here.txt")).toBe('quoted\n');
      const entries = await workspace.list('src');
      expect(entries.map((entry) => entry.name)).toEqual(['a.ts', 'data.bin', "it's here.txt"]);
      expect(await workspace.stat('src/a.ts')).toMatchObject({ type: 'file', size: 20 });
    });

    it('runs commands in the root with streamed output and exit codes', async () => {
      const chunks: string[] = [];
      const result = await workspace.exec('cat src/a.ts; echo oops >&2; exit 4', {
        onStdout: (chunk) => chunks.push(chunk),
      });
      expect(result).toMatchObject({
        stdout: 'export const a = 1;\n',
        stderr: 'oops\n',
        exitCode: 4,
        timedOut: false,
      });
      expect(chunks.join('')).toBe(result.stdout);
      expect((await workspace.exec('pwd', { cwd: 'src' })).stdout.trim()).toBe(
        `${workspace.root}/src`
      );
    });

    it('refuses a symlink out of the root that a command made', async () => {
      await workspace.exec('ln -sf /etc leak');
      await expect(workspace.read('leak/passwd')).rejects.toMatchObject({ code: 'OUTSIDE_ROOT' });
      await workspace.remove('leak');
    });

    it('kills the command group on a timeout', async () => {
      const result = await workspace.exec('sleep 91 & echo $! > bg.pid; sleep 92', {
        timeout: 2_000,
      });
      expect(result).toMatchObject({ timedOut: true, exitCode: 124 });
      await vi.waitFor(
        async () => {
          const left = await workspace.exec(
            'kill -0 "$(cat bg.pid)" 2>/dev/null && echo alive || echo dead'
          );
          expect(left.stdout.trim()).toBe('dead');
        },
        { timeout: 30_000, interval: 500 }
      );
    }, 90_000);

    it('trashes, renames and restores a snapshot', async () => {
      const snapshot = await workspace.snapshot({ label: 'e2e' });
      await workspace.rename('src/a.ts', 'src/b.ts');
      const trashed = await workspace.remove('src/data.bin', { trash: true });
      expect(trashed.trashedTo).toMatch(/^\.cogitator\/trash\//);
      await workspace.write('new.txt', 'new');
      await workspace.restore(snapshot.id);
      expect(await workspace.exists('src/a.ts')).toBe(true);
      expect(await workspace.exists('src/b.ts')).toBe(false);
      expect(await workspace.exists('src/data.bin')).toBe(true);
      expect(await workspace.exists('new.txt')).toBe(false);
      expect((await workspace.listSnapshots()).map((entry) => entry.id)).toContain(snapshot.id);
      await workspace.deleteSnapshot(snapshot.id);
    }, 90_000);
  });
}
