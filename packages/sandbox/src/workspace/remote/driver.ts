/**
 * How a {@link RemoteShellWorkspace} reaches a sandbox: create or connect to it, move bytes in and
 * out, and run programs in it. Everything else (path checks, listing, moves, snapshots, process
 * groups) the workspace does itself with shell scripts it runs through the driver, so a new
 * provider only implements this.
 *
 * A driver throws `WorkspaceError`s: `UNAVAILABLE` when the SDK, the credentials or the sandbox
 * are missing, `NOT_FOUND` for a file that is not there, `IO` for the rest.
 */
export interface RemoteShellDriver {
  /** Name of the provider, used in messages, e.g. `E2B` */
  readonly provider: string;
  /** The directory a relative (or missing) `root` is resolved against when the connection names none */
  readonly defaultRoot: string;
  /** Creates the sandbox or connects to an existing one */
  connect(): Promise<RemoteShellConnection>;
}

/** A sandbox a driver created or connected to. */
export interface RemoteShellConnection {
  /** Id (or name) of the sandbox */
  readonly sandboxId: string;
  /** The user's working directory in the sandbox, when the provider reports one */
  readonly home?: string;
  /** The bytes of the file at the absolute `path` */
  readFile(path: string): Promise<Uint8Array>;
  /** Writes `content` to the absolute `path`, replacing the file. Its parent directory exists */
  writeFile(path: string, content: Uint8Array): Promise<void>;
  /** Runs a program to its end and collects its output */
  run(argv: readonly string[], options: RemoteRunOptions): Promise<RemoteRunResult>;
  /** Starts a program, its output streamed as it arrives */
  spawn(argv: readonly string[], options: RemoteSpawnOptions): Promise<RemoteProcess>;
  /** Releases the sandbox: removes, stops or keeps it, as the workspace was configured */
  close(): Promise<void>;
}

export interface RemoteRunOptions {
  /** Absolute directory to run in */
  cwd: string;
  /** Milliseconds the program may run before the provider stops it */
  timeout: number;
}

export interface RemoteRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RemoteSpawnOptions {
  /** Absolute directory to run in */
  cwd: string;
  /** Environment variables on top of the sandbox's own */
  env: Record<string, string>;
  /** Text written to the program's stdin right after it starts, stdin then closed */
  stdin: string;
  /**
   * Milliseconds after which the provider may kill the program itself, a backstop: the
   * workspace stops it earlier on its own timeout
   */
  timeout: number;
  /**
   * Whether processes the program leaves in the background are kept (`keep`): a driver must not
   * end them when the program exits, e.g. by closing the session it ran in
   */
  background: 'kill' | 'keep';
  onStdout(chunk: string | Uint8Array): void;
  onStderr(chunk: string | Uint8Array): void;
}

/** A program a driver started. */
export interface RemoteProcess {
  /** Resolves with the exit code once the program ended and its output was delivered */
  wait(): Promise<number>;
  /** Stops the program, best effort */
  kill(): Promise<void>;
  /** Stops delivering output for a program that is left running, best effort */
  detach?(): void;
}
