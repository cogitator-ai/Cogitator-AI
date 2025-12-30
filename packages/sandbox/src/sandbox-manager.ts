/**
 * Sandbox manager - orchestrates sandbox execution
 */

import type {
  SandboxConfig,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxManagerConfig,
  SandboxResult,
  SandboxType,
} from '@cogitator/types';
import { BaseSandboxExecutor } from './executors/base.js';
import { DockerSandboxExecutor } from './executors/docker.js';
import { NativeSandboxExecutor } from './executors/native.js';

export class SandboxManager {
  private executors = new Map<SandboxType, BaseSandboxExecutor>();
  private config: SandboxManagerConfig;
  private initialized = false;

  constructor(config: SandboxManagerConfig = {}) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const native = new NativeSandboxExecutor();
    await native.connect();
    this.executors.set('native', native);

    try {
      const docker = new DockerSandboxExecutor({
        docker: this.config.docker,
        pool: this.config.pool,
      });
      const result = await docker.connect();
      if (result.success) {
        this.executors.set('docker', docker);
      }
    } catch {
    }

    this.initialized = true;
  }

  async execute(
    request: SandboxExecutionRequest,
    config: SandboxConfig
  ): Promise<SandboxResult<SandboxExecutionResult>> {
    await this.initialize();

    const type = config.type;
    const executor = this.executors.get(type);

    if (!executor) {
      if (type === 'docker') {
        console.warn(
          '[sandbox] Docker unavailable, falling back to native execution'
        );
        const nativeExecutor = this.executors.get('native');
        if (nativeExecutor) {
          return nativeExecutor.execute(request, { ...config, type: 'native' });
        }
      }
      return { success: false, error: `Sandbox type '${type}' not available` };
    }

    const mergedConfig: SandboxConfig = {
      ...this.config.defaults,
      ...config,
      resources: { ...this.config.defaults?.resources, ...config.resources },
      network: { ...this.config.defaults?.network, ...config.network },
      env: { ...this.config.defaults?.env, ...config.env },
    };

    return executor.execute(request, mergedConfig);
  }

  async isDockerAvailable(): Promise<boolean> {
    await this.initialize();
    const docker = this.executors.get('docker');
    return docker ? docker.isAvailable() : false;
  }

  async shutdown(): Promise<void> {
    for (const executor of this.executors.values()) {
      await executor.disconnect();
    }
    this.executors.clear();
    this.initialized = false;
  }
}
