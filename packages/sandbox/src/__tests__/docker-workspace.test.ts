import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  WorkspaceError,
  type Workspace,
  type WorkspaceStat,
  type WorkspaceTrashEntry,
} from '@cogitator-ai/types';
import {
  DockerWorkspace,
  ownerLabel,
  WORKSPACE_CONTAINER_LABEL,
  WORKSPACE_OWNER_LABEL,
  WORKSPACE_ROOT_LABEL,
} from '../workspace/docker-workspace';
import { MarkerScanner } from '../workspace/exec-stream';
import { createSandboxContainer } from '../pool/container-pool';
import { dockerConnectionCandidates } from '../utils/docker-connection';
import type { Docker } from '../docker-types';
import type Dockerode from 'dockerode';

async function connectDocker(): Promise<Dockerode | null> {
  try {
    const Client = (await import('dockerode')).default;
    for (const options of dockerConnectionCandidates()) {
      const client = new Client(options);
      try {
        await client.ping();
        return client;
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

const docker = await connectDocker();

/**
 * A host workspace for these tests: a plain directory, only what DockerWorkspace asks of it.
 * The path guard itself is LocalWorkspace's, covered in core and in the e2e suite.
 */
function directoryHost(root: string): Workspace & { disposed: boolean } {
  const unsupported = () => {
    const error: Error = new WorkspaceError('UNSUPPORTED', 'not in this test');
    return Promise.reject(error);
  };
  const host: Workspace & { disposed: boolean } = {
    id: 'host',
    root,
    cwd: '.',
    disposed: false,
    start: async () => undefined,
    async dispose() {
      host.disposed = true;
    },
    withCwd: () => host,
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
    async write(path, content) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    },
    list: unsupported,
    exists: (path) => Promise.resolve(existsSync(join(root, path))),
    mkdir: unsupported,
    remove: unsupported,
    rename: unsupported,
    exec: unsupported,
  };
  return host;
}

describe('DockerWorkspace without Docker', () => {
  it('says Docker is unavailable when it cannot be reached', async () => {
    const workspace = new DockerWorkspace({
      host: directoryHost(tmpdir()),
      docker: { socketPath: join(tmpdir(), 'no-such-docker.sock') },
    });
    const error = await workspace.exec('true').then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect(WorkspaceError.is(error, 'UNAVAILABLE')).toBe(true);
    expect((error as Error).message).toContain('Docker is not reachable');
  });

  it('refuses network allow-lists, an absolute cwd and one outside the root', () => {
    const host = directoryHost(tmpdir());
    expect(
      () =>
        new DockerWorkspace({ host, network: { mode: 'bridge', allowedHosts: ['example.com'] } })
    ).toThrow(/allowedHosts/);
    expect(() => new DockerWorkspace({ host, cwd: '/etc' })).toThrow(/relative/);
    expect(() => new DockerWorkspace({ host, cwd: '../up' })).toThrow(/outside/);
    expect(new DockerWorkspace({ host, cwd: 'a/./b/' }).cwd).toBe('a/b');
  });

  it('refuses commands whose signal already aborted, without touching Docker', async () => {
    const workspace = new DockerWorkspace({
      host: directoryHost(tmpdir()),
      docker: { socketPath: join(tmpdir(), 'no-such-docker.sock') },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(workspace.exec('true', { signal: controller.signal })).rejects.toMatchObject({
      code: 'ABORTED',
    });
  });
});

describe.skipIf(!docker)('DockerWorkspace with Docker', () => {
  let base: string;
  let host: ReturnType<typeof directoryHost>;
  let workspace: DockerWorkspace;

  beforeAll(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'docker-workspace-')));
    mkdirSync(join(base, 'pkg'));
    host = directoryHost(base);
    workspace = new DockerWorkspace({ host, image: 'alpine:3.19', id: 'test-ws', killGrace: 500 });
  }, 120_000);

  afterAll(async () => {
    await workspace?.dispose();
    rmSync(base, { recursive: true, force: true });
  }, 60_000);

  it('starts on first use and runs commands in one long-lived container', async () => {
    expect(workspace.containerId).toBeUndefined();
    const first = await workspace.exec('echo hello > from-container.txt && hostname');
    const second = await workspace.exec('hostname');
    expect(workspace.containerId).toBeDefined();
    expect(first.exitCode).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(readFileSync(join(base, 'from-container.txt'), 'utf8')).toBe('hello\n');
    expect(await workspace.read('from-container.txt')).toBe('hello\n');
    expect(await workspace.read('/workspace/from-container.txt')).toBe('hello\n');
  }, 120_000);

  it('maps the working directory into the container, also for a withCwd view', async () => {
    expect((await workspace.exec('pwd')).stdout.trim()).toBe('/workspace');
    expect((await workspace.exec('pwd', { cwd: 'pkg' })).stdout.trim()).toBe('/workspace/pkg');
    expect((await workspace.exec('pwd', { cwd: '/workspace/pkg' })).stdout.trim()).toBe(
      '/workspace/pkg'
    );
    const view = workspace.withCwd('pkg');
    expect(view.id).toBe(workspace.id);
    expect((await view.exec('pwd')).stdout.trim()).toBe('/workspace/pkg');
    expect(view.containerId).toBe(workspace.containerId);
  }, 60_000);

  it('streams output and reports the exit code, stderr without the wrapper header', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const result = await workspace.exec("printf 'a'; printf 'b' >&2; exit 7", {
      onStdout: (chunk) => out.push(chunk),
      onStderr: (chunk) => err.push(chunk),
    });
    expect(result).toMatchObject({ stdout: 'a', stderr: 'b', exitCode: 7, timedOut: false });
    expect(out.join('')).toBe('a');
    expect(err.join('')).toBe('b');
  }, 60_000);

  it('has no network by default', async () => {
    const result = await workspace.exec('wget -q -T 2 -O- http://1.1.1.1 || echo offline');
    expect(result.stdout).toContain('offline');
  }, 60_000);

  it('kills the command group on a timeout, background and env -i processes too', async () => {
    const result = await workspace.exec(
      'sleep 61 & env -i sh -c "exec sleep 62" & sleep 63; echo never',
      { timeout: 1000 }
    );
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(result.stdout).not.toContain('never');
    await vi.waitFor(
      async () => {
        const left = await workspace.exec('ps -o args | grep -c "^sleep 6[123]" || true');
        expect(left.stdout.trim()).toBe('0');
      },
      { timeout: 15_000, interval: 200 }
    );
    expect((await workspace.exec('echo alive')).stdout).toBe('alive\n');
  }, 60_000);

  it('rejects with ABORTED when the signal aborts, and kills the command', async () => {
    const controller = new AbortController();
    const running = workspace.exec('echo ready; sleep 64', {
      signal: controller.signal,
      onStdout: (chunk) => {
        if (chunk.includes('ready')) controller.abort();
      },
    });
    await expect(running).rejects.toMatchObject({ code: 'ABORTED' });
    await vi.waitFor(
      async () => {
        const left = await workspace.exec('ps -o args | grep -c "^sleep 64" || true');
        expect(left.stdout.trim()).toBe('0');
      },
      { timeout: 15_000, interval: 200 }
    );
  }, 60_000);

  it('rejects with ABORTED when the signal aborts while the command is being started', async () => {
    const controller = new AbortController();
    const running = workspace.exec('sleep 65', { signal: controller.signal });
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: 'ABORTED' });
    await vi.waitFor(
      async () => {
        const left = await workspace.exec('ps -o args | grep -c "^sleep 65" || true');
        expect(left.stdout.trim()).toBe('0');
      },
      { timeout: 15_000, interval: 200 }
    );
  }, 60_000);

  it('labels its container and removes it with the host on dispose', async () => {
    const ownedHost = directoryHost(base);
    const other = new DockerWorkspace({ host: ownedHost, id: 'disposable' });
    await other.start();
    const id = other.containerId!;
    const info = await docker!.getContainer(id).inspect();
    expect(info.Config.Labels[WORKSPACE_CONTAINER_LABEL]).toBe('disposable');
    expect(info.Config.Labels[WORKSPACE_ROOT_LABEL]).toBe(base);
    expect(info.HostConfig.Init).toBe(true);
    expect(info.HostConfig.Memory).toBeGreaterThan(0);

    await other.dispose();
    expect(ownedHost.disposed).toBe(true);
    await expect(docker!.getContainer(id).inspect()).rejects.toThrow();
    await expect(other.exec('true')).rejects.toMatchObject({ code: 'DISPOSED' });
  }, 120_000);

  it("removes a container of the same root a gone process of this machine left, not a neighbor's", async () => {
    const orphanRoot = realpathSync(mkdtempSync(join(tmpdir(), 'docker-orphan-')));
    const dead = await ownerLabel(999_999);
    const neighbor = dead
      .split('|')
      .map((part, i) => (i === 2 ? 'pid:[1]' : part))
      .join('|');
    const make = (owner: string) =>
      createSandboxContainer(
        docker as unknown as Docker,
        'alpine:3.19',
        {},
        {
          labels: {
            [WORKSPACE_CONTAINER_LABEL]: 'orphan',
            [WORKSPACE_ROOT_LABEL]: orphanRoot,
            [WORKSPACE_OWNER_LABEL]: owner,
          },
        }
      );
    const orphan = await make(dead);
    const other = await make(neighbor);
    const fresh = new DockerWorkspace({ host: directoryHost(orphanRoot) });
    try {
      await fresh.start();
      await expect(docker!.getContainer(orphan.id).inspect()).rejects.toThrow();
      await expect(docker!.getContainer(other.id).inspect()).resolves.toBeDefined();
    } finally {
      await fresh.dispose();
      for (const container of [orphan, other]) {
        await docker!
          .getContainer(container.id)
          .remove({ force: true })
          .catch(() => undefined);
      }
      rmSync(orphanRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it('returns when the command exits, stopping or keeping its background processes', async () => {
    const quick = await workspace.exec('sleep 71 & echo started', { timeout: 60_000 });
    expect(quick).toMatchObject({ stdout: 'started\n', exitCode: 0, timedOut: false });
    await vi.waitFor(
      async () => {
        const left = await workspace.exec('ps -o args | grep -c "^sleep 71" || true');
        expect(left.stdout.trim()).toBe('0');
      },
      { timeout: 15_000, interval: 200 }
    );
    const kept = await workspace.exec('sleep 72 > /dev/null 2>&1 & echo started', {
      background: 'keep',
    });
    expect(kept.exitCode).toBe(0);
    const alive = await workspace.exec('ps -o args | grep -c "^sleep 72" || true');
    expect(alive.stdout.trim()).toBe('1');
    await workspace.exec('pkill -f "sleep 72" || true');
  }, 60_000);

  it('removes and moves inside the container', async () => {
    mkdirSync(join(base, 'tree', 'sub'), { recursive: true });
    await workspace.exec('echo a > tree/sub/a.txt && echo b > b.txt');
    await expect(workspace.remove('tree')).rejects.toMatchObject({ code: 'NOT_EMPTY' });
    await expect(workspace.rename('b.txt', 'tree')).rejects.toMatchObject({ code: 'EXISTS' });
    await workspace.rename('b.txt', '/workspace/tree/sub/b.txt');
    expect(readFileSync(join(base, 'tree', 'sub', 'b.txt'), 'utf8')).toBe('b\n');
    const trashed = await workspace.remove('tree', { trash: true });
    expect(trashed.trashedTo).toMatch(/^\.cogitator\/trash\/.+\/tree$/);
    expect(readFileSync(join(base, trashed.trashedTo!, 'sub', 'a.txt'), 'utf8')).toBe('a\n');
    await workspace.remove(trashed.trashedTo!, { recursive: true });
    await expect(workspace.remove('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(workspace.remove('.cogitator/pending', { recursive: true })).rejects.toMatchObject(
      { code: 'INVALID_PATH' }
    );
    await expect(workspace.remove('../up')).rejects.toMatchObject({ code: 'OUTSIDE_ROOT' });
  }, 60_000);

  it('removes what a restore deletes inside the container, and refuses while commands run', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'docker-restore-')));
    mkdirSync(join(root, 'gone'));
    writeFileSync(join(root, 'gone', 'inner.txt'), 'inner');
    writeFileSync(join(root, 'loose.txt'), 'loose');
    const seen: { dryRun: boolean; goneThere: boolean }[] = [];
    let hostBusy = false;
    let hostWrites: (() => Promise<void>) | undefined;
    const planned = {
      snapshotId: 'snap_x_12345678',
      restored: ['kept.txt'],
      deleted: ['gone', 'gone/inner.txt', 'loose.txt'],
      unchanged: 0,
      kept: [],
    };
    const restoring: Workspace & { disposed: boolean } = {
      ...directoryHost(root),
      snapshot: async () => ({
        id: 'snap_x_12345678',
        workspaceId: 'host',
        createdAt: new Date().toISOString(),
        exclude: [],
      }),
      restore: async (_id, restoreOptions) => {
        const dryRun = restoreOptions?.dryRun ?? false;
        seen.push({ dryRun, goneThere: existsSync(join(root, 'gone')) });
        if (dryRun) return { ...planned, dryRun, busy: hostBusy };
        await hostWrites?.();
        return { ...planned, dryRun, deleted: [] };
      },
    };
    const docked = new DockerWorkspace({ host: restoring, image: 'alpine:3.19', killGrace: 500 });
    try {
      const running = docked.exec('sleep 1');
      await new Promise((resolve) => setTimeout(resolve, 300));
      await expect(docked.restore!('snap_x_12345678')).rejects.toMatchObject({ code: 'BUSY' });
      await expect(docked.restore!('snap_x_12345678', { dryRun: true })).resolves.toMatchObject({
        busy: true,
      });
      await running;
      await docked.exec('sleep 5 &', { background: 'keep' });
      await expect(docked.restore!('snap_x_12345678')).rejects.toMatchObject({ code: 'BUSY' });
      await docked.exec("pkill -f 'sleep 5'; true");
      await new Promise((resolve) => setTimeout(resolve, 200));
      hostBusy = true;
      await expect(docked.restore!('snap_x_12345678')).rejects.toMatchObject({ code: 'BUSY' });
      expect(existsSync(join(root, 'loose.txt'))).toBe(true);
      hostBusy = false;
      seen.length = 0;
      const dry = await docked.restore!('snap_x_12345678', { dryRun: true });
      seen.length = 0;
      let raced: unknown;
      hostWrites = async () => {
        raced = await docked.exec('true').catch((error: unknown) => error);
      };
      const result = await docked.restore!('snap_x_12345678');
      expect(raced).toMatchObject({ code: 'BUSY' });
      expect(result.deleted).toEqual(planned.deleted);
      expect({ ...result, dryRun: true, busy: false }).toEqual(dry);
      expect(seen).toEqual([
        { dryRun: true, goneThere: true },
        { dryRun: false, goneThere: false },
      ]);
      expect(existsSync(join(root, 'loose.txt'))).toBe(false);
    } finally {
      await docked.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it('holds the host for the whole restore and counts groups still stopping as busy', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'docker-hold-')));
    writeFileSync(join(root, 'loose.txt'), 'loose');
    const log: string[] = [];
    let held = 0;
    const planned = {
      snapshotId: 'snap_y_12345678',
      restored: [],
      deleted: ['loose.txt'],
      unchanged: 0,
      kept: [],
    };
    const host: Workspace = {
      ...directoryHost(root),
      snapshot: async () => ({
        id: 'snap_y_12345678',
        workspaceId: 'host',
        createdAt: new Date().toISOString(),
        exclude: [],
      }),
      holdForRestore: () => {
        held++;
        log.push(`hold, loose ${existsSync(join(root, 'loose.txt')) ? 'there' : 'gone'}`);
        return () => {
          held--;
          log.push('release');
        };
      },
      restore: async (_id, restoreOptions) => {
        const dryRun = restoreOptions?.dryRun ?? false;
        if (!dryRun) log.push(`restore, held ${held}`);
        return { ...planned, dryRun, busy: false };
      },
    };
    const docked = new DockerWorkspace({ host, image: 'alpine:3.19', killGrace: 4_000 });
    try {
      const stubborn = await docked.exec(
        '(trap "" TERM; sleep 30) > /dev/null 2>&1 & echo started'
      );
      expect(stubborn.stdout).toBe('started\n');
      await expect(docked.restore!('snap_y_12345678')).rejects.toMatchObject({ code: 'BUSY' });
      await vi.waitFor(
        async () => {
          const dry = await docked.restore!('snap_y_12345678', { dryRun: true });
          expect(dry.busy).toBe(false);
        },
        { timeout: 20_000, interval: 250 }
      );
      log.length = 0;
      await docked.restore!('snap_y_12345678');
      expect(log).toEqual(['hold, loose there', 'restore, held 1', 'release']);
      expect(existsSync(join(root, 'loose.txt'))).toBe(false);
    } finally {
      await docked.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe.skipIf(!docker)('DockerWorkspace trash over a host that lists it', () => {
  let base: string;
  let workspace: DockerWorkspace;

  /** The host's trash read from the records the workspace writes next to each trash folder */
  const listing = (root: string) => async (): Promise<WorkspaceTrashEntry[]> => {
    const dir = join(root, '.cogitator', 'trash');
    if (!existsSync(dir)) return [];
    const entries: WorkspaceTrashEntry[] = [];
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.json'))) {
      const id = name.slice(0, -'.json'.length);
      const record = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        path: string;
        trashedAt: number;
        type: WorkspaceTrashEntry['type'];
      };
      if (!existsSync(join(dir, id, record.path))) continue;
      entries.push({
        id,
        path: record.path,
        trashedTo: `.cogitator/trash/${id}/${record.path}`,
        trashedAt: record.trashedAt,
        type: record.type,
        size: 0,
      });
    }
    return entries;
  };

  beforeAll(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'docker-trash-')));
    const host = { ...directoryHost(base), listTrash: listing(base) };
    workspace = new DockerWorkspace({ host, image: 'alpine:3.19', id: 'trash-ws', killGrace: 500 });
  }, 120_000);

  afterAll(async () => {
    await workspace?.dispose();
    rmSync(base, { recursive: true, force: true });
  }, 60_000);

  it('records a trashed entry, restores it in the container and empties the trash', async () => {
    await workspace.exec('mkdir -p dir && echo keep > dir/f.txt && echo gone > g.txt');
    const trashed = await workspace.remove('dir', { trash: true });
    const [entry] = await workspace.listTrash!();
    expect(entry).toMatchObject({ path: 'dir', type: 'directory', trashedTo: trashed.trashedTo });
    expect(await workspace.restoreFromTrash!(entry.id)).toEqual({ path: 'dir' });
    expect(readFileSync(join(base, 'dir', 'f.txt'), 'utf8')).toBe('keep\n');
    expect(await workspace.listTrash!()).toEqual([]);
    expect(existsSync(join(base, '.cogitator', 'trash', `${entry.id}.json`))).toBe(false);

    await workspace.remove('g.txt', { trash: true });
    const [second] = await workspace.listTrash!();
    expect(await workspace.emptyTrash!({ olderThan: 60_000 })).toEqual({ deleted: [] });
    expect(await workspace.emptyTrash!()).toEqual({ deleted: [second.id] });
    expect(existsSync(join(base, '.cogitator', 'trash', second.id))).toBe(false);
    await expect(workspace.restoreFromTrash!('missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  }, 120_000);
});

describe('MarkerScanner', () => {
  it('finds the markers anywhere in stderr, split across chunks, and strips only them', () => {
    const text: string[] = [];
    const markers: [string, number][] = [];
    const scanner = new MarkerScanner(
      'tok',
      (chunk) => text.push(chunk),
      (kind, value) => markers.push([kind, value])
    );
    const stream =
      'bash: warning: setlocale: LC_ALL\n__cogitator_tok_pgid:42\nreal error__cogitator_tok_exit:3\n';
    for (let i = 0; i < stream.length; i += 5) scanner.push(Buffer.from(stream.slice(i, i + 5)));
    scanner.end();
    expect(markers).toEqual([
      ['pgid', 42],
      ['exit', 3],
    ]);
    expect(text.join('')).toBe('bash: warning: setlocale: LC_ALL\nreal error');
  });

  it('passes on text that only looks like the start of a marker', () => {
    const text: string[] = [];
    const scanner = new MarkerScanner(
      'tok',
      (chunk) => text.push(chunk),
      () => undefined
    );
    scanner.push(Buffer.from('__cogitator_other_pgid:1\n__cog'));
    scanner.end();
    expect(text.join('')).toBe('__cogitator_other_pgid:1\n__cog');
  });
});
