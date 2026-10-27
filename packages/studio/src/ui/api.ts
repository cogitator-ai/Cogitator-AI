import type {
  ForkRequest,
  ForkPreview,
  ForkSummary,
  HostStatus,
  RewindRequest,
  RewindSummary,
  RunRecord,
  StudioEvent,
  StudioStats,
  ThreadForkRequest,
  ThreadRecord,
  ThreadTree,
} from '../protocol';

export interface StateResponse {
  host: HostStatus;
  project: string;
  runs: RunRecord[];
  threads: ThreadRecord[];
}

/** A request the studio refused, with the HTTP status it answered. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RunTree {
  run: RunRecord;
  descendants: RunRecord[];
  forks: RunRecord[];
}

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? 'GET',
    credentials: 'same-origin',
    headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  const json = (text ? JSON.parse(text) : {}) as T & { error?: string };
  if (!response.ok) throw new ApiError(json.error ?? `HTTP ${response.status}`, response.status);
  return json;
}

export const api = {
  state: () => request<StateResponse>('/api/state'),
  stats: () => request<StudioStats>('/api/stats'),
  runs: (query: { target?: string; kind?: string; q?: string }) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
    return request<{ runs: RunRecord[] }>(`/api/runs?${params.toString()}`);
  },
  run: (id: string) => request<RunTree>(`/api/runs/${encodeURIComponent(id)}`),
  thread: (id: string) =>
    request<{ thread: ThreadRecord; runs: RunRecord[] }>(`/api/threads/${encodeURIComponent(id)}`),
  threadTree: (id: string) => request<ThreadTree>(`/api/threads/${encodeURIComponent(id)}/tree`),
  rewind: (threadId: string, rewind: RewindRequest) =>
    request<RewindSummary & { thread: ThreadRecord }>(
      `/api/threads/${encodeURIComponent(threadId)}/rewind`,
      { method: 'POST', body: rewind }
    ),
  forkThread: (threadId: string, fork: Omit<ThreadForkRequest, 'dryRun'>) =>
    request<ForkSummary & { thread: ThreadRecord }>(
      `/api/threads/${encodeURIComponent(threadId)}/fork`,
      { method: 'POST', body: fork }
    ),
  forkPreview: (threadId: string, fork: Omit<ThreadForkRequest, 'dryRun' | 'force'>) =>
    request<ForkPreview>(`/api/threads/${encodeURIComponent(threadId)}/fork`, {
      method: 'POST',
      body: { ...fork, dryRun: true },
    }),
  chat: (agent: string, input: string, threadId?: string) =>
    request<{ runId: string; threadId: string }>('/api/chat', {
      method: 'POST',
      body: { agent, input, ...(threadId && { threadId }) },
    }),
  stop: (runId: string) =>
    request<{ stopped: boolean }>(`/api/runs/${encodeURIComponent(runId)}/stop`, {
      method: 'POST',
      body: {},
    }),
  approve: (approvalId: string, approved: boolean, reason?: string, remember?: boolean) =>
    request<{ decided: boolean }>(`/api/approvals/${encodeURIComponent(approvalId)}`, {
      method: 'POST',
      body: { approved, ...(reason && { reason }), ...(remember && { remember: true }) },
    }),
  fork: (runId: string, fork: ForkRequest) =>
    request<{ runId: string }>(`/api/runs/${encodeURIComponent(runId)}/fork`, {
      method: 'POST',
      body: fork,
    }),
  runWorkflow: (key: string, input: unknown) =>
    request<{ runId: string }>(`/api/workflows/${encodeURIComponent(key)}/run`, {
      method: 'POST',
      body: { input },
    }),
  runSwarm: (key: string, input: string) =>
    request<{ runId: string }>(`/api/swarms/${encodeURIComponent(key)}/run`, {
      method: 'POST',
      body: { input },
    }),
  rerun: (runId: string, fromNode: string) =>
    request<{ runId: string }>(`/api/runs/${encodeURIComponent(runId)}/rerun`, {
      method: 'POST',
      body: { fromNode },
    }),
};

/** Server-sent events of the studio, reconnecting after a dropped connection. */
export function subscribe(
  onEvent: (event: StudioEvent) => void,
  onConnection: (open: boolean) => void
): () => void {
  let source: EventSource | undefined;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    source = new EventSource('/api/events', { withCredentials: true });
    source.onopen = () => onConnection(true);
    source.onmessage = (message) => onEvent(JSON.parse(message.data as string) as StudioEvent);
    source.onerror = () => {
      onConnection(false);
      source?.close();
      if (!closed) retry = setTimeout(connect, 1000);
    };
  };
  connect();
  return () => {
    closed = true;
    clearTimeout(retry);
    source?.close();
  };
}
