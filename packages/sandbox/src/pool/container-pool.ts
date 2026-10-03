/**
 * Container pool for reusing Docker containers
 */

import type { SandboxMount } from '@cogitator-ai/types';
import type { Docker, DockerContainer } from '../docker-types';
import { cpusToNanoCpus } from '../utils/parse-resources';

interface PooledContainer {
  container: DockerContainer;
  key: string;
  image: string;
  options: ContainerCreateOptions;
  lastUsed: number;
}

export interface ContainerCreateOptions {
  memory?: number;
  cpus?: number;
  cpuShares?: number;
  pidsLimit?: number;
  networkMode?: string;
  dns?: string[];
  mounts?: SandboxMount[];
  user?: string;
}

export interface ContainerPoolOptions {
  maxSize?: number;
  idleTimeoutMs?: number;
  /** Hand a released container to the next execution with the same settings (see `SandboxPoolConfig.reuseContainers`) */
  reuseContainers?: boolean;
}

export const SANDBOX_CONTAINER_LABEL = 'ai.cogitator.sandbox';

function poolKey(image: string, options: ContainerCreateOptions): string {
  return JSON.stringify([
    image,
    options.memory ?? null,
    options.cpus ?? null,
    options.cpuShares ?? null,
    options.pidsLimit ?? null,
    options.networkMode ?? 'none',
    options.dns ?? [],
    (options.mounts ?? []).map((m) => [m.source, m.target, m.readOnly ?? false]),
    options.user ?? null,
  ]);
}

/**
 * Docker containers for sandboxed executions. By default every execution gets
 * a container no code ran in before: a released container is destroyed and a
 * fresh one with the same settings is started in its place, so the next
 * execution finds it warm. With `reuseContainers` a released container goes
 * back to the pool as it is.
 */
export class ContainerPool {
  private docker: Docker;
  private idle: PooledContainer[] = [];
  private active = new Map<string, PooledContainer>();
  private warming = new Set<Promise<void>>();
  private maxSize: number;
  private idleTimeoutMs: number;
  private reuseContainers: boolean;
  private closed = false;
  private cleanupInterval?: ReturnType<typeof setInterval>;

  constructor(docker: Docker, options: ContainerPoolOptions = {}) {
    this.docker = docker;
    this.maxSize = options.maxSize ?? 5;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
    this.reuseContainers = options.reuseContainers ?? false;

    this.cleanupInterval = setInterval(() => void this.cleanup(), this.idleTimeoutMs / 2);
    this.cleanupInterval.unref?.();
  }

  async acquire(image: string, options: ContainerCreateOptions): Promise<DockerContainer> {
    const key = poolKey(image, options);
    const index = this.idle.findIndex((c) => c.key === key);
    const pooled =
      index === -1
        ? { container: await this.createContainer(image, options), key, image, options }
        : this.idle.splice(index, 1)[0];

    this.active.set(pooled.container.id, { ...pooled, lastUsed: Date.now() });
    return pooled.container;
  }

  async release(container: DockerContainer, options?: { corrupted?: boolean }): Promise<void> {
    const pooled = this.active.get(container.id);
    this.active.delete(container.id);

    if (pooled && this.reuseContainers && !options?.corrupted && this.hasRoom()) {
      this.idle.push({ ...pooled, lastUsed: Date.now() });
      return;
    }

    await this.destroyContainer(container);
    if (pooled && !this.reuseContainers) this.prewarm(pooled.image, pooled.options);
  }

  private hasRoom(): boolean {
    return !this.closed && this.idle.length + this.warming.size < this.maxSize;
  }

  /** Starts a fresh container with these settings for the next execution. */
  private prewarm(image: string, options: ContainerCreateOptions): void {
    if (!this.hasRoom()) return;
    const warming: Promise<void> = this.createContainer(image, options)
      .then(async (container) => {
        if (this.closed) {
          await this.destroyContainer(container);
          return;
        }
        const key = poolKey(image, options);
        this.idle.push({ container, key, image, options, lastUsed: Date.now() });
      })
      .catch((error: unknown) => {
        console.warn(
          '[container-pool] Failed to start a warm container:',
          error instanceof Error ? error.message : String(error)
        );
      })
      .finally(() => this.warming.delete(warming));
    this.warming.add(warming);
  }

  private async createContainer(
    image: string,
    options: ContainerCreateOptions
  ): Promise<DockerContainer> {
    try {
      await this.docker.getImage(image).inspect();
    } catch {
      await new Promise<void>((resolve, reject) => {
        this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err);
          this.docker.modem.followProgress(stream, (progressErr) => {
            if (progressErr) reject(progressErr);
            else resolve();
          });
        });
      });
    }

    const binds = options.mounts?.map((m) => `${m.source}:${m.target}${m.readOnly ? ':ro' : ''}`);

    const container = await this.docker.createContainer({
      Image: image,
      Cmd: ['sleep', 'infinity'],
      User: options.user,
      Labels: { [SANDBOX_CONTAINER_LABEL]: 'true' },
      HostConfig: {
        Memory: options.memory,
        NanoCpus: options.cpus ? cpusToNanoCpus(options.cpus) : undefined,
        CpuShares: options.cpuShares,
        PidsLimit: options.pidsLimit ?? 100,
        NetworkMode: options.networkMode ?? 'none',
        Dns: options.dns?.length ? options.dns : undefined,
        Binds: binds,
        SecurityOpt: ['no-new-privileges'],
        CapDrop: ['ALL'],
        ReadonlyRootfs: false,
      },
      WorkingDir: '/workspace',
    });

    try {
      await container.start();
    } catch (error) {
      await this.destroyContainer(container);
      throw error;
    }
    return container;
  }

  private async destroyContainer(container: DockerContainer): Promise<void> {
    try {
      await container.stop({ t: 1 });
    } catch (error) {
      console.warn(
        `[container-pool] Failed to stop container ${container.id}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
    try {
      await container.remove({ force: true });
    } catch (error) {
      console.warn(
        `[container-pool] Failed to remove container ${container.id}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private async cleanup(): Promise<void> {
    const now = Date.now();
    const expired = this.idle.filter((pooled) => now - pooled.lastUsed > this.idleTimeoutMs);
    this.idle = this.idle.filter((pooled) => !expired.includes(pooled));
    await Promise.all(expired.map((pooled) => this.destroyContainer(pooled.container)));
  }

  async destroyAll(): Promise<void> {
    this.closed = true;
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    await Promise.all([...this.warming]);
    const containers = [...this.idle, ...this.active.values()].map((c) => c.container);
    this.idle = [];
    this.active.clear();
    await Promise.all(containers.map((container) => this.destroyContainer(container)));
  }
}
