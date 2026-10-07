/**
 * Sandbox types for isolated tool execution
 */

export type SandboxType = 'docker' | 'native' | 'wasm';

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
  /** WASM module path or URL (for wasm type) */
  wasmModule?: string;
  /** WASM function to call (for wasm type, default: 'run') */
  wasmFunction?: string;
  /** Enable WASI (for wasm type, default: false) */
  wasi?: boolean;
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
  /** Whether `stdout` was cut at the executor's output limit */
  truncated?: boolean;
}

export interface SandboxPoolConfig {
  /** Max containers to keep warm */
  maxSize?: number;
  /** Idle timeout before destroying container (ms) */
  idleTimeoutMs?: number;
  /**
   * Run later executions with the same settings in the same container instead
   * of a fresh one. Faster, but files and processes an execution leaves behind
   * are visible to the next — including other runs and users. Default: false,
   * every execution gets a container nothing ran in before (kept warm ahead).
   */
  reuseContainers?: boolean;
}

export interface SandboxDockerConfig {
  /** Docker socket path */
  socketPath?: string;
  /** Docker host */
  host?: string;
  /** Docker port */
  port?: number;
}

export interface SandboxWasmConfig {
  /** Path or URL to WASM module */
  wasmModule?: string;
  /** Memory limit in 64 KiB pages for the module's own memory and Extism's (default: 256 = 16 MB) */
  memoryPages?: number;
  /** Function name to call in WASM module (default: 'run') */
  functionName?: string;
  /** Enable WASI for filesystem/env access (default: false) */
  wasi?: boolean;
  /** Max cached plugins (default: 10) */
  cacheSize?: number;
}

export interface SandboxManagerConfig {
  /** Default sandbox configuration */
  defaults?: Partial<SandboxConfig>;
  /** Container pool settings */
  pool?: SandboxPoolConfig;
  /** Docker connection options */
  docker?: SandboxDockerConfig;
  /** WASM sandbox options */
  wasm?: SandboxWasmConfig;
  /**
   * Run a Docker-sandboxed tool directly on the host, unsandboxed, when Docker
   * is unavailable (with a warning). Default: true; set false to fail those
   * calls instead. WASM tools never fall back: nothing else can run them.
   */
  allowNativeFallback?: boolean;
}

export type SandboxResult<T> = { success: true; data: T } | { success: false; error: string };
