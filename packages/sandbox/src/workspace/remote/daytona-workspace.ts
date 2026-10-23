import { randomUUID } from 'node:crypto';
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
  delay,
  fileError,
  missingSdk,
  setting,
  unreachable,
  type RemoteSandboxDisposal,
} from './provider';
import { RemoteShellWorkspace, type RemoteWorkspaceOptions } from './remote-shell-workspace';
import { isEnvName, shellCommand, shellQuote } from './shell-quote';

const PROVIDER = 'Daytona';
const EXIT_CODE_POLLS = 20;

export interface DaytonaWorkspaceOptions extends RemoteWorkspaceOptions {
  /** API key (default: `DAYTONA_API_KEY`) */
  apiKey?: string;
  /** API URL (default: `DAYTONA_API_URL`, else Daytona's cloud) */
  apiUrl?: string;
  /** Region the sandbox runs in (default: `DAYTONA_TARGET`, else the organization's default) */
  target?: string;
  /** Use this existing sandbox (an id or a name) instead of creating one, starting it when stopped */
  sandbox?: string;
  /** Name of a created sandbox */
  name?: string;
  /** Image a created sandbox runs, e.g. `node:24-bookworm` (default: Daytona's default snapshot) */
  image?: string;
  /** Snapshot a created sandbox starts from, instead of `image` */
  snapshot?: string;
  /** CPU, memory (GiB) and disk (GiB) of a sandbox created from `image` */
  resources?: { cpu?: number; memory?: number; disk?: number };
  /** Environment variables of the sandbox itself */
  sandboxEnv?: Record<string, string>;
  /** Labels of a created sandbox */
  labels?: Record<string, string>;
  /** Minutes without activity before Daytona stops the sandbox, 0 for never (default: Daytona's 15) */
  autoStopInterval?: number;
  /** Seconds to wait for a created or started sandbox (default: 60) */
  startTimeout?: number;
  /**
   * What `dispose()` does with the sandbox: `destroy` deletes it, `stop` stops it, `keep`
   * leaves it running (default: `destroy` for a sandbox the workspace created, `keep` for one
   * given by `sandbox`)
   */
  onDispose?: RemoteSandboxDisposal;
}

interface DaytonaCreateParams {
  name?: string;
  image?: string;
  snapshot?: string;
  envVars?: Record<string, string>;
  labels?: Record<string, string>;
  autoStopInterval?: number;
  resources?: { cpu?: number; memory?: number; disk?: number };
}

