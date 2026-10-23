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
  commandError,
  fileError,
  sdkError,
  setting,
  throttledKeepAlive,
  unreachable,
  type RemoteSandboxDisposal,
} from './provider';
import { RemoteShellWorkspace, type RemoteWorkspaceOptions } from './remote-shell-workspace';

const PROVIDER = 'Vercel Sandbox';
const DEFAULT_LIFETIME = 30 * 60_000;

export interface VercelSandboxWorkspaceOptions extends RemoteWorkspaceOptions {
  /**
   * Access token, with `teamId` and `projectId` (default: `VERCEL_TOKEN`, `VERCEL_TEAM_ID` and
   * `VERCEL_PROJECT_ID`). Without them the SDK finds the OIDC token itself: the request's
   * `x-vercel-oidc-token` header in a Vercel Function, `VERCEL_OIDC_TOKEN` after `vercel env pull`
   */
  token?: string;
  teamId?: string;
  projectId?: string;
  /**
   * Name of the sandbox: an existing sandbox of that name is reused (resumed when stopped), else
   * one is created with it. Without a name a fresh sandbox is created
   */
  name?: string;
  /**
   * Image a created sandbox starts from, e.g. `vercel/sandbox/node:24` or an image of your
   * project's registry (default: Vercel's `vercel/sandbox/universal`)
   */
  image?: string;
  /**
   * Legacy runtime of a created sandbox, e.g. `node24`
   *
   * @deprecated Use `image`, as `@vercel/sandbox` does
   */
  runtime?: string;
  /**
   * Milliseconds the sandbox runs before Vercel stops it (default: 30 minutes). The workspace
   * extends it while it is used, within what your plan allows
   */
  lifetime?: number;
  /** Virtual CPUs of a created sandbox */
  vcpus?: number;
  /** Ports a created sandbox exposes */
  ports?: number[];
  /**
   * What `dispose()` does with the sandbox: `destroy` deletes it with the snapshots only it
   * used, `stop` stops it (a named, persistent sandbox keeps its files for the next run), `keep`
   * leaves it running (default: `stop` for a named sandbox, `destroy` otherwise). A sandbox
   * created without a name is not persistent, so it leaves no snapshot behind
   */
  onDispose?: RemoteSandboxDisposal;
}

interface VercelCredentials {
  token: string;
  teamId: string;
  projectId: string;
}

interface VercelCreateParams extends Partial<VercelCredentials> {
  name?: string;
  image?: string;
  runtime?: string;
  persistent?: boolean;
  timeout?: number;
  ports?: number[];
  resources?: { vcpus: number };
}

interface VercelRunParams {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

interface VercelLogLine {
  stream: 'stdout' | 'stderr';
  data: string;
}

interface VercelCommand {
  logs(): AsyncIterable<VercelLogLine> & { close(): void };
  wait(): Promise<{ exitCode: number }>;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>;
  writeStdin(data: string): Promise<void>;
  closeStdin(): Promise<void>;
}

interface VercelSandbox {
  readonly name: string;
  extendTimeout(duration: number): Promise<void>;
  readFileToBuffer(file: { path: string }): Promise<Buffer | null>;
  writeFiles(files: { path: string; content: Uint8Array }[]): Promise<void>;
  runCommand(params: VercelRunParams & { detached: true; stdin: true }): Promise<VercelCommand>;
  runCommand(params: VercelRunParams): Promise<{
    exitCode: number;
    stdout(): Promise<string>;
    stderr(): Promise<string>;
  }>;
  stop(): Promise<unknown>;
  delete(opts?: { deleteOrphanSnapshots?: boolean }): Promise<void>;
}

/** The part of the `@vercel/sandbox` package the workspace uses. */
export interface VercelSandboxModule {
  Sandbox: {
    create(params?: VercelCreateParams): Promise<VercelSandbox>;
    getOrCreate(params?: VercelCreateParams & { resume?: boolean }): Promise<VercelSandbox>;
  };
}

async function loadVercel(): Promise<VercelSandboxModule> {
  try {
    const sdk: VercelSandboxModule = await import('@vercel/sandbox');
    return sdk;
  } catch (error) {
    throw sdkError('VercelSandboxWorkspace', '@vercel/sandbox', error);
  }
}

/**
 * A workspace in a [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox): created on first
 * use, or reused by `name`, and deleted (or, when named, stopped) by `dispose()`. The root
 * defaults to `/vercel/sandbox`. Needs the `@vercel/sandbox` package and either Vercel's OIDC
 * token (found by the SDK) or an access token with its team and project. See
 * {@link RemoteShellWorkspace} for how files and commands behave.
 */
export class VercelSandboxWorkspace extends RemoteShellWorkspace {
  constructor(options: VercelSandboxWorkspaceOptions = {}) {
    if (options.image !== undefined && options.runtime !== undefined) {
      throw new WorkspaceError(
        'UNSUPPORTED',
        'VercelSandboxWorkspace takes an image or a runtime, not both'
      );
    }
    super({ ...options, driver: new VercelDriver(options) });
  }
}

class VercelDriver implements RemoteShellDriver {
  readonly provider = PROVIDER;
  readonly defaultRoot = '/vercel/sandbox';

