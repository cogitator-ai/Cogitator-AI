import { useSyncExternalStore } from 'react';
import type { HostStatus, RunRecord, StudioEvent, ThreadRecord } from '../protocol';
import { api, subscribe, type RunTree } from './api';

export interface UiState {
  connected: boolean;
  loaded: boolean;
  project: string;
  host: HostStatus;
  runs: Record<string, RunRecord>;
  threads: Record<string, ThreadRecord>;
}

let state: UiState = {
  connected: false,
  loaded: false,
  project: '',
  host: { state: 'starting' },
  runs: {},
  threads: {},
};
const listeners = new Set<() => void>();

function set(next: Partial<UiState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function upsertRuns(runs: readonly RunRecord[]): void {
  if (runs.length === 0) return;
  const next = { ...state.runs };
  for (const run of runs) next[run.id] = run;
  set({ runs: next });
}

function apply(event: StudioEvent): void {
  switch (event.type) {
    case 'host':
      set({ host: event.status });
      break;
    case 'run':
      upsertRuns([event.run]);
      break;
    case 'thread':
      set({ threads: { ...state.threads, [event.thread.id]: event.thread } });
      break;
    case 'token':
    case 'reasoning': {
      const run = state.runs[event.runId];
      if (!run) break;
      const field = event.type === 'token' ? 'output' : 'reasoning';
      upsertRuns([{ ...run, [field]: (run[field] ?? '') + event.text }]);
      break;
    }
  }
}

/** Connects the UI to the studio: the state once, then every event. */
export function connect(): () => void {
  const unsubscribe = subscribe(apply, (connected) => {
    set({ connected });
    if (connected) void refresh();
  });
  return unsubscribe;
}

export async function refresh(): Promise<void> {
  const response = await api.state();
  set({
    loaded: true,
    project: response.project,
    host: response.host,
    threads: Object.fromEntries(response.threads.map((thread) => [thread.id, thread])),
  });
  upsertRuns(response.runs);
}

/** Loads a run with everything it started and its forks into the state. */
export async function loadRun(id: string): Promise<RunTree> {
  const tree = await api.run(id);
  upsertRuns([tree.run, ...tree.descendants, ...tree.forks]);
  return tree;
}

/** Loads runs a view lists, such as the runs of a workflow, into the state. */
export async function loadRuns(query: {
  target?: string;
  kind?: string;
  q?: string;
}): Promise<void> {
  const response = await api.runs(query);
  upsertRuns(response.runs);
}

export async function loadThread(id: string): Promise<void> {
  const { thread, runs } = await api.thread(id);
  set({ threads: { ...state.threads, [thread.id]: thread } });
  upsertRuns(runs);
}

export function useStudio<T>(select: (current: UiState) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => select(state)
  );
}

export function getState(): UiState {
  return state;
}
