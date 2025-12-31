/**
 * @cogitator-ai/sandbox
 *
 * Docker-based sandbox execution for Cogitator agents
 */

export { SandboxManager } from './sandbox-manager';
export {
  BaseSandboxExecutor,
  NativeSandboxExecutor,
  DockerSandboxExecutor,
  type DockerExecutorOptions,
} from './executors/index';
export { ContainerPool, type ContainerPoolOptions, type ContainerCreateOptions } from './pool/index';
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
  SandboxResult,
} from '@cogitator-ai/types';
