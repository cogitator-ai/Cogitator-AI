/**
 * Docker types for sandbox execution
 * These are minimal interfaces to avoid requiring @types/dockerode at compile time
 */

export interface DockerStream {
  on(event: 'data', listener: (chunk: Buffer) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
  write(data: string | Buffer): boolean;
  end(): void;
  /** Closes the connection, also while the other side still sends (a hijacked socket has it) */
  destroy?(): void;
}

export interface DockerExec {
  start(options: { hijack?: boolean; stdin?: boolean }): Promise<DockerStream>;
  inspect(): Promise<{ ExitCode: number | null }>;
}

export interface DockerContainer {
  id: string;
  start(): Promise<void>;
  stop(options?: { t?: number }): Promise<void>;
  remove(options?: { force?: boolean }): Promise<void>;
  exec(options: {
    Cmd: string[];
    Env?: string[];
    WorkingDir?: string;
    AttachStdout?: boolean;
    AttachStderr?: boolean;
    AttachStdin?: boolean;
  }): Promise<DockerExec>;
}

export interface DockerImage {
  inspect(): Promise<unknown>;
}

/** A container as `listContainers` describes it. */
export interface DockerContainerSummary {
  Id: string;
  Labels?: Record<string, string>;
}

export interface Docker {
  ping(): Promise<string>;
  /** Containers matching `filters` (Dockerode has it, test doubles may leave it out) */
  listContainers?(options: {
    all?: boolean;
    filters?: Record<string, string[]>;
  }): Promise<DockerContainerSummary[]>;
  /** A handle on an existing container */
  getContainer?(id: string): Pick<DockerContainer, 'remove'>;
  createContainer(options: Record<string, unknown>): Promise<DockerContainer>;
  getImage(name: string): DockerImage;
  pull(image: string, callback: (err: Error | null, stream: NodeJS.ReadableStream) => void): void;
  modem: {
    followProgress(
      stream: NodeJS.ReadableStream,
      callback: (err: Error | null, output: unknown[]) => void
    ): void;
  };
}
