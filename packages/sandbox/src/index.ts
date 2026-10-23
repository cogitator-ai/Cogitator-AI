/**
 * @cogitator-ai/sandbox
 *
 * Docker, WASM and native sandbox execution for Cogitator agents, and workspaces in Docker,
 * E2B, Daytona and Vercel Sandbox
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
  createSandboxContainer,
  type ContainerPoolOptions,
  type ContainerCreateOptions,
} from './pool/index';
export { parseMemory, cpusToNanoCpus } from './utils/index';
export {
  DockerWorkspace,
  WORKSPACE_CONTAINER_LABEL,
  WORKSPACE_ROOT_LABEL,
  WORKSPACE_OWNER_LABEL,
  type DockerWorkspaceOptions,
} from './workspace/docker-workspace';
export {
  RemoteShellWorkspace,
  type RemoteShellWorkspaceOptions,
  type RemoteWorkspaceOptions,
} from './workspace/remote/remote-shell-workspace';
export type {
  RemoteShellDriver,
  RemoteShellConnection,
  RemoteRunOptions,
  RemoteRunResult,
  RemoteSpawnOptions,
  RemoteProcess,
} from './workspace/remote/driver';
export type { RemoteSandboxDisposal } from './workspace/remote/provider';
export { shellQuote, shellCommand } from './workspace/remote/shell-quote';
export { E2BWorkspace, type E2BWorkspaceOptions } from './workspace/remote/e2b-workspace';
export {
  DaytonaWorkspace,
  type DaytonaWorkspaceOptions,
} from './workspace/remote/daytona-workspace';
export {
  VercelSandboxWorkspace,
  type VercelSandboxWorkspaceOptions,
} from './workspace/remote/vercel-workspace';

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
