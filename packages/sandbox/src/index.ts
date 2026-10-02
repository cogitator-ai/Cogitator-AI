/**
 * @cogitator-ai/sandbox
 *
 * Docker, WASM and native sandbox execution for Cogitator agents
 */

export { SandboxManager } from './sandbox-manager';
export {
  BaseSandboxExecutor,
  NativeSandboxExecutor,
  DockerSandboxExecutor,
  type DockerExecutorOptions,
  WasmSandboxExecutor,
  type WasmExecutorOptions,
} from './executors/index';
export {
  ContainerPool,
  SANDBOX_CONTAINER_LABEL,
  type ContainerPoolOptions,
  type ContainerCreateOptions,
} from './pool/index';
export { parseMemory, cpusToNanoCpus } from './utils/index';

export type {
  SandboxType,
  SandboxConfig,
  SandboxResourceLimits,
  SandboxNetworkConfig,
  SandboxMount,
  SandboxExecutionRequest,
  SandboxExecutionResult,
  SandboxManagerConfig,
  SandboxPoolConfig,
  SandboxDockerConfig,
  SandboxWasmConfig,
  SandboxResult,
} from '@cogitator-ai/types';
