import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Workspace } from '@cogitator-ai/types';
import { LocalWorkspace } from '../workspace/local-workspace';

/** A run working in a workspace, as {@link WorkspaceRuns} keeps it */
export interface WorkspaceRun {
  /** The run's id, read when asked: a resumed run takes the id of its checkpoint */
  readonly runId: () => string;
  readonly threadId: string;
  /** Stops the run */
  abort(reason: Error): void;
  /** Resolves once the run is done */
  readonly done: Promise<void>;
}

/** A run's place in the workspaces it works in, from its start until {@link release} */
export interface WorkspaceRegistration {
  /** Counts the run in `workspace` too, such as after a handoff to an agent with another one */
  add(workspace: Workspace): Promise<void>;
  /** Takes the run out of every workspace it was counted in */
  release(): void;
  /**
   * Counts a tool execution of the run in every workspace the run works in until it settles, also
   * after the run ended: a tool that goes on regardless of its signal may still write the files
   */
  track(execution: Promise<unknown>): void;
}

/**
 * The runs of a runtime going on in each workspace, by the real path of its root, so a file
 * restore (`rewind`, `forkThread` with `files`) knows which runs it would race: those of other
 * threads too, as threads may share a workspace. A restore holds the workspace while it changes
 * the files ({@link lock}), and a run starting there meanwhile waits for it.
 */
export class WorkspaceRuns {
  private readonly roots = new Map<string, Set<WorkspaceRun>>();
  private readonly locks = new Map<string, Promise<void>>();
  /** Tool executions that have not settled yet, by workspace */
  private readonly tools = new Map<string, Set<Promise<unknown>>>();

  /** Registers `run` in `workspace`, once a restore holding it is done */
  async enter(
    run: WorkspaceRun,
    workspace: Workspace | undefined,
    signal?: AbortSignal
  ): Promise<WorkspaceRegistration> {
    const entered = new Set<string>();
    const add = async (each: Workspace): Promise<void> => {
      const key = await keyOf(each);
      if (entered.has(key)) return;
      for (let held = this.locks.get(key); held; held = this.locks.get(key)) {
        await untilSettled(held, signal);
      }
      entered.add(key);
      const runs = this.roots.get(key) ?? new Set<WorkspaceRun>();
      runs.add(run);
      this.roots.set(key, runs);
    };
    if (workspace) await add(workspace);
    return {
      add,
      release: () => {
        for (const key of entered) {
          const runs = this.roots.get(key);
          runs?.delete(run);
          if (runs?.size === 0) this.roots.delete(key);
        }
        entered.clear();
      },
      track: (execution) => {
        const settled = execution.then(
          () => undefined,
          () => undefined
        );
        for (const key of entered) {
          const pending = this.tools.get(key) ?? new Set<Promise<unknown>>();
          pending.add(settled);
          this.tools.set(key, pending);
          void settled.then(() => {
            pending.delete(settled);
            if (pending.size === 0 && this.tools.get(key) === pending) this.tools.delete(key);
          });
        }
      },
    };
  }

  /** How many tool executions in `workspace` have not settled yet, of runs going on or ended */
  async toolsInFlight(workspace: Workspace): Promise<number> {
    return this.tools.get(await keyOf(workspace))?.size ?? 0;
  }

  /**
   * Resolves true once every tool execution in `workspace` settled, false when some still run
   * after `timeoutMs`
   */
  async toolsSettled(workspace: Workspace, timeoutMs: number): Promise<boolean> {
    const key = await keyOf(workspace);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pending = this.tools.get(key);
      if (!pending || pending.size === 0) return true;
      const left = deadline - Date.now();
      if (left <= 0) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(pending),
        new Promise((resolve) => {
          timer = setTimeout(resolve, left);
        }),
      ]);
      clearTimeout(timer);
    }
  }

  /** The runs going on in `workspace` */
  async active(workspace: Workspace): Promise<WorkspaceRun[]> {
    return [...(this.roots.get(await keyOf(workspace)) ?? [])];
  }

  /**
   * Holds `workspace` until the returned release: runs starting in it meanwhile wait, and a
   * second hold waits for the first
   */
  async lock(workspace: Workspace, signal?: AbortSignal): Promise<() => void> {
    const key = await keyOf(workspace);
    for (let held = this.locks.get(key); held; held = this.locks.get(key)) {
      await untilSettled(held, signal);
    }
    let release: () => void = () => undefined;
    const hold = new Promise<void>((done) => {
      release = done;
    });
    this.locks.set(key, hold);
    return () => {
      if (this.locks.get(key) === hold) this.locks.delete(key);
      release();
    };
  }
}

/**
 * The key of a workspace: for a directory of this machine (a `LocalWorkspace`, or a workspace over
 * one such as `DockerWorkspace`) the real path of its root, so every workspace over one directory
 * shares it, for any other (a sandbox) its id
 */
async function keyOf(workspace: Workspace): Promise<string> {
  const local =
    workspace instanceof LocalWorkspace ||
    ('host' in workspace && workspace.host instanceof LocalWorkspace);
  if (!local) return `workspace:${workspace.id}`;
  const root = resolve(workspace.root);
  return `local:${await realpath(root).catch(() => root)}`;
}

function untilSettled(held: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return held;
  if (signal.aborted) return Promise.reject(reasonOf(signal));
  return new Promise<void>((done, fail) => {
    const listener = () => fail(reasonOf(signal));
    signal.addEventListener('abort', listener, { once: true });
    void held.then(() => {
      signal.removeEventListener('abort', listener);
      done();
    });
  });
}

function reasonOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason ?? 'Run aborted'));
}
