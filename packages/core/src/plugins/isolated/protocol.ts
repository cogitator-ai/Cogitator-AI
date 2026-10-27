/**
 * What the host and the process of an isolated plugin say to each other over the IPC channel.
 * Types only: the process's loader imports nothing at run time
 */

/** An error as it crosses the channel */
export interface WireError {
  name: string;
  message: string;
  code?: string;
}

/** What `activate` gets about the plugin */
export interface WireIdentity {
  id: string;
  name: string;
  version?: string;
  root: string;
  dataDir: string;
}

/** The kinds of registration a plugin process sends */
export type WireRegistration =
  | {
      kind: 'tool';
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      requiresApproval?: boolean;
      readOnly?: boolean;
      timeout?: number;
    }
  | { kind: 'skill'; skill: Record<string, unknown> }
  | { kind: 'agent'; name: string; definition: Record<string, unknown> }
  | { kind: 'command'; name: string; command: unknown }
  | { kind: 'hooks'; hooks: Record<string, unknown> }
  | { kind: 'mcp'; name: string; config: Record<string, unknown> }
  | { kind: 'llm'; provider: string; metadata: Record<string, unknown> }
  | { kind: 'panel'; panel: Record<string, unknown>; methods: string[] };

/** What the host asks of a plugin's own registrations */
export type WireCallTarget =
  | { kind: 'tool'; handle: number }
  | { kind: 'panel'; handle: number; method: string }
  | { kind: 'llm'; handle: number; backend: number; op: 'chat' | 'complete' };

/** Messages from the host to the plugin process */
export type HostMessage =
  | {
      t: 'activate';
      identity: WireIdentity;
      entry: string;
      options: Record<string, unknown>;
    }
  | {
      t: 'call';
      id: number;
      target: WireCallTarget;
      payload: unknown;
      context?: Record<string, unknown>;
    }
  | { t: 'stream'; id: number; handle: number; backend: number; request: unknown }
  | { t: 'llm.create'; id: number; handle: number; config: unknown }
  | { t: 'cancel'; id: number }
  | { t: 'reply'; id: number; ok: true; value: unknown }
  | { t: 'reply'; id: number; ok: false; error: WireError }
  | { t: 'dispose' };

/** What the plugin process asks of the host */
export type ProcessRequest =
  | { op: 'secret'; key: string }
  | { op: 'files.readFile'; path: string }
  | { op: 'files.writeFile'; path: string; content: string }
  | { op: 'files.list'; path: string }
  | {
      op: 'fetch';
      url: string;
      init?: { method?: string; headers?: Record<string, string>; body?: string };
    }
  | { op: 'exec'; command: string; options?: { cwd?: string; timeoutMs?: number } };

/** Messages from the plugin process to the host */
export type ProcessMessage =
  | { t: 'ready' }
  | { t: 'activated' }
  | { t: 'activate-failed'; error: WireError }
  | { t: 'register'; handle: number; registration: WireRegistration }
  | { t: 'unregister'; handle: number }
  | { t: 'request'; id: number; request: ProcessRequest }
  | { t: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; details?: unknown }
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; error: WireError }
  | { t: 'chunk'; id: number; chunk: unknown }
  | { t: 'end'; id: number }
  | { t: 'disposed' };
