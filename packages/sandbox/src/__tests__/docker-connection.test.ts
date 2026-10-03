import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { dockerConnectionCandidates, type DockerConnectionEnv } from '../utils/docker-connection';

const HOME = '/Users/dev';
const contextMeta = (name: string) =>
  `${HOME}/.docker/contexts/meta/${createHash('sha256').update(name).digest('hex')}/meta.json`;

function system(
  files: Record<string, string>,
  env: Record<string, string | undefined> = {}
): DockerConnectionEnv {
  return {
    env,
    home: HOME,
    exists: (path) => path in files,
    readFile: (path) => files[path],
  };
}

describe('dockerConnectionCandidates', () => {
  it('uses the endpoint of the Docker CLI current context, as `docker info` does', () => {
    const candidates = dockerConnectionCandidates(
      {},
      system({
        [`${HOME}/.docker/config.json`]: JSON.stringify({ currentContext: 'orbstack' }),
        [contextMeta('orbstack')]: JSON.stringify({
          Endpoints: { docker: { Host: `unix://${HOME}/.orbstack/run/docker.sock` } },
        }),
      })
    );

    expect(candidates[0]).toEqual({ socketPath: `${HOME}/.orbstack/run/docker.sock` });
  });

  it('skips a dangling /var/run/docker.sock and finds Docker Desktop and OrbStack sockets', () => {
    const candidates = dockerConnectionCandidates(
      {},
      system({
        [`${HOME}/.docker/run/docker.sock`]: '',
        [`${HOME}/.orbstack/run/docker.sock`]: '',
      })
    );

    expect(candidates).toEqual([
      { socketPath: `${HOME}/.docker/run/docker.sock` },
      { socketPath: `${HOME}/.orbstack/run/docker.sock` },
    ]);
  });

  it('honours DOCKER_CONTEXT and tcp endpoints', () => {
    const candidates = dockerConnectionCandidates(
      {},
      system(
        {
          [contextMeta('remote')]: JSON.stringify({
            Endpoints: { docker: { Host: 'tcp://10.0.0.5:2375' } },
          }),
        },
        { DOCKER_CONTEXT: 'remote' }
      )
    );

    expect(candidates[0]).toEqual({ host: '10.0.0.5', port: 2375 });
  });

  it('leaves DOCKER_HOST to Dockerode and prefers explicit config over everything', () => {
    const files = { '/var/run/docker.sock': '' };

    expect(dockerConnectionCandidates({}, system(files, { DOCKER_HOST: 'tcp://x:1' }))).toEqual([
      undefined,
    ]);
    expect(dockerConnectionCandidates({ socketPath: '/custom.sock' }, system(files))).toEqual([
      { socketPath: '/custom.sock' },
    ]);
  });

  it('falls back to the Dockerode default when nothing is found', () => {
    expect(dockerConnectionCandidates({}, system({}))).toEqual([undefined]);
  });
});

describe('DockerSandboxExecutor connection', () => {
  it('connects through the next candidate when the first does not answer', async () => {
    vi.resetModules();
    const pings = [new Error('ENOENT'), 'OK'];
    const constructed: unknown[] = [];
    vi.doMock('../utils/docker-connection', () => ({
      dockerConnectionCandidates: () => [
        { socketPath: '/dead.sock' },
        { socketPath: '/live.sock' },
      ],
    }));
    vi.doMock('dockerode', () => ({
      default: function MockDockerode(options: unknown) {
        constructed.push(options);
        const outcome = pings.shift();
        return {
          ping: () =>
            outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome),
        };
      },
    }));
    const { DockerSandboxExecutor } = await import('../executors/docker');
    const executor = new DockerSandboxExecutor();

    const result = await executor.connect();

    expect(result.success).toBe(true);
    expect(constructed).toEqual([{ socketPath: '/dead.sock' }, { socketPath: '/live.sock' }]);
    await executor.disconnect();
    vi.doUnmock('dockerode');
    vi.doUnmock('../utils/docker-connection');
  });
});
