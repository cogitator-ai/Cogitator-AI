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
} from '@cogitator-ai/types';
import { type BaseSandboxExecutor } from './executors/base';
import { DockerSandboxExecutor } from './executors/docker';
import { NativeSandboxExecutor } from './executors/native';
import { WasmSandboxExecutor } from './executors/wasm';

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

    try {
      const wasm = new WasmSandboxExecutor({
        wasm: this.config.wasm,
      });
      const result = await wasm.connect();
      if (result.success) {
        this.executors.set('wasm', wasm);
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
      if (type === 'wasm') {
        console.warn(
          '[sandbox] WASM unavailable, falling back to Docker'
        );
        const dockerExecutor = this.executors.get('docker');
        if (dockerExecutor) {
          return dockerExecutor.execute(request, { ...config, type: 'docker' });
        }
        console.warn(
          '[sandbox] Docker also unavailable, falling back to native execution'
        );
        const nativeExecutor = this.executors.get('native');
        if (nativeExecutor) {
          return nativeExecutor.execute(request, { ...config, type: 'native' });
        }
      }
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

  async isWasmAvailable(): Promise<boolean> {
    await this.initialize();
    const wasm = this.executors.get('wasm');
    return wasm ? wasm.isAvailable() : false;
  }

  async shutdown(): Promise<void> {
    for (const executor of this.executors.values()) {
      await executor.disconnect();
    }
    this.executors.clear();
    this.initialized = false;
  }
}
