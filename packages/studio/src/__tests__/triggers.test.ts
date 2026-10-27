import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InboxItem, TriggerFireResult } from '@cogitator-ai/types';
import type {
  ApprovalOutcome,
  InboxChangeRecord,
  InboxItemRecord,
  InboxListing,
  PluginsState,
  RoutineRecord,
  StudioEvent,
  TriggersState,
} from '../protocol.js';
import { StudioHost } from '../host/runner.js';
import { startStudio, type StudioHandle } from '../server/server.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const TRIGGERS_FIXTURE = join(FIXTURES, 'triggers-project');
const PLAIN_FIXTURE = join(FIXTURES, 'project');
const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'studio-triggers-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Polls `check` until it gives a value, failing after `timeoutMs`. */
async function until<T>(
  check: () => Promise<T | undefined>,
  what: string,
  timeoutMs = 10_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function routineOf(state: TriggersState, id: string): RoutineRecord {
  const routine = state.routines.find((candidate) => candidate.id === id);
  if (!routine)
    throw new Error(`no routine ${id} in ${state.routines.map((r) => r.id).join(', ')}`);
  return routine;
}

describe('studio host triggers', () => {
  it('answers a workflow routine through its approval id and reports inbox changes', async () => {
    const changes: Array<{ change: InboxChangeRecord; unread: number }> = [];
    const host = await StudioHost.create(
      TRIGGERS_FIXTURE,
      scratch(),
      () => undefined,
      () => undefined,
      (change, unread) => changes.push({ change, unread })
    );
    try {
      const state = (await host.handle({
        type: 'triggers.state',
        requestId: 'r1',
      })) as TriggersState;
      expect(state).toMatchObject({ configured: true, started: false, history: [] });
      expect(routineOf(state, 'review').target).toEqual({ kind: 'workflow', name: 'review' });

      const fired = (await host.handle({
        type: 'triggers.fire',
        requestId: 'r2',
        trigger: 'review.api',
      })) as TriggerFireResult;
      expect(fired.status).toBe('started');
      const waiting = await until(async () => {
        const listing = (await host.handle({
          type: 'inbox.list',
          requestId: 'r3',
          query: { kind: ['approval'] },
        })) as InboxListing;
        return listing.items[0];
      }, 'the review approval');
      expect(waiting).toMatchObject({ routineId: 'review', status: 'unread' });
      expect(waiting.threadId).toBeUndefined();

      const outcome = (await host.handle({
        type: 'inbox.approve',
        requestId: 'r4',
        approvalId: waiting.approvalId!,
        approved: true,
      })) as ApprovalOutcome;
      expect(outcome).toMatchObject({ decided: true, inboxItemId: waiting.id });

      const listing = (await host.handle({
        type: 'inbox.list',
        requestId: 'r5',
        query: {},
      })) as InboxListing;
      expect(listing.items.find((item) => item.id === waiting.id)?.status).toBe('archived');
      expect(listing.items.find((item) => item.title === 'Review answered')?.summary).toBe(
        `${waiting.approvalId}: true`
      );
      expect(changes[0]).toMatchObject({ change: { type: 'added' }, unread: 1 });
      expect(changes.some(({ change }) => change.type === 'updated')).toBe(true);

      expect(
        await host.handle({
          type: 'inbox.approve',
          requestId: 'r6',
          approvalId: 'nobody-asked',
          approved: true,
        })
      ).toEqual({ decided: false });
    } finally {
      await host.close();
    }
  });

  it('lists the routines plugins contribute in their contributions', async () => {
    const host = await StudioHost.create(join(FIXTURES, 'plugins-project'), scratch(), () => {});
    try {
      const state = (await host.handle({ type: 'plugins.list', requestId: 'r1' })) as PluginsState;
      for (const plugin of state.plugins) expect(plugin.contributions.routines).toEqual([]);
    } finally {
      await host.close();
    }
  });
});

describe('studio server triggers', () => {
  let studio: StudioHandle;
  let base: string;

  async function call(
    path: string,
    init: { method?: string; body?: unknown } = {}
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: init.body !== undefined ? { 'content-type': 'application/json' } : {},
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  async function ok<T>(path: string, body?: unknown): Promise<T> {
    const { status, json } = await call(path, { ...(body !== undefined && { body }) });
    if (status !== 200) throw new Error(`${path}: ${status} ${String(json.error)}`);
    return json as T;
  }

  const inbox = (query = '') => ok<InboxListing>(`/api/inbox${query}`);

  /** The newest item of a routine that `match` takes, once it is there. */
  function itemOf(
    routineId: string,
    match: (item: InboxItemRecord) => boolean
  ): Promise<InboxItemRecord> {
    return until(
      async () =>
        (await inbox('?status=all')).items.find(
          (item) => item.routineId === routineId && match(item)
        ),
      `an inbox item of ${routineId}`
    );
  }

  beforeAll(async () => {
    studio = await startStudio({
      projectDir: TRIGGERS_FIXTURE,
      studioDir: scratch(),
      port: 0,
      watch: false,
      price: () => 0,
    });
    base = studio.url.replace(/\/$/, '').replace('localhost', '127.0.0.1');
    await studio.ready();
  }, 60_000);

  afterAll(async () => {
    await studio?.close();
  });

  it('shows the routines and schedules before and after the triggers start', async () => {
    const before = await ok<TriggersState>('/api/schedules');
    expect(before).toMatchObject({ configured: true, started: false, history: [] });
    expect(before.routines.map((routine) => routine.id)).toEqual([
      'digest',
      'planner',
      'release',
      'review',
    ]);
    const digest = routineOf(before, 'digest');
    expect(digest).toMatchObject({
      name: 'Daily digest',
      target: { kind: 'agent', name: 'assistant' },
      enabled: true,
      overlap: 'skip',
      session: 'new',
      origin: 'code',
      active: 0,
      queued: 0,
    });
    expect(digest.triggers.map((trigger) => [trigger.id, trigger.kind])).toEqual([
      ['digest.morning', 'cron'],
      ['digest.api', 'api'],
    ]);
    expect(JSON.stringify(digest.triggers)).not.toContain('fixture-token');
    expect(digest.triggers[0].nextFireAt).toBeUndefined();
    expect(before.schedules.map((entry) => entry.owner)).toEqual([
      {
        kind: 'agent',
        agent: 'assistant',
        description: 'Remind about the report',
        threadId: 'reminders',
      },
    ]);

    const after = await ok<TriggersState>('/api/schedules/start', {});
    expect(after.started).toBe(true);
    const morning = routineOf(after, 'digest').triggers[0];
    expect(morning.scheduleId).toEqual(expect.any(String));
    expect(morning.nextFireAt).toBeGreaterThan(Date.now());
    expect(morning.spec).toMatchObject({ cron: '0 9 * * *', timezone: 'UTC' });
    expect(after.schedules.find((entry) => entry.id === morning.scheduleId)).toMatchObject({
      type: 'cron',
      enabled: true,
      owner: { kind: 'routine', routineId: 'digest', triggerId: 'morning' },
    });
  });

  it('runs a schedule now, its result reaches the inbox and is read and archived', async () => {
    const state = await ok<TriggersState>('/api/schedules');
    const scheduleId = routineOf(state, 'digest').triggers[0].scheduleId!;
    await ok<TriggersState>(`/api/schedules/${scheduleId}/run`, {});
    const result = await itemOf('digest', (item) => item.source === 'cron');
    expect(result).toMatchObject({ kind: 'result', status: 'unread', title: 'Daily digest' });
    expect(result.summary).toContain('Summarize the news.');
    expect(result.links).toBeUndefined();

    const history = await until(async () => {
      const records = (await ok<TriggersState>('/api/schedules')).history;
      return records.find((record) => record.source === 'cron' && record.status === 'completed');
    }, 'the completed firing in the history');
    expect(history).toMatchObject({ routineId: 'digest', triggerId: 'digest.morning' });

    const read = await ok<InboxItem>(`/api/inbox/${result.id}/read`, {});
    expect(read.status).toBe('read');
    expect((await inbox('?status=unread')).items.some((item) => item.id === result.id)).toBe(false);
    expect((await ok<InboxItem>(`/api/inbox/${result.id}/unread`, {})).status).toBe('unread');
    expect((await ok<InboxItem>(`/api/inbox/${result.id}/archive`, {})).status).toBe('archived');
    expect((await inbox()).items.some((item) => item.id === result.id)).toBe(false);
    expect((await inbox('?status=archived')).items.map((item) => item.id)).toContain(result.id);
    expect((await call('/api/inbox/inbox_nope/read', { body: {} })).status).toBe(404);
    expect((await call('/api/inbox?status=lost')).status).toBe(400);
    expect((await call('/api/inbox?kind=result,mail')).status).toBe(400);
  });

  it('pauses and resumes a routine trigger and a task an agent gave itself', async () => {
    const state = await ok<TriggersState>('/api/schedules');
    const scheduleId = routineOf(state, 'digest').triggers[0].scheduleId!;
    const task = state.schedules.find((entry) => entry.owner.kind === 'agent')!;

    const paused = await ok<TriggersState>(`/api/schedules/${scheduleId}/pause`, {});
    expect(routineOf(paused, 'digest').triggers[0].enabled).toBe(false);
    expect(paused.schedules.find((entry) => entry.id === scheduleId)?.enabled).toBe(false);
    expect((await call(`/api/schedules/${scheduleId}/run`, { body: {} })).status).toBe(409);
    const resumed = await ok<TriggersState>(`/api/schedules/${scheduleId}/resume`, {});
    expect(routineOf(resumed, 'digest').triggers[0].enabled).toBe(true);
    expect(resumed.schedules.find((entry) => entry.id === scheduleId)?.enabled).toBe(true);

    const apiPaused = await ok<TriggersState>('/api/schedules/digest.api/pause', {});
    expect(routineOf(apiPaused, 'digest').triggers[1].enabled).toBe(false);
    expect((await call('/api/triggers/digest.api/fire', { body: {} })).status).toBe(200);
    await ok<TriggersState>('/api/schedules/digest.api/resume', {});

    const taskPaused = await ok<TriggersState>(`/api/schedules/${task.id}/pause`, {});
    expect(taskPaused.schedules.find((entry) => entry.id === task.id)?.enabled).toBe(false);
    const taskResumed = await ok<TriggersState>(`/api/schedules/${task.id}/resume`, {});
    expect(taskResumed.schedules.find((entry) => entry.id === task.id)?.enabled).toBe(true);

    expect((await call('/api/schedules/timer_nope/pause', { body: {} })).status).toBe(404);
    expect((await call('/api/schedules/timer_nope/run', { body: {} })).status).toBe(404);
  });

  it('answers a routine approval through POST /api/approvals/:id', async () => {
    const fired = await ok<TriggerFireResult>('/api/triggers/release.api/fire', {});
    expect(fired).toMatchObject({ status: 'started', routineId: 'release' });
    const waiting = await itemOf(
      'release',
      (item) => item.kind === 'approval' && item.runId === fired.runId
    );
    expect(waiting.threadId).toEqual(expect.any(String));
    const approvalId = waiting.actions?.find((action) => action.kind === 'approve')?.approvalId;
    expect(approvalId).toEqual(expect.any(String));

    const outcome = await ok<ApprovalOutcome>(`/api/approvals/${approvalId}`, { approved: true });
    expect(outcome).toMatchObject({ decided: true, inboxItemId: waiting.id });
    const result = await itemOf(
      'release',
      (item) => item.kind === 'result' && item.runId === fired.runId
    );
    expect(result.summary).toContain('published Hello');
    const answered = (await inbox('?status=archived')).items.find((item) => item.id === waiting.id);
    expect(answered?.status).toBe('archived');

    expect(await ok<ApprovalOutcome>('/api/approvals/nobody-asked', { approved: true })).toEqual({
      decided: false,
    });
  });

  it('answers a workflow routine through POST /api/approvals/:id with its decision', async () => {
    const fired = await ok<TriggerFireResult>('/api/triggers/review.api/fire', {});
    const waiting = await itemOf(
      'review',
      (item) => item.kind === 'approval' && item.runId === fired.runId
    );
    const outcome = await ok<ApprovalOutcome>(`/api/approvals/${waiting.approvalId}`, {
      approved: false,
    });
    expect(outcome).toMatchObject({ decided: true, inboxItemId: waiting.id });
    const answered = await itemOf('review', (item) => item.title === 'Review answered');
    expect(answered.summary).toBe(`${waiting.approvalId}: false`);
  });

  it('answers approvals and questions through POST /api/inbox/:id/respond', async () => {
    const fired = await ok<TriggerFireResult>('/api/triggers/release.api/fire', {
      text: 'the weekly post',
    });
    const waiting = await itemOf(
      'release',
      (item) => item.kind === 'approval' && item.runId === fired.runId
    );
    const approvalId = waiting.actions!.find((action) => action.kind === 'reject')!.approvalId!;
    expect(
      (await call(`/api/inbox/${waiting.id}/respond`, { body: {} })).status,
      'an answer without decisions or responses'
    ).toBe(400);
    const responded = await ok<TriggerFireResult>(`/api/inbox/${waiting.id}/respond`, {
      decisions: { [approvalId]: { approved: false, reason: 'not this week' } },
    });
    expect(responded).toMatchObject({ status: 'started', runId: fired.runId });
    const result = await itemOf(
      'release',
      (item) => item.kind === 'result' && item.runId === fired.runId
    );
    expect(result.summary).toContain('not this week');

    const asked = await ok<TriggerFireResult>('/api/triggers/planner.api/fire', {});
    const question = await itemOf(
      'planner',
      (item) => item.kind === 'question' && item.runId === asked.runId
    );
    const interrupts = question.metadata?.interrupts as Array<{ id: string; message: string }>;
    expect(interrupts[0].message).toBe('Go ahead with the move?');
    await ok<TriggerFireResult>(`/api/inbox/${question.id}/respond`, {
      responses: { [interrupts[0].id]: { ok: true } },
    });
    const done = await itemOf(
      'planner',
      (item) => item.kind === 'result' && item.runId === asked.runId
    );
    expect(done.summary).toContain('going ahead with the move');

    expect((await call('/api/inbox/inbox_nope/respond', { body: { decision: true } })).status).toBe(
      404
    );
    expect((await call('/api/triggers/nope.api/fire', { body: {} })).status).toBe(404);
  });

  it('pushes a new inbox item over the event stream', async () => {
    const events: StudioEvent[] = [];
    const controller = new AbortController();
    const stream = fetch(`${base}/api/events`, { signal: controller.signal })
      .then(async (response) => {
        const reader = response.body!.getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += new TextDecoder().decode(value);
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)) as StudioEvent);
          }
        }
      })
      .catch(() => undefined);
    await until(async () => (events.length > 0 ? true : undefined), 'the event stream');

    const fired = await ok<TriggerFireResult>('/api/triggers/digest.api/fire', {});
    const pushed = await until(
      async () =>
        events.find(
          (event) =>
            event.type === 'inbox' &&
            event.change.type === 'added' &&
            event.change.item.runId === fired.runId
        ),
      'the inbox event'
    );
    controller.abort();
    await stream;
    expect(pushed.type === 'inbox' && pushed.unread).toBeGreaterThan(0);
  });

  it('stops the triggers', async () => {
    const stopped = await ok<TriggersState>('/api/schedules/stop', {});
    expect(stopped.started).toBe(false);
    const state = await ok<TriggersState>('/api/schedules');
    const scheduleId = routineOf(state, 'digest').triggers[0].scheduleId!;
    expect((await call(`/api/schedules/${scheduleId}/run`, { body: {} })).status).toBe(409);
    expect((await call('/api/schedules/restart', { body: {} })).status).toBe(404);
  });
});

