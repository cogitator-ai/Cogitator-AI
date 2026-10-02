import { describe, it, expect, vi, afterEach } from 'vitest';
import { ContainerPool, SANDBOX_CONTAINER_LABEL } from '../pool/container-pool';
import { DockerSandboxExecutor, DockerStreamDemuxer } from '../executors/docker';
import type { Docker, DockerContainer } from '../docker-types';

function frame(type: number, data: string): Buffer {
  const payload = Buffer.from(data, 'utf-8');
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe('DockerStreamDemuxer', () => {
  it('reassembles frames split across chunks', () => {
    const out: string[] = [];
    const err: string[] = [];
    const demuxer = new DockerStreamDemuxer(
      (d) => out.push(d.toString()),
      (d) => err.push(d.toString())
    );

    const stream = Buffer.concat([frame(1, 'hello '), frame(2, 'oops'), frame(1, 'world')]);
    demuxer.push(stream.subarray(0, 3));
    demuxer.push(stream.subarray(3, 11));
    demuxer.push(stream.subarray(11, 21));
    demuxer.push(stream.subarray(21));

    expect(out.join('')).toBe('hello world');
    expect(err.join('')).toBe('oops');
  });
});

let containerId = 0;

function createMockDocker(): Docker & { createContainer: ReturnType<typeof vi.fn> } {
  return {
    ping: vi.fn().mockResolvedValue('OK'),
    createContainer: vi.fn().mockImplementation(
      async (): Promise<DockerContainer> => ({
        id: `container-${++containerId}`,
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        exec: vi.fn(),
      })
    ),
    getImage: vi.fn().mockReturnValue({ inspect: vi.fn().mockResolvedValue({}) }),
    pull: vi.fn(),
    modem: { followProgress: vi.fn() },
  };
}

describe('ContainerPool isolation', () => {
  let pool: ContainerPool | undefined;

  afterEach(async () => {
    await pool?.destroyAll();
  });

  it('never reuses a container created with different security settings', async () => {
    const docker = createMockDocker();
    pool = new ContainerPool(docker, { maxSize: 5, idleTimeoutMs: 60_000 });

    const networked = await pool.acquire('alpine:3.19', {
      networkMode: 'bridge',
      mounts: [{ source: '/host/data', target: '/data' }],
    });
    await pool.release(networked);

    const isolated = await pool.acquire('alpine:3.19', { networkMode: 'none' });

    expect(isolated.id).not.toBe(networked.id);
    expect(docker.createContainer).toHaveBeenCalledTimes(2);
  });

  it('removes containers that fail to start', async () => {
    const docker = createMockDocker();
    const broken: DockerContainer = {
      id: 'broken',
      start: vi.fn().mockRejectedValue(new Error('cannot start')),
      stop: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      exec: vi.fn(),
    };
    docker.createContainer.mockResolvedValueOnce(broken);
    pool = new ContainerPool(docker, { maxSize: 5, idleTimeoutMs: 60_000 });

    await expect(pool.acquire('alpine:3.19', {})).rejects.toThrow('cannot start');
    expect(broken.remove).toHaveBeenCalledWith({ force: true });
  });

  it('passes DNS servers and the sandbox label to new containers', async () => {
    const docker = createMockDocker();
    pool = new ContainerPool(docker, { maxSize: 5, idleTimeoutMs: 60_000 });

    await pool.acquire('alpine:3.19', { networkMode: 'bridge', dns: ['1.1.1.1'] });

    const options = docker.createContainer.mock.calls[0][0] as {
      HostConfig: { Dns?: string[] };
      Labels: Record<string, string>;
    };
    expect(options.HostConfig.Dns).toEqual(['1.1.1.1']);
    expect(options.Labels).toEqual({ [SANDBOX_CONTAINER_LABEL]: 'true' });
  });
});

describe('DockerSandboxExecutor network allow-lists', () => {
  it('refuses allowedHosts instead of silently allowing all egress', async () => {
    const executor = new DockerSandboxExecutor();
    Object.assign(executor as object, {
      docker: createMockDocker(),
      pool: new ContainerPool(createMockDocker(), { idleTimeoutMs: 60_000 }),
    });

    const result = await executor.execute(
      { command: ['wget', 'https://example.com'] },
      { type: 'docker', network: { mode: 'bridge', allowedHosts: ['example.com'] } }
    );

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('allowedHosts');
    await executor.disconnect();
  });
});

describe('DockerSandboxExecutor resource validation', () => {
  it('rejects zero or invalid limits instead of running without limits', async () => {
    const executor = new DockerSandboxExecutor();
    Object.assign(executor as object, {
      docker: createMockDocker(),
      pool: new ContainerPool(createMockDocker(), { idleTimeoutMs: 60_000 }),
    });

    const zeroMemory = await executor.execute(
      { command: ['true'] },
      { type: 'docker', resources: { memory: '0MB' } }
    );
    const negativeCpus = await executor.execute(
      { command: ['true'] },
      { type: 'docker', resources: { cpus: -1 } }
    );
    const badMemory = await executor.execute(
      { command: ['true'] },
      { type: 'docker', resources: { memory: 'lots' } }
    );

    expect(zeroMemory.success).toBe(false);
    expect(negativeCpus.success).toBe(false);
    expect(badMemory.success).toBe(false);
    await executor.disconnect();
  });
});