interface DaytonaProcess {
  createSession(sessionId: string): Promise<void>;
  executeSessionCommand(
    sessionId: string,
    req: { command: string; runAsync?: boolean; suppressInputEcho?: boolean },
    timeout?: number
  ): Promise<{ cmdId: string; exitCode?: number; stdout?: string; stderr?: string }>;
  getSessionCommandLogs(
    sessionId: string,
    commandId: string,
    onStdout: (chunk: string) => void,
    onStderr: (chunk: string) => void
  ): Promise<void>;
  getSessionCommand(sessionId: string, commandId: string): Promise<{ exitCode?: number }>;
  sendSessionCommandInput(sessionId: string, commandId: string, data: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

interface DaytonaSandbox {
  id: string;
  state?: string;
  fs: {
    uploadFile(file: Buffer, remotePath: string, timeout?: number): Promise<void>;
    downloadFile(remotePath: string, timeout?: number): Promise<Buffer>;
  };
  process: DaytonaProcess;
  getWorkDir(): Promise<string | undefined>;
  start(timeout?: number): Promise<void>;
  stop(timeout?: number): Promise<void>;
  delete(timeout?: number): Promise<void>;
}

/** The part of the `@daytona/sdk` package the workspace uses. */
export interface DaytonaModule {
  Daytona: new (config?: { apiKey?: string; apiUrl?: string; target?: string }) => {
    create(params?: DaytonaCreateParams, options?: { timeout?: number }): Promise<DaytonaSandbox>;
    get(sandboxIdOrName: string): Promise<DaytonaSandbox>;
  };
}

async function loadDaytona(): Promise<DaytonaModule> {
  try {
    const sdk: DaytonaModule = await import('@daytona/sdk');
    return sdk;
  } catch (error) {
    throw missingSdk('DaytonaWorkspace', '@daytona/sdk', error);
  }
}

/**
 * A workspace in a [Daytona](https://daytona.io) sandbox: created on first use (or reused by
 * id or name with `sandbox`) and deleted by `dispose()`. The root defaults to the sandbox's
 * working directory (`/home/daytona`). Needs the `@daytona/sdk` package and an API key
 * (`DAYTONA_API_KEY`, with `DAYTONA_API_URL` and `DAYTONA_TARGET` when not on the default cloud).
 * Commands run in Daytona sessions. See {@link RemoteShellWorkspace} for how files and commands
 * behave.
 */
export class DaytonaWorkspace extends RemoteShellWorkspace {
  constructor(options: DaytonaWorkspaceOptions = {}) {
    super({ ...options, driver: new DaytonaDriver(options) });
  }
}

class DaytonaDriver implements RemoteShellDriver {
  readonly provider = PROVIDER;
  readonly defaultRoot = '/home/daytona';

  constructor(private readonly options: DaytonaWorkspaceOptions) {}

  async connect(): Promise<RemoteShellConnection> {
    const sdk = await loadDaytona();
    const apiKey = setting(this.options.apiKey, 'DAYTONA_API_KEY');
    if (!apiKey) {
      throw new WorkspaceError(
        'UNAVAILABLE',
        'DaytonaWorkspace needs a Daytona API key: set DAYTONA_API_KEY or pass apiKey'
      );
    }
    const apiUrl = setting(this.options.apiUrl, 'DAYTONA_API_URL');
    const target = setting(this.options.target, 'DAYTONA_TARGET');
    const startTimeout = this.options.startTimeout ?? 60;
    try {
      const client = new sdk.Daytona({
        apiKey,
        ...(apiUrl && { apiUrl }),
        ...(target && { target }),
      });
      const existing = this.options.sandbox;
      let sandbox: DaytonaSandbox;
      if (existing) {
        sandbox = await client.get(existing);
        if (sandbox.state !== 'started') await sandbox.start(startTimeout);
      } else {
        sandbox = await client.create(this.createParams(), { timeout: startTimeout });
      }
      const home = await sandbox.getWorkDir().catch(() => undefined);
      const disposal = this.options.onDispose ?? (existing ? 'keep' : 'destroy');
      return new DaytonaConnection(sandbox, disposal, home);
    } catch (error) {
      throw unreachable(PROVIDER, error);
    }
  }

  private createParams(): DaytonaCreateParams {
    const o = this.options;
    return {
      ...(o.name !== undefined && { name: o.name }),
      ...(o.image !== undefined && { image: o.image }),
      ...(o.image !== undefined && o.resources && { resources: o.resources }),
      ...(o.image === undefined && o.snapshot !== undefined && { snapshot: o.snapshot }),
      ...(o.sandboxEnv && { envVars: o.sandboxEnv }),
      ...(o.labels && { labels: o.labels }),
      ...(o.autoStopInterval !== undefined && { autoStopInterval: o.autoStopInterval }),
    };
  }
}

/**
 * A Daytona sandbox. Commands run in sessions: a session per started command (deleted when it
 * ends, unless it keeps background processes), and a small pool of sessions reused for the
 * workspace's own short scripts, which run synchronously.
 */
class DaytonaConnection implements RemoteShellConnection {
  readonly sandboxId: string;
  private readonly idle: string[] = [];
  private readonly sessions = new Set<string>();

  constructor(
    private readonly sandbox: DaytonaSandbox,
    private readonly disposal: RemoteSandboxDisposal,
    readonly home: string | undefined
  ) {
    this.sandboxId = sandbox.id;
  }

  async readFile(path: string): Promise<Uint8Array> {
    try {
      return await this.sandbox.fs.downloadFile(path);
    } catch (error) {
      throw fileError(PROVIDER, path, error);
    }
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    try {
      await this.sandbox.fs.uploadFile(Buffer.from(content), path);
    } catch (error) {
      throw fileError(PROVIDER, path, error);
    }
  }

  async run(argv: readonly string[], options: RemoteRunOptions): Promise<RemoteRunResult> {
    const shell = this.sandbox.process;
    let session: string;
    try {
      session = this.idle.pop() ?? (await this.openSession());
    } catch (error) {
      throw commandError(PROVIDER, error);
    }
    try {
      const response = await shell.executeSessionCommand(
        session,
        { command: `${commandLine(argv, options.cwd, {})} </dev/null` },
        Math.ceil(options.timeout / 1000)
      );
      this.idle.push(session);
      return {
        exitCode: response.exitCode ?? 1,
        stdout: response.stdout ?? '',
        stderr: response.stderr ?? '',
      };
    } catch (error) {
      await this.closeSession(session);
      throw commandError(PROVIDER, error);
    }
  }

  async spawn(argv: readonly string[], options: RemoteSpawnOptions): Promise<RemoteProcess> {
    const shell = this.sandbox.process;
    let session: string;
    let commandId: string;
    try {
      session = await this.openSession();
    } catch (error) {
      throw commandError(PROVIDER, error);
    }
    try {
      const started = await shell.executeSessionCommand(session, {
        command: commandLine(argv, options.cwd, options.env),
        runAsync: true,
        suppressInputEcho: true,
      });
      commandId = started.cmdId;
      await shell.sendSessionCommandInput(session, commandId, options.stdin);
    } catch (error) {
      await this.closeSession(session);
      throw commandError(PROVIDER, error);
    }
    const logs = shell.getSessionCommandLogs(
      session,
      commandId,
      (chunk) => options.onStdout(chunk),
      (chunk) => options.onStderr(chunk)
    );
    const wait = async (): Promise<number> => {
      try {
        await logs;
        for (let poll = 0; poll < EXIT_CODE_POLLS; poll++) {
          const { exitCode } = await shell.getSessionCommand(session, commandId);
          if (exitCode !== undefined && exitCode !== null) return exitCode;
          await delay(Math.min(50 * 2 ** poll, 1_000));
        }
        throw new WorkspaceError('IO', 'Daytona did not report the exit code of the command');
      } catch (error) {
        throw commandError(PROVIDER, error);
      } finally {
        if (options.background === 'kill') await this.closeSession(session);
      }
    };
    const waiting = wait();
    waiting.catch(() => undefined);
    return {
      wait: () => waiting,
      kill: () => this.closeSession(session),
    };
  }

  async close(): Promise<void> {
    if (this.disposal === 'destroy') {
      await this.sandbox.delete().catch(() => undefined);
      return;
    }
    await Promise.all([...this.sessions].map((session) => this.closeSession(session)));
    if (this.disposal === 'stop') await this.sandbox.stop().catch(() => undefined);
  }

  private async openSession(): Promise<string> {
    const session = `cogitator-${randomUUID()}`;
    await this.sandbox.process.createSession(session);
    this.sessions.add(session);
    return session;
  }

  private async closeSession(session: string): Promise<void> {
    if (!this.sessions.delete(session)) return;
    const index = this.idle.indexOf(session);
    if (index !== -1) this.idle.splice(index, 1);
    await this.sandbox.process.deleteSession(session).catch(() => undefined);
  }
}

/**
 * The line a session runs: into `cwd`, then the program with `env`. A session keeps its directory
 * between commands, so each one sets it.
 */
function commandLine(argv: readonly string[], cwd: string, env: Record<string, string>): string {
  const assignments = Object.entries(env).map(([name, value]) => {
    if (!isEnvName(name)) {
      throw new WorkspaceError(
        'UNSUPPORTED',
        `${JSON.stringify(name)} is not a valid environment variable name`
      );
    }
    return shellQuote(`${name}=${value}`);
  });
  const program =
    assignments.length > 0
      ? `env ${assignments.join(' ')} ${shellCommand(argv)}`
      : shellCommand(argv);
  return `cd ${shellQuote(cwd)} && ${program}`;
}