  constructor(private readonly options: VercelSandboxWorkspaceOptions) {}

  async connect(): Promise<RemoteShellConnection> {
    const sdk = await loadVercel();
    const credentials = this.credentials();
    const o = this.options;
    const lifetime = o.lifetime ?? DEFAULT_LIFETIME;
    const params: VercelCreateParams = {
      ...credentials,
      ...(o.name !== undefined && { name: o.name }),
      ...(o.image !== undefined && { image: o.image }),
      ...(o.runtime !== undefined && { runtime: o.runtime }),
      timeout: lifetime,
      ...(o.ports && { ports: o.ports }),
      ...(o.vcpus !== undefined && { resources: { vcpus: o.vcpus } }),
    };
    try {
      const sandbox =
        o.name !== undefined
          ? await sdk.Sandbox.getOrCreate({ ...params, resume: true })
          : await sdk.Sandbox.create({ ...params, persistent: false });
      return new VercelConnection(
        sandbox,
        o.onDispose ?? (o.name !== undefined ? 'stop' : 'destroy'),
        lifetime
      );
    } catch (error) {
      throw unreachable(PROVIDER, error);
    }
  }

  /** The access token triple when one is configured, `{}` to let the SDK find the OIDC token. */
  private credentials(): Partial<VercelCredentials> {
    const token = setting(this.options.token, 'VERCEL_TOKEN');
    const teamId = setting(this.options.teamId, 'VERCEL_TEAM_ID');
    const projectId = setting(this.options.projectId, 'VERCEL_PROJECT_ID');
    if (token && teamId && projectId) return { token, teamId, projectId };
    if (token || teamId || projectId) {
      const missing = [
        !token && 'token (VERCEL_TOKEN)',
        !teamId && 'teamId (VERCEL_TEAM_ID)',
        !projectId && 'projectId (VERCEL_PROJECT_ID)',
      ].filter(Boolean);
      throw new WorkspaceError(
        'UNAVAILABLE',
        `VercelSandboxWorkspace needs a token, a team and a project together, missing: ${missing.join(', ')}`
      );
    }
    return {};
  }
}

class VercelConnection implements RemoteShellConnection {
  readonly sandboxId: string;
  readonly keepAlive: () => Promise<void>;

  constructor(
    private readonly sandbox: VercelSandbox,
    private readonly disposal: RemoteSandboxDisposal,
    lifetime: number
  ) {
    this.sandboxId = sandbox.name;
    this.keepAlive = throttledKeepAlive(lifetime, () => sandbox.extendTimeout(lifetime / 2));
  }

  async readFile(path: string): Promise<Uint8Array> {
    let content: Buffer | null;
    try {
      content = await this.sandbox.readFileToBuffer({ path });
    } catch (error) {
      throw fileError(PROVIDER, path, error, false);
    }
    if (content === null) throw new WorkspaceError('NOT_FOUND', `${path} does not exist`, { path });
    return content;
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    try {
      await this.sandbox.writeFiles([{ path, content }]);
    } catch (error) {
      throw fileError(PROVIDER, path, error, false);
    }
  }

  async run(argv: readonly string[], options: RemoteRunOptions): Promise<RemoteRunResult> {
    try {
      const finished = await this.sandbox.runCommand({
        cmd: argv[0],
        args: argv.slice(1),
        cwd: options.cwd,
        timeoutMs: options.timeout,
      });
      const [stdout, stderr] = await Promise.all([finished.stdout(), finished.stderr()]);
      return { exitCode: finished.exitCode, stdout, stderr };
    } catch (error) {
      throw commandError(PROVIDER, error);
    }
  }

  async spawn(argv: readonly string[], options: RemoteSpawnOptions): Promise<RemoteProcess> {
    let command: VercelCommand;
    try {
      command = await this.sandbox.runCommand({
        cmd: argv[0],
        args: argv.slice(1),
        cwd: options.cwd,
        env: options.env,
        timeoutMs: options.timeout,
        detached: true,
        stdin: true,
      });
    } catch (error) {
      throw commandError(PROVIDER, error);
    }
    try {
      await command.writeStdin(options.stdin);
      await command.closeStdin();
    } catch (error) {
      await command.kill('SIGKILL').catch(() => undefined);
      throw commandError(PROVIDER, error);
    }
    const logs = command.logs();
    const pump = (async () => {
      for await (const line of logs) {
        if (line.stream === 'stdout') options.onStdout(line.data);
        else options.onStderr(line.data);
      }
    })();
    const waiting = (async () => {
      try {
        const [, result] = await Promise.all([pump, command.wait()]);
        return result.exitCode;
      } catch (error) {
        throw commandError(PROVIDER, error);
      }
    })();
    waiting.catch(() => undefined);
    return {
      wait: () => waiting,
      kill: () => command.kill('SIGKILL'),
      detach: () => logs.close(),
    };
  }

  async close(): Promise<void> {
    if (this.disposal === 'destroy') {
      await this.sandbox.delete({ deleteOrphanSnapshots: true }).catch(() => undefined);
    } else if (this.disposal === 'stop') await this.sandbox.stop().catch(() => undefined);
  }
}
