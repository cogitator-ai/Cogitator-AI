import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
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
 * the files ({@link lock}), and a run starting there meanwhile waits for it. Workspaces overlap
 * when one root holds the other (`/project` and `/project/sub`): runs, tool calls and holds of
 * either count for both
 */
export class WorkspaceRuns {
  private readonly roots = new Map<string, Set<WorkspaceRun>>();
  private readonly locks = new Map<string, Set<Promise<void>>>();
  /** Tool executions that have not settled yet, by workspace */
  private readonly tools = new Map<string, Set<Promise<unknown>>>();

  /** Registers `run` in `workspace`, once a restore holding it (or one it overlaps) is done */
  async enter(
    run: WorkspaceRun,
    workspace: Workspace | undefined,
    signal?: AbortSignal
  ): Promise<WorkspaceRegistration> {
    const entered = new Set<string>();
    const add = async (each: Workspace): Promise<void> => {
      const key = await keyOf(each);
      if (entered.has(key)) return;
      for (let held = this.holdsOverlapping(key); held.length > 0;) {
        await untilSettled(
          Promise.all(held).then(() => undefined),
          signal
        );
        held = this.holdsOverlapping(key);
      }
      if (entered.has(key)) return;
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

  /**
   * How many tool executions in `workspace` (or a workspace it overlaps) have not settled yet, of
   * runs going on or ended
   */
  async toolsInFlight(workspace: Workspace): Promise<number> {
    return this.pendingTools(await keyOf(workspace)).length;
  }

  /**
   * Resolves true once every tool execution in `workspace` (or a workspace it overlaps) settled,
   * false when some still run after `timeoutMs`
   */
  async toolsSettled(workspace: Workspace, timeoutMs: number): Promise<boolean> {
    const key = await keyOf(workspace);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const pending = this.pendingTools(key);
      if (pending.length === 0) return true;
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

  /** The runs going on in `workspace`, or in a workspace it overlaps */
  async active(workspace: Workspace): Promise<WorkspaceRun[]> {
    const key = await keyOf(workspace);
    const found = new Set<WorkspaceRun>();
    for (const [other, runs] of this.roots) {
      if (overlap(key, other)) for (const run of runs) found.add(run);
    }
    return [...found];
  }

  /**
   * Holds `workspace` until the returned release: runs starting in it (or in a workspace it
   * overlaps) meanwhile wait, and a second hold of an overlapping workspace waits for the first
   */
  async lock(workspace: Workspace, signal?: AbortSignal): Promise<() => void> {
    const key = await keyOf(workspace);
    for (let held = this.holdsOverlapping(key); held.length > 0;) {
      await untilSettled(
        Promise.all(held).then(() => undefined),
        signal
      );
      held = this.holdsOverlapping(key);
    }
    let release: () => void = () => undefined;
    const hold = new Promise<void>((done) => {
      release = done;
    });
    const holds = this.locks.get(key) ?? new Set<Promise<void>>();
    holds.add(hold);
    this.locks.set(key, holds);
    return () => {
      holds.delete(hold);
      if (holds.size === 0 && this.locks.get(key) === holds) this.locks.delete(key);
      release();
    };
  }

  private pendingTools(key: string): Promise<unknown>[] {
    const found: Promise<unknown>[] = [];
    for (const [other, pending] of this.tools) if (overlap(key, other)) found.push(...pending);
    return [...new Set(found)];
  }

  /**
   * The holds of workspaces overlapping `key`. Callers check it and register in the same turn,
   * with nothing awaited in between, so two waiters woken by one release never both go on
   */
  private holdsOverlapping(key: string): Promise<void>[] {
    return [...this.locks].flatMap(([other, holds]) => (overlap(key, other) ? [...holds] : []));
  }
}

/**
 * The key of a workspace: for a directory of this machine (a `LocalWorkspace`, or a workspace over
 * one such as `DockerWorkspace`, whose root is its host's) the real path of its root, so every
 * workspace over one directory shares it, for any other (a sandbox) its id
 */
async function keyOf(workspace: Workspace): Promise<string> {
  const local =
    workspace instanceof LocalWorkspace ||
    ('host' in workspace && workspace.host instanceof LocalWorkspace);
  if (!local) return `workspace:${workspace.id}`;
  const root = resolve(workspace.root);
  return `local:${await realpath(root).catch(() => root)}`;
}

/** Whether two workspace keys share files: the same sandbox, or local roots one holding the other */
function overlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a.startsWith('local:') || !b.startsWith('local:')) return false;
  const [x, y] = [a.slice(6), b.slice(6)];
  return within(x, y) || within(y, x);
}

function within(inner: string, outer: string): boolean {
  const prefix = outer.endsWith(sep) ? outer : `${outer}${sep}`;
  return inner.startsWith(prefix);
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
