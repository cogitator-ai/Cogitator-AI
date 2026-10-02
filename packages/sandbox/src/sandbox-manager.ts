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
  private initPromise?: Promise<void>;

  constructor(config: SandboxManagerConfig = {}) {
    this.config = config;
  }

  initialize(): Promise<void> {
    this.initPromise ??= this.initializeExecutors();
    return this.initPromise;
  }

  private async initializeExecutors(): Promise<void> {
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
    } catch (error) {
      console.warn(
        '[sandbox] Docker initialization failed:',
        error instanceof Error ? error.message : String(error)
      );
    }

    try {
      const wasm = new WasmSandboxExecutor({
        wasm: this.config.wasm,
      });
      const result = await wasm.connect();
      if (result.success) {
        this.executors.set('wasm', wasm);
      }
    } catch (error) {
      console.warn(
        '[sandbox] WASM initialization failed:',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  async execute(
    request: SandboxExecutionRequest,
    config: SandboxConfig
  ): Promise<SandboxResult<SandboxExecutionResult>> {
    await this.initialize();

    const mergedConfig: SandboxConfig = {
      ...this.config.defaults,
      ...config,
      resources: { ...this.config.defaults?.resources, ...config.resources },
      network: { ...this.config.defaults?.network, ...config.network },
      env: { ...this.config.defaults?.env, ...config.env },
    };

    const type = mergedConfig.type;
    const executor = this.executors.get(type);
    if (executor) {
      return executor.execute(request, mergedConfig);
    }

    const fallbackChain: SandboxType[] =
      type === 'wasm' ? ['docker', 'native'] : type === 'docker' ? ['native'] : [];

    for (const fallback of fallbackChain) {
      const fallbackExecutor = this.executors.get(fallback);
      if (fallbackExecutor) {
        console.warn(`[sandbox] ${type} unavailable, falling back to ${fallback} execution`);
        return fallbackExecutor.execute(request, { ...mergedConfig, type: fallback });
      }
    }

    return { success: false, error: `Sandbox type '${type}' not available` };
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
    const pending = this.initPromise;
    this.initPromise = undefined;
    if (pending) await pending.catch(() => undefined);

    for (const executor of this.executors.values()) {
      await executor.disconnect();
    }
    this.executors.clear();
  }
}
