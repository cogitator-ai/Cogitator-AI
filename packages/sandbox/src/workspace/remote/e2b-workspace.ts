import { WorkspaceError } from '@cogitator-ai/types';
import type {
  RemoteProcess,
  RemoteRunOptions,
  RemoteRunResult,
  RemoteShellConnection,
  RemoteShellDriver,
  RemoteSpawnOptions,
} from './driver';
import {
  arrayBufferOf,
  commandError,
  fileError,
  missingSdk,
  setting,
  unreachable,
  type RemoteSandboxDisposal,
} from './provider';
import { RemoteShellWorkspace, type RemoteWorkspaceOptions } from './remote-shell-workspace';
import { shellCommand } from './shell-quote';

const PROVIDER = 'E2B';
const DEFAULT_LIFETIME = 30 * 60_000;

export interface E2BWorkspaceOptions extends RemoteWorkspaceOptions {
  /** API key (default: `E2B_API_KEY`) */
  apiKey?: string;
  /** Template the sandbox is created from (default: E2B's `base`) */
  template?: string;
  /** Connect to this running (or paused) sandbox instead of creating one */
  sandboxId?: string;
  /**
   * Milliseconds the sandbox lives before E2B kills it, counted from its creation (default:
   * 30 minutes). Your E2B plan caps it
   */
  lifetime?: number;
  /** Metadata attached to a created sandbox */
  metadata?: Record<string, string>;
  /**
   * What `dispose()` does with the sandbox: `destroy` kills it, `keep` leaves it running until
   * its lifetime ends (default: `destroy` for a sandbox the workspace created, `keep` for one
   * given by `sandboxId`)
   */
  onDispose?: Exclude<RemoteSandboxDisposal, 'stop'>;
  /** E2B domain, for a self-hosted deployment */
  domain?: string;
  /** Milliseconds each request to E2B may take (default: the SDK's) */
  requestTimeout?: number;
}

interface E2BConnectionOptions {
  apiKey?: string;
  domain?: string;
  requestTimeoutMs?: number;
}

interface E2BCreateOptions extends E2BConnectionOptions {
  timeoutMs?: number;
  metadata?: Record<string, string>;
}

interface E2BCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface E2BRunOptions {
  cwd?: string;
  envs?: Record<string, string>;
  timeoutMs?: number;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

interface E2BCommandHandle {
  wait(): Promise<E2BCommandResult>;
  kill(): Promise<boolean>;
  disconnect(): Promise<void>;
  sendStdin(data: string): Promise<void>;
  closeStdin(): Promise<void>;
}

interface E2BSandbox {
  readonly sandboxId: string;
  files: {
    read(path: string, opts: { format: 'bytes' }): Promise<Uint8Array>;
    write(path: string, data: ArrayBuffer): Promise<unknown>;
  };
  commands: {
    run(
      cmd: string,
      opts: E2BRunOptions & { background: true; stdin: true }
    ): Promise<E2BCommandHandle>;
    run(cmd: string, opts: E2BRunOptions & { background?: false }): Promise<E2BCommandResult>;
  };
  kill(): Promise<boolean>;
}

/** The part of the `e2b` package the workspace uses. */
export interface E2BModule {
  Sandbox: {
    create(template: string, opts?: E2BCreateOptions): Promise<E2BSandbox>;
    connect(sandboxId: string, opts?: E2BConnectionOptions): Promise<E2BSandbox>;
  };
  CommandExitError: abstract new (...args: never[]) => E2BCommandResult;
}

async function loadE2B(): Promise<E2BModule> {
  try {
    const sdk: E2BModule = await import('e2b');
    return sdk;
  } catch (error) {
    throw missingSdk('E2BWorkspace', 'e2b', error);
  }
}

/**
 * A workspace in an [E2B](https://e2b.dev) sandbox: created from `template` on first use (or
 * connected to by `sandboxId`) and killed by `dispose()`. The root defaults to `/home/user`.
 * Needs the `e2b` package and an API key (`E2B_API_KEY`). See {@link RemoteShellWorkspace} for
 * how files and commands behave.
 *
 * @example
 * ```ts
 * const workspace = new E2BWorkspace({ root: 'project' });
 * try {
 *   await cog.run(agent, { input: 'Clone the repo and run its tests', workspace });
 * } finally {
 *   await workspace.dispose();
 * }
 * ```
 */
export class E2BWorkspace extends RemoteShellWorkspace {
  constructor(options: E2BWorkspaceOptions = {}) {
    super({ ...options, driver: new E2BDriver(options) });
  }
}

class E2BDriver implements RemoteShellDriver {
  readonly provider = PROVIDER;
  readonly defaultRoot = '/home/user';

