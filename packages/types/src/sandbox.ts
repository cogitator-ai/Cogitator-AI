/**
 * Sandbox types for isolated tool execution
 */


export type SandboxType = 'docker' | 'native';

export interface SandboxResourceLimits {
  /** Memory limit (e.g., '256MB', '1GB') */
  memory?: string;
  /** CPU shares (0-1024, default: 512) */
  cpuShares?: number;
  /** Number of CPUs (e.g., 0.5, 1, 2) */
  cpus?: number;
  /** Max PIDs (default: 100) */
  pidsLimit?: number;
}

export interface SandboxNetworkConfig {
  /** Network mode: 'none' (isolated), 'bridge' (default Docker), 'host' */
  mode?: 'none' | 'bridge' | 'host';
  /** Allowed outbound hosts (only when mode is 'bridge') */
  allowedHosts?: string[];
  /** DNS servers */
  dns?: string[];
}

export interface SandboxMount {
  /** Source path on host */
  source: string;
  /** Target path in container */
  target: string;
  /** Read-only mount */
  readOnly?: boolean;
}

export interface SandboxConfig {
  type: SandboxType;
  /** Docker image (for docker type) */
  image?: string;
  /** Resource limits */
  resources?: SandboxResourceLimits;
  /** Network configuration */
  network?: SandboxNetworkConfig;
  /** Volume mounts */
  mounts?: SandboxMount[];
  /** Execution timeout in milliseconds */
  timeout?: number;
  /** Working directory inside container */
  workdir?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** User to run as (e.g., 'sandbox', '1000:1000') */
  user?: string;
}


export interface SandboxExecutionRequest {
  /** Command to execute */
  command: string[];
  /** Stdin input */
  stdin?: string;
  /** Working directory */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Execution timeout (overrides config) */
  timeout?: number;
}

export interface SandboxExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Whether execution was killed due to timeout */
  timedOut: boolean;
  /** Execution duration in milliseconds */
  duration: number;
}


export interface SandboxPoolConfig {
  /** Max containers to keep warm */
  maxSize?: number;
  /** Idle timeout before destroying container (ms) */
  idleTimeoutMs?: number;
}

export interface SandboxDockerConfig {
  /** Docker socket path */
  socketPath?: string;
  /** Docker host */
  host?: string;
  /** Docker port */
  port?: number;
}

export interface SandboxManagerConfig {
  /** Default sandbox configuration */
  defaults?: Partial<SandboxConfig>;
  /** Container pool settings */
  pool?: SandboxPoolConfig;
  /** Docker connection options */
  docker?: SandboxDockerConfig;
}

export type SandboxResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };
