import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WorkspaceError, type Workspace, type WorkspaceStat } from '@cogitator-ai/types';
import { DockerWorkspace, WORKSPACE_CONTAINER_LABEL } from '../workspace/docker-workspace';
import { dockerConnectionCandidates } from '../utils/docker-connection';
import type { Docker } from '../docker-types';

async function dockerAvailable(): Promise<boolean> {
  try {
    const Dockerode = (await import('dockerode')).default;
    for (const options of dockerConnectionCandidates()) {
      try {
        await (new Dockerode(options) as unknown as Docker).ping();
        return true;
      } catch {
        continue;
      }
    }
  } catch {
    return false;
  }
  return false;
}

const hasDocker = await dockerAvailable();

/**
 * A host workspace for these tests: a plain directory, only what DockerWorkspace asks of it.
 * The path guard itself is LocalWorkspace's, covered in core and in the e2e suite.
 */
function directoryHost(root: string): Workspace & { disposed: boolean } {
  const unsupported = () => Promise.reject(new WorkspaceError('UNSUPPORTED', 'not in this test'));
  return {
    id: 'host',
    root,
    cwd: '.',
    disposed: false,
    start: async () => undefined,
    async dispose() {
      this.disposed = true;
    },
    contains: async () => true,
    async stat(path): Promise<WorkspaceStat> {
      const full = join(root, path);
      const info = await stat(full);
      return {
        path: relative(root, full) || '.',
        type: info.isDirectory() ? 'directory' : 'file',
        size: info.size,
        modifiedAt: info.mtimeMs,
      };
    },
    read: (path) => Promise.resolve(readFileSync(join(root, path), 'utf8')),
    readBytes: unsupported,
    write: unsupported,
    list: unsupported,
    exists: unsupported,
    mkdir: unsupported,
    remove: unsupported,
    rename: unsupported,
    exec: unsupported,
  };
}

describe('DockerWorkspace without Docker', () => {
  it('says Docker is unavailable when it cannot be reached', async () => {
    const workspace = new DockerWorkspace({
      host: directoryHost(tmpdir()),
      docker: { socketPath: join(tmpdir(), 'no-such-docker.sock') },
    });
    const error = await workspace.start().then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect(WorkspaceError.is(error, 'UNAVAILABLE')).toBe(true);
    expect((error as Error).message).toContain('Docker is not reachable');
  });

  it('refuses to run before start and refuses network allow-lists', async () => {
    const workspace = new DockerWorkspace({ host: directoryHost(tmpdir()) });
    await expect(workspace.exec('true')).rejects.toMatchObject({ code: 'NOT_STARTED' });
    expect(
      () =>
        new DockerWorkspace({
          host: directoryHost(tmpdir()),
          network: { mode: 'bridge', allowedHosts: ['example.com'] },
        })
    ).toThrow(/allowedHosts/);
  });
});

describe.skipIf(!hasDocker)('DockerWorkspace with Docker', () => {
  let base: string;
  let host: ReturnType<typeof directoryHost>;
  let workspace: DockerWorkspace;

  beforeAll(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'docker-workspace-')));
    mkdirSync(join(base, 'pkg'));
    host = directoryHost(base);
    workspace = new DockerWorkspace({ host, image: 'alpine:3.19', id: 'test-ws' });
    await workspace.start();
  }, 120_000);

  afterAll(async () => {
    await workspace?.dispose();
    rmSync(base, { recursive: true, force: true });
  });

  it('runs commands in one long-lived container on the mounted root', async () => {
    const first = await workspace.exec('echo hello > from-container.txt && hostname');
    const second = await workspace.exec('hostname');
    expect(first.exitCode).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(readFileSync(join(base, 'from-container.txt'), 'utf8')).toBe('hello\n');
    expect(await workspace.read('from-container.txt')).toBe('hello\n');
  });

  it('maps the working directory into the container', async () => {
    expect((await workspace.exec('pwd')).stdout.trim()).toBe('/workspace');
    expect((await workspace.exec('pwd', { cwd: 'pkg' })).stdout.trim()).toBe('/workspace/pkg');
  });

  it('streams output and reports the exit code', async () => {
    const out: string[] = [];
    const result = await workspace.exec("printf 'a'; printf 'b' >&2; exit 7", {
      onStdout: (chunk) => out.push(chunk),
    });
    expect(result).toMatchObject({ stdout: 'a', stderr: 'b', exitCode: 7, timedOut: false });
    expect(out.join('')).toBe('a');
  });

  it('has no network by default', async () => {
    const result = await workspace.exec('wget -q -T 2 -O- http://1.1.1.1 || echo offline');
    expect(result.stdout).toContain('offline');
  });

  it('kills the command and what it started on a timeout, and keeps the container', async () => {
    const result = await workspace.exec('sleep 60 & sleep 60; echo never', { timeout: 1500 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    await vi.waitFor(
      async () => {
        const left = await workspace.exec('ps -o args | grep -c "^sleep 60" || true');
        expect(left.stdout.trim()).toBe('0');
      },
      { timeout: 10_000 }
    );
    expect((await workspace.exec('echo alive')).stdout).toBe('alive\n');
  });

  it('rejects with ABORTED when the signal aborts', async () => {
    const controller = new AbortController();
    const running = workspace.exec('echo ready; sleep 60', {
      signal: controller.signal,
      onStdout: (chunk) => {
        if (chunk.includes('ready')) controller.abort();
      },
    });
    await expect(running).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('labels its container and removes it with the host on dispose', async () => {
    const other = new DockerWorkspace({ host: directoryHost(base), id: 'disposable' });
    await other.start();
    const id = other.containerId;
    expect(id).toBeDefined();
    const Dockerode = (await import('dockerode')).default;
    const docker = new Dockerode(dockerConnectionCandidates()[0]);
    const info = await docker.getContainer(id!).inspect();
    expect(info.Config.Labels[WORKSPACE_CONTAINER_LABEL]).toBe('disposable');

    await other.dispose();
    await expect(docker.getContainer(id!).inspect()).rejects.toThrow();
    await expect(other.exec('true')).rejects.toMatchObject({ code: 'DISPOSED' });
  });

  it('disposes the host it owns', async () => {
    const ownedHost = directoryHost(base);
    const owned = new DockerWorkspace({ host: ownedHost });
    await owned.start();
    await owned.dispose();
    expect(ownedHost.disposed).toBe(true);
  });
});
