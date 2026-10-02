/**
 * Container pool for reusing Docker containers
 */

import type { SandboxMount } from '@cogitator-ai/types';
import type { Docker, DockerContainer } from '../docker-types';
import { cpusToNanoCpus } from '../utils/parse-resources';

interface PooledContainer {
  container: DockerContainer;
  key: string;
  inUse: boolean;
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

export class ContainerPool {
  private docker: Docker;
  private containers: PooledContainer[] = [];
  private maxSize: number;
  private idleTimeoutMs: number;
  private cleanupInterval?: ReturnType<typeof setInterval>;

  constructor(docker: Docker, options: ContainerPoolOptions = {}) {
    this.docker = docker;
    this.maxSize = options.maxSize ?? 5;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000;

    this.cleanupInterval = setInterval(() => void this.cleanup(), this.idleTimeoutMs / 2);
    this.cleanupInterval.unref?.();
  }

  async acquire(image: string, options: ContainerCreateOptions): Promise<DockerContainer> {
    const key = poolKey(image, options);
    const available = this.containers.find((c) => !c.inUse && c.key === key);

    if (available) {
      available.inUse = true;
      available.lastUsed = Date.now();
      return available.container;
    }

    const container = await this.createContainer(image, options);

    if (this.containers.length < this.maxSize) {
      this.containers.push({
        container,
        key,
        inUse: true,
        lastUsed: Date.now(),
      });
    }

    return container;
  }

  async release(container: DockerContainer, options?: { corrupted?: boolean }): Promise<void> {
    const pooled = this.containers.find((c) => c.container.id === container.id);

    if (options?.corrupted) {
      if (pooled) {
        this.containers = this.containers.filter((c) => c.container.id !== container.id);
      }
      await this.destroyContainer(container);
      return;
    }

    if (pooled) {
      pooled.inUse = false;
      pooled.lastUsed = Date.now();
    } else {
      await this.destroyContainer(container);
    }
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
    const toRemove: PooledContainer[] = [];

    for (const pooled of this.containers) {
      if (!pooled.inUse && now - pooled.lastUsed > this.idleTimeoutMs) {
        toRemove.push(pooled);
      }
    }

    for (const pooled of toRemove) {
      this.containers = this.containers.filter((c) => c !== pooled);
      await this.destroyContainer(pooled.container);
    }
  }

  async destroyAll(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    await Promise.all(this.containers.map((c) => this.destroyContainer(c.container)));
    this.containers = [];
  }
}
