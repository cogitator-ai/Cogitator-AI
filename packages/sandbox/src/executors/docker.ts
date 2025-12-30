/**
 * Docker sandbox executor - isolated execution in containers
 */

import type {
  SandboxConfig,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxResult,
  SandboxDockerConfig,
  SandboxPoolConfig,
} from '@cogitator/types';
import { BaseSandboxExecutor } from './base';
import { ContainerPool } from '../pool/container-pool.js';
import { parseMemory } from '../utils/parse-resources.js';
import type { Docker, DockerExec } from '../docker-types.js';

export interface DockerExecutorOptions {
  docker?: SandboxDockerConfig;
  pool?: SandboxPoolConfig;
}

const MAX_OUTPUT_SIZE = 50_000;
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_IMAGE = 'alpine:3.19';

export class DockerSandboxExecutor extends BaseSandboxExecutor {
  readonly type = 'docker';
  private docker?: Docker;
  private pool?: ContainerPool;
  private options: DockerExecutorOptions;

  constructor(options: DockerExecutorOptions = {}) {
    super();
    this.options = options;
  }

  async connect(): Promise<SandboxResult<void>> {
    try {
      const Dockerode = (await import('dockerode')).default;

      this.docker = new Dockerode({
        socketPath: this.options.docker?.socketPath ?? '/var/run/docker.sock',
        host: this.options.docker?.host,
        port: this.options.docker?.port,
      }) as unknown as Docker;

      await this.docker.ping();

      this.pool = new ContainerPool(this.docker, {
        maxSize: this.options.pool?.maxSize ?? 5,
        idleTimeoutMs: this.options.pool?.idleTimeoutMs ?? 60_000,
      });

      return this.success(undefined);
    } catch (error) {
      return this.failure(
        `Failed to connect to Docker: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async disconnect(): Promise<SandboxResult<void>> {
    if (this.pool) {
      await this.pool.destroyAll();
    }
    this.docker = undefined;
    this.pool = undefined;
    return this.success(undefined);
  }

  async isAvailable(): Promise<boolean> {
    if (!this.docker) return false;
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }

  async execute(
    request: SandboxExecutionRequest,
    config: SandboxConfig
  ): Promise<SandboxResult<SandboxExecutionResult>> {
    if (!this.docker || !this.pool) {
      return this.failure('Docker executor not connected');
    }

    const startTime = Date.now();
    const timeout = request.timeout ?? config.timeout ?? DEFAULT_TIMEOUT;
    const image = config.image ?? DEFAULT_IMAGE;

    try {
      const container = await this.pool.acquire(image, {
        memory: config.resources?.memory
          ? parseMemory(config.resources.memory)
          : undefined,
        cpus: config.resources?.cpus,
        cpuShares: config.resources?.cpuShares,
        pidsLimit: config.resources?.pidsLimit,
        networkMode: config.network?.mode ?? 'none',
        mounts: config.mounts,
        user: config.user,
      });

      try {
        const exec = await container.exec({
          Cmd: request.command,
          Env: Object.entries({ ...config.env, ...request.env }).map(
            ([k, v]) => `${k}=${v}`
          ),
          WorkingDir: request.cwd ?? config.workdir ?? '/workspace',
          AttachStdout: true,
          AttachStderr: true,
          AttachStdin: !!request.stdin,
        });

        const result = await this.runWithTimeout(exec, request.stdin, timeout);

        return this.success({
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          duration: Date.now() - startTime,
        });
      } finally {
        await this.pool.release(container);
      }
    } catch (error) {
      return this.failure(
        `Execution failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async runWithTimeout(
    exec: DockerExec,
    stdin: string | undefined,
    timeoutMs: number
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
  }> {
    return new Promise((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
      }, timeoutMs);

      void (async () => {
        try {
          const stream = await exec.start({
            hijack: true,
            stdin: !!stdin,
          });

          let stdout = '';
          let stderr = '';

          stream.on('data', (chunk: Buffer) => {
            let offset = 0;
            while (offset < chunk.length) {
              if (offset + 8 > chunk.length) break;

              const type = chunk[offset];
              const size =
                (chunk[offset + 4] << 24) |
                (chunk[offset + 5] << 16) |
                (chunk[offset + 6] << 8) |
                chunk[offset + 7];

              if (offset + 8 + size > chunk.length) break;

              const data = chunk.slice(offset + 8, offset + 8 + size).toString('utf-8');

              if (type === 1) {
                stdout += data;
              } else if (type === 2) {
                stderr += data;
              }

              offset += 8 + size;
            }
          });

          if (stdin) {
            stream.write(stdin);
            stream.end();
          }

          await new Promise<void>((res) => stream.on('end', res));
          clearTimeout(timer);

          const inspection = await exec.inspect();

          resolve({
            stdout: stdout.slice(0, MAX_OUTPUT_SIZE),
            stderr: stderr.slice(0, MAX_OUTPUT_SIZE),
            exitCode: inspection.ExitCode ?? 1,
            timedOut,
          });
        } catch (error) {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
  }
}
