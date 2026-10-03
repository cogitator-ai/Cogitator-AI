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
} from '@cogitator-ai/types';
import { BaseSandboxExecutor } from './base';
import { ContainerPool } from '../pool/container-pool';
import { parseMemory } from '../utils/parse-resources';
import { OutputCollector } from '../utils/output-collector';
import { dockerConnectionCandidates } from '../utils/docker-connection';
import type { Docker, DockerExec, DockerStream } from '../docker-types';

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
      let lastError: unknown;
      for (const options of dockerConnectionCandidates(this.options.docker)) {
        const docker = new Dockerode(options) as unknown as Docker;
        try {
          await docker.ping();
          this.docker = docker;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!this.docker) throw lastError;

      this.pool = new ContainerPool(this.docker, {
        maxSize: this.options.pool?.maxSize ?? 5,
        idleTimeoutMs: this.options.pool?.idleTimeoutMs ?? 60_000,
        reuseContainers: this.options.pool?.reuseContainers ?? false,
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

    if (!request.command || request.command.length === 0) {
      return this.failure('Command array is empty');
    }

    if (config.network?.allowedHosts?.length) {
      return this.failure(
        'network.allowedHosts is not supported by the Docker executor; use network.mode instead'
      );
    }

    const startTime = Date.now();
    const timeout = request.timeout ?? config.timeout ?? DEFAULT_TIMEOUT;
    const image = config.image ?? DEFAULT_IMAGE;

    let memory: number | undefined;
    try {
      memory = config.resources?.memory ? parseMemory(config.resources.memory) : undefined;
    } catch (error) {
      return this.failure(error instanceof Error ? error.message : String(error));
    }
    if (memory !== undefined && memory <= 0) {
      return this.failure(`Memory limit must be positive: ${config.resources?.memory}`);
    }
    const cpus = config.resources?.cpus;
    if (cpus !== undefined && (!Number.isFinite(cpus) || cpus <= 0)) {
      return this.failure(`CPU limit must be a positive number: ${cpus}`);
    }

    let containerCorrupted = true;

    try {
      const container = await this.pool.acquire(image, {
        memory,
        cpus,
        cpuShares: config.resources?.cpuShares,
        pidsLimit: config.resources?.pidsLimit,
        networkMode: config.network?.mode ?? 'none',
        dns: config.network?.dns,
        mounts: config.mounts,
        user: config.user,
      });

      try {
        const exec = await container.exec({
          Cmd: request.command,
          Env: Object.entries({ ...config.env, ...request.env }).map(([k, v]) => `${k}=${v}`),
          WorkingDir: request.cwd ?? config.workdir ?? '/workspace',
          AttachStdout: true,
          AttachStderr: true,
          AttachStdin: !!request.stdin,
        });

        const result = await this.runWithTimeout(exec, request.stdin, timeout);
        containerCorrupted = result.containerCorrupted;

        return this.success({
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          duration: Date.now() - startTime,
        });
      } finally {
        await this.pool.release(container, { corrupted: containerCorrupted });
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
    containerCorrupted: boolean;
  }> {
    const stdout = new OutputCollector(MAX_OUTPUT_SIZE);
    const stderr = new OutputCollector(MAX_OUTPUT_SIZE);
    const demuxer = new DockerStreamDemuxer(
      (data) => stdout.push(data),
      (data) => stderr.push(data)
    );
    let stream: DockerStream | null = null;

    const executionPromise = (async () => {
      stream = await exec.start({
        hijack: true,
        stdin: !!stdin,
      });
      const active = stream;

      const finished = new Promise<void>((resolve, reject) => {
        active.on('end', () => resolve());
        active.on('close', () => resolve());
        active.on('error', (error: unknown) =>
          reject(error instanceof Error ? error : new Error(String(error)))
        );
      });

      active.on('data', (chunk: Buffer) => demuxer.push(chunk));

      if (stdin) {
        active.write(stdin);
        active.end();
      }

      await finished;
      const inspection = await exec.inspect();
      return inspection.ExitCode ?? 1;
    })();

    let timer: ReturnType<typeof setTimeout> | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (stream) stream.end();
        reject(new Error('TIMEOUT'));
      }, timeoutMs);
    });

    try {
      const exitCode = await Promise.race([executionPromise, timeoutPromise]);
      return {
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode,
        timedOut: false,
        containerCorrupted: false,
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'TIMEOUT') {
        executionPromise.catch(() => undefined);
        return {
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          exitCode: 124,
          timedOut: true,
          containerCorrupted: true,
        };
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Decodes Docker's multiplexed attach stream, buffering frames split across chunks.
 */
export class DockerStreamDemuxer {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(
    private readonly onStdout: (data: Buffer) => void,
    private readonly onStderr: (data: Buffer) => void
  ) {}

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 8) {
      const type = this.buffer[0];
      const size = this.buffer.readUInt32BE(4);
      if (this.buffer.length < 8 + size) break;

      const payload = this.buffer.subarray(8, 8 + size);
      if (type === 1) this.onStdout(payload);
      else if (type === 2) this.onStderr(payload);

      this.buffer = this.buffer.subarray(8 + size);
    }
  }
}
