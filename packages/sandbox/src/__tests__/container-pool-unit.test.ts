import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContainerPool } from '../pool/container-pool';
import type { Docker, DockerContainer } from '../docker-types';

function createMockDocker(): Docker {
  return {
    ping: vi.fn().mockResolvedValue('OK'),
    createContainer: vi.fn().mockImplementation(async () => createMockContainer()),
    getImage: vi.fn().mockReturnValue({
      inspect: vi.fn().mockResolvedValue({}),
    }),
    pull: vi.fn(),
    modem: {
      followProgress: vi.fn(),
    },
  };
}

let containerId = 0;

function createMockContainer(): DockerContainer {
  return {
    id: `mock-container-${(++containerId).toString()}`,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ContainerPool (unit, mocked Docker)', () => {
  let docker: Docker;
  let pool: ContainerPool;

  beforeEach(() => {
    containerId = 0;
    docker = createMockDocker();
    pool = new ContainerPool(docker, { maxSize: 3, idleTimeoutMs: 60_000 });
  });

  afterEach(async () => {
    await pool.destroyAll();
  });

  it('creates a container on first acquire', async () => {
    const container = await pool.acquire('alpine:3.19', { networkMode: 'none' });
    expect(container).toBeDefined();
    expect(container.id).toBeTruthy();
    expect(container.start).toHaveBeenCalled();
  });

  it('reuses container after release', async () => {
    const container1 = await pool.acquire('alpine:3.19', { networkMode: 'none' });
    const id1 = container1.id;
    await pool.release(container1);

    const container2 = await pool.acquire('alpine:3.19', { networkMode: 'none' });
    expect(container2.id).toBe(id1);
  });

  it('creates new container for different image', async () => {
    const c1 = await pool.acquire('alpine:3.19', { networkMode: 'none' });
    const c2 = await pool.acquire('node:20', { networkMode: 'none' });
    expect(c2.id).not.toBe(c1.id);
    await pool.release(c1);
    await pool.release(c2);
  });

  it('destroys corrupted container on release', async () => {
    const container = await pool.acquire('alpine:3.19', { networkMode: 'none' });
    await pool.release(container, { corrupted: true });

    expect(container.stop).toHaveBeenCalled();
    expect(container.remove).toHaveBeenCalled();
  });

  it('creates new container when all are in use', async () => {
    const c1 = await pool.acquire('alpine:3.19', { networkMode: 'none' });
    const c2 = await pool.acquire('alpine:3.19', { networkMode: 'none' });
    expect(c2.id).not.toBe(c1.id);
    await pool.release(c1);
    await pool.release(c2);
  });

  it('destroys all containers on destroyAll', async () => {
    const c1 = await pool.acquire('alpine:3.19', { networkMode: 'none' });
    const c2 = await pool.acquire('alpine:3.19', { networkMode: 'none' });
    await pool.release(c1);
    await pool.release(c2);

    await pool.destroyAll();
    expect(c1.stop).toHaveBeenCalled();
    expect(c2.stop).toHaveBeenCalled();
  });

  it('pulls image if not found locally', async () => {
    (docker.getImage as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      inspect: vi.fn().mockRejectedValue(new Error('not found')),
    });

    docker.pull = vi
      .fn()
      .mockImplementation(
        (_image: string, callback: (err: Error | null, stream: NodeJS.ReadableStream) => void) => {
          const fakeStream = {} as NodeJS.ReadableStream;
          callback(null, fakeStream);
        }
      );
    docker.modem.followProgress = vi
      .fn()
      .mockImplementation(
        (_stream: NodeJS.ReadableStream, callback: (err: Error | null) => void) => {
          callback(null);
        }
      );

    const container = await pool.acquire('new-image:latest', { networkMode: 'none' });
    expect(container).toBeDefined();
    expect(docker.pull).toHaveBeenCalledWith('new-image:latest', expect.any(Function));
  });

  it('applies security options to container', async () => {
    await pool.acquire('alpine:3.19', {
      memory: 256 * 1024 * 1024,
      cpus: 0.5,
      pidsLimit: 50,
      networkMode: 'none',
      user: 'sandbox',
    });

    expect(docker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        User: 'sandbox',
        HostConfig: expect.objectContaining({
          Memory: 256 * 1024 * 1024,
          NanoCpus: 500_000_000,
          PidsLimit: 50,
          NetworkMode: 'none',
          SecurityOpt: ['no-new-privileges'],
          CapDrop: ['ALL'],
        }),
      })
    );
  });

  it('handles mounts', async () => {
    await pool.acquire('alpine:3.19', {
      networkMode: 'none',
      mounts: [
        { source: '/host/path', target: '/container/path', readOnly: true },
        { source: '/data', target: '/mnt/data' },
      ],
    });

    expect(docker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        HostConfig: expect.objectContaining({
          Binds: ['/host/path:/container/path:ro', '/data:/mnt/data'],
        }),
      })
    );
  });

  it('does not exceed max pool size in tracked containers', async () => {
    const containers: DockerContainer[] = [];
    for (let i = 0; i < 5; i++) {
      containers.push(await pool.acquire('alpine:3.19', { networkMode: 'none' }));
    }

    for (const c of containers) {
      await pool.release(c);
    }

    expect(docker.createContainer).toHaveBeenCalledTimes(5);
  });

  it('destroys non-pooled container on release', async () => {
    for (let i = 0; i < 3; i++) {
      const c = await pool.acquire('alpine:3.19', { networkMode: 'none' });
      await pool.release(c);
    }

    const extraContainer = await pool.acquire('alpine:3.19', { networkMode: 'none' });
    const extraContainer2 = await pool.acquire('alpine:3.19', { networkMode: 'none' });
    const extraContainer3 = await pool.acquire('alpine:3.19', { networkMode: 'none' });
    const overflow = await pool.acquire('alpine:3.19', { networkMode: 'none' });

    await pool.release(extraContainer);
    await pool.release(extraContainer2);
    await pool.release(extraContainer3);
    await pool.release(overflow);

    expect(overflow.stop).toHaveBeenCalled();
    expect(overflow.remove).toHaveBeenCalled();
  });
});