  constructor(private readonly options: E2BWorkspaceOptions) {}

  async connect(): Promise<RemoteShellConnection> {
    const sdk = await loadE2B();
    const apiKey = setting(this.options.apiKey, 'E2B_API_KEY');
    if (!apiKey) {
      throw new WorkspaceError(
        'UNAVAILABLE',
        'E2BWorkspace needs an E2B API key: set E2B_API_KEY or pass apiKey'
      );
    }
    const connection: E2BConnectionOptions = {
      apiKey,
      ...(this.options.domain !== undefined && { domain: this.options.domain }),
      ...(this.options.requestTimeout !== undefined && {
        requestTimeoutMs: this.options.requestTimeout,
      }),
    };
    const existing = this.options.sandboxId;
    try {
      const sandbox = existing
        ? await sdk.Sandbox.connect(existing, connection)
        : await sdk.Sandbox.create(this.options.template ?? 'base', {
            ...connection,
            timeoutMs: this.options.lifetime ?? DEFAULT_LIFETIME,
            ...(this.options.metadata && { metadata: this.options.metadata }),
          });
      const disposal = this.options.onDispose ?? (existing ? 'keep' : 'destroy');
      return new E2BConnection(sdk, sandbox, disposal);
    } catch (error) {
      throw unreachable(PROVIDER, error);
    }
  }
}

class E2BConnection implements RemoteShellConnection {
  readonly sandboxId: string;

  constructor(
    private readonly sdk: E2BModule,
    private readonly sandbox: E2BSandbox,
    private readonly disposal: 'destroy' | 'keep'
  ) {
    this.sandboxId = sandbox.sandboxId;
  }

  async readFile(path: string): Promise<Uint8Array> {
    try {
      return await this.sandbox.files.read(path, { format: 'bytes' });
    } catch (error) {
      throw fileError(PROVIDER, path, error);
    }
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    try {
      await this.sandbox.files.write(path, arrayBufferOf(content));
    } catch (error) {
      throw fileError(PROVIDER, path, error);
    }
  }

  async run(argv: readonly string[], options: RemoteRunOptions): Promise<RemoteRunResult> {
    try {
      const result = await this.sandbox.commands.run(shellCommand(argv), {
        cwd: options.cwd,
        timeoutMs: options.timeout,
      });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      if (error instanceof this.sdk.CommandExitError) {
        return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr };
      }
      throw commandError(PROVIDER, error);
    }
  }

  async spawn(argv: readonly string[], options: RemoteSpawnOptions): Promise<RemoteProcess> {
    let handle: E2BCommandHandle;
    try {
      handle = await this.sandbox.commands.run(shellCommand(argv), {
        background: true,
        stdin: true,
        cwd: options.cwd,
        envs: options.env,
        timeoutMs: options.timeout,
        onStdout: (data) => options.onStdout(data),
        onStderr: (data) => options.onStderr(data),
      });
    } catch (error) {
      throw commandError(PROVIDER, error);
    }
    try {
      await handle.sendStdin(options.stdin);
      await handle.closeStdin();
    } catch (error) {
      await handle.kill().catch(() => false);
      throw commandError(PROVIDER, error);
    }
    const exitError = this.sdk.CommandExitError;
    return {
      async wait() {
        try {
          return (await handle.wait()).exitCode;
        } catch (error) {
          if (error instanceof exitError) return error.exitCode;
          throw commandError(PROVIDER, error);
        }
      },
      async kill() {
        await handle.kill();
      },
      detach() {
        void handle.disconnect().catch(() => undefined);
      },
    };
  }

  async close(): Promise<void> {
    if (this.disposal === 'destroy') await this.sandbox.kill().catch(() => false);
  }
}