describe('studio server without triggers', () => {
  let studio: StudioHandle;
  let base: string;

  beforeAll(async () => {
    studio = await startStudio({
      projectDir: PLAIN_FIXTURE,
      studioDir: scratch(),
      port: 0,
      watch: false,
      price: () => 0,
    });
    base = studio.url.replace(/\/$/, '').replace('localhost', '127.0.0.1');
    await studio.ready();
  }, 60_000);

  afterAll(async () => {
    await studio?.close();
  });

  async function post(path: string, body: unknown = {}): Promise<number> {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.status;
  }

  it('answers reads with an empty state and changes with 409', async () => {
    const schedules = (await (await fetch(`${base}/api/schedules`)).json()) as TriggersState;
    expect(schedules).toEqual({
      configured: false,
      started: false,
      routines: [],
      schedules: [],
      history: [],
    });
    const listing = (await (await fetch(`${base}/api/inbox`)).json()) as InboxListing;
    expect(listing).toEqual({ configured: false, items: [], unread: 0 });

    expect(await post('/api/schedules/start')).toBe(409);
    expect(await post('/api/schedules/timer_1/run')).toBe(409);
    expect(await post('/api/schedules/timer_1/pause')).toBe(409);
    expect(await post('/api/triggers/digest.api/fire')).toBe(409);
    expect(await post('/api/inbox/inbox_1/read')).toBe(409);
    expect(await post('/api/inbox/inbox_1/respond', { decision: true })).toBe(409);

    const approval = await fetch(`${base}/api/approvals/nobody-asked`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });
    expect(approval.status).toBe(200);
    expect(await approval.json()).toEqual({ decided: false });
  });
});
