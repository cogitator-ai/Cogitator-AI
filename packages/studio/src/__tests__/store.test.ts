import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostEvent, RawSpan, RunRecord } from '../protocol.js';
import { reloadsProject } from '../server/host-manager.js';
import { StudioStore } from '../server/store.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store(price: (model: string) => number | null = () => 0.5): {
  store: StudioStore;
  dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'cogitator-studio-store-'));
  dirs.push(dir);
  return { store: new StudioStore(dir, (model) => price(model)), dir };
}

function started(
  runId: string,
  rootRunId: string,
  startedAt: number,
  target = 'assistant'
): HostEvent {
  return {
    type: 'run.started',
    runId,
    kind: 'agent',
    target,
    agentName: target,
    input: 'go',
    rootRunId,
    startedAt,
    model: 'openai/gpt-x',
  };
}

function toolSpan(id: string, callId: string, start: number, end: number): RawSpan {
  return {
    id,
    traceId: 't',
    name: 'tool.delegate',
    status: 'ok',
    startTime: start,
    endTime: end,
    duration: end - start,
    attributes: { 'tool.name': 'delegate', 'tool.call_id': callId },
  };
}

const done = (runId: string, endedAt: number): HostEvent => ({
  type: 'run.completed',
  runId,
  output: 'ok',
  usage: { inputTokens: 1, outputTokens: 1, cost: 0, duration: 1 },
  endedAt,
});

describe('StudioStore', () => {
  it('puts a nested run under the tightest tool call that was open when it started', () => {
    const { store: s } = store();
    s.apply(started('root', 'root', 0));
    s.apply(started('a', 'root', 15, 'researcher'));
    s.apply(started('b', 'root', 40, 'writer'));
    s.apply(started('c', 'root', 18, 'checker'));
    s.apply({ type: 'run.span', runId: 'a', span: toolSpan('sa', 'call_a1', 16, 30) });
    s.apply(done('c', 25));
    s.apply(done('a', 31));
    s.apply(done('b', 50));
    s.apply({ type: 'run.span', runId: 'root', span: toolSpan('s1', 'call_1', 10, 32) });
    s.apply({ type: 'run.span', runId: 'root', span: toolSpan('s2', 'call_2', 35, 55) });
    s.apply(done('root', 60));

    expect(s.getRun('root')?.children).toEqual(['a', 'b']);
    expect(s.getRun('a')).toMatchObject({
      parentRunId: 'root',
      parentToolCallId: 'call_1',
      children: ['c'],
    });
    expect(s.getRun('c')).toMatchObject({ parentRunId: 'a', parentToolCallId: 'call_a1' });
    expect(s.getRun('b')).toMatchObject({ parentRunId: 'root', parentToolCallId: 'call_2' });
    expect(s.getRunTree('root')?.descendants.map((run) => run.id)).toEqual(['a', 'c', 'b']);
    expect(s.listRuns().map((run) => run.id)).toEqual(['root']);
  });

  it('prices model calls at the provider of the run model', () => {
    const priced: string[] = [];
    const { store: s } = store((model) => {
      priced.push(model);
      return 0.25;
    });
    s.apply(started('r', 'r', 0));
    s.apply({
      type: 'run.span',
      runId: 'r',
      span: {
        id: 'l',
        traceId: 't',
        name: 'llm.chat',
        status: 'ok',
        startTime: 1,
        endTime: 2,
        duration: 1,
        attributes: { 'llm.model': 'gpt-x', 'llm.input_tokens': 100, 'llm.output_tokens': 20 },
      },
    });
    s.apply(done('r', 3));
    expect(priced).toEqual(['openai/gpt-x']);
    expect(s.getRun('r')?.spans[0]).toMatchObject({
      kind: 'llm',
      model: 'openai/gpt-x',
      cost: 0.25,
    });
    expect(s.getRun('r')?.usage).toMatchObject({ cost: 0.25, priced: true });
  });

  it('shows a decision model call as a model call, priced at the run provider', () => {
    const { store: s } = store((model) =>
      model === 'openrouter/typesafe/jev-1.13' ? 0.042 : null
    );
    s.apply({ ...started('d', 'd', 1), model: 'openrouter/typesafe/jev-1.13' });
    s.apply({
      type: 'run.span',
      runId: 'd',
      span: {
        id: 'sp',
        traceId: 't',
        name: 'llm.decide',
        status: 'ok',
        startTime: 1,
        endTime: 2,
        duration: 1,
        attributes: {
          'llm.model': 'typesafe/jev-1.13',
          'llm.input_tokens': 1000,
          'llm.output_tokens': 0,
        },
      },
    });
    expect(s.getRun('d')?.spans[0]).toMatchObject({ kind: 'llm', inputTokens: 1000 });
  });

  it('marks runs a stopped studio left running as failed when it loads again', () => {
    const { store: first, dir } = store();
    first.apply(started('r', 'r', 0));
    const again = new StudioStore(dir, () => null);
    expect(again.getRun('r')).toMatchObject({
      status: 'failed',
      error: 'Cogitator Studio stopped during the run',
    });
  });

  it('fails the runs of a host that went away and their pending approvals', () => {
    const { store: s } = store();
    s.apply(started('r', 'r', 0));
    s.apply({
      type: 'run.approval',
      runId: 'r',
      approvalId: 'r:c',
      callId: 'c',
      toolName: 'publish',
      arguments: {},
      description: '',
    });
    const changed = s.abandonRunning('The project reloaded');
    expect(changed.map((run) => run.id)).toEqual(['r']);
    expect(s.getRun('r')?.toolCalls[0].approval).toMatchObject({
      status: 'rejected',
      reason: 'The project reloaded',
    });
  });

  it('replays only finished turns of a thread', () => {
    const { store: s } = store();
    s.touchThread('t', 'assistant', 'hi');
    s.apply({ ...started('r1', 'r1', 0), threadId: 't' } as HostEvent);
    s.addRunToThread('t', 'r1');
    s.apply(done('r1', 1));
    s.apply({ ...started('r2', 'r2', 2), threadId: 't' } as HostEvent);
    s.addRunToThread('t', 'r2');
    expect(s.history('t')).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'ok' },
    ]);
    expect(() => s.touchThread('t', 'writer', 'x')).toThrow('belongs to the agent "assistant"');
  });
});

describe('StudioStore revisions', () => {
  it('give every change of a run a higher revision, streamed text included', () => {
    const { store: s } = store();
    const seen: number[] = [];
    const record = (runId: string) => seen.push(s.getRun(runId)?.revision ?? -1);
    s.apply(started('r1', 'r1', 1));
    record('r1');
    const token = s.apply({ type: 'run.token', runId: 'r1', text: 'Hel' }).token;
    expect(token?.revision).toBe(s.getRun('r1')?.revision);
    record('r1');
    s.apply({ type: 'run.reasoning', runId: 'r1', text: 'thinking' });
    record('r1');
    s.apply(done('r1', 2));
    record('r1');
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('write a run with the revision its last change took', () => {
    const { store: s, dir } = store();
    s.apply(started('r1', 'r1', 1));
    s.apply(done('r1', 2));
    const saved = JSON.parse(readFileSync(join(dir, 'runs', 'r1.json'), 'utf-8')) as RunRecord;
    expect(saved.revision).toBe(s.getRun('r1')?.revision);
  });

  it('go on above what a page saw before a restart, for a run the restart failed', () => {
    const { store: first, dir } = store();
    first.apply(started('r1', 'r1', 1));
    let seen = 0;
    for (let i = 0; i < 50; i++) {
      seen = first.apply({ type: 'run.token', runId: 'r1', text: 'x' }).token?.revision ?? 0;
    }
    vi.useFakeTimers({ now: Date.now() + 2_000 });
    try {
      const reloaded = new StudioStore(dir, () => 0.5).getRun('r1');
      expect(reloaded?.status).toBe('failed');
      expect(reloaded?.revision).toBeGreaterThan(seen);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('StudioStore.stats', () => {
  const HOUR = 3_600_000;

  function finish(s: StudioStore, runId: string, endedAt: number, cost: number): void {
    s.apply({
      type: 'run.completed',
      runId,
      output: 'ok',
      usage: { inputTokens: 10, outputTokens: 5, cost, duration: 1, priced: true },
      endedAt,
    });
  }

  it('counts the runs started from the studio and spends every run, nested ones included', () => {
    const { store: s } = store();
    const now = new Date(2026, 9, 7, 15).getTime();
    s.apply(started('a', 'a', now - 2 * HOUR));
    s.apply({
      type: 'run.span',
      runId: 'a',
      span: toolSpan('t', 'call-1', now - 2 * HOUR, now - 2 * HOUR + 50),
    });
    s.apply(started('nested', 'a', now - 2 * HOUR + 10, 'researcher'));
    finish(s, 'nested', now - 2 * HOUR + 40, 0.5);
    finish(s, 'a', now - 2 * HOUR + 100, 1);
    s.apply(started('b', 'b', now - 30 * HOUR));
    s.apply({
      type: 'run.failed',
      runId: 'b',
      error: 'boom',
      endedAt: now - 30 * HOUR + 300,
      stopped: false,
    });
    s.apply(started('old', 'old', now - 40 * 24 * HOUR));
    finish(s, 'old', now - 40 * 24 * HOUR + 200, 0);

    const stats = s.stats(now, 7);
    expect(stats.runs).toBe(3);
    expect(stats.byStatus).toMatchObject({ completed: 2, failed: 1 });
    expect(stats.cost).toBe(1.5);
    expect(stats.priced).toBe(true);
    expect(stats.inputTokens).toBe(30);
    expect(stats.duration).toEqual({ p50: 200, p95: 300 });
    expect(stats.activity).toHaveLength(7);
    expect(stats.activity.at(-1)).toMatchObject({
      day: new Date(2026, 9, 7).getTime(),
      runs: 1,
      failed: 0,
    });
    expect(stats.activity.at(-2)).toMatchObject({ runs: 1, failed: 1 });
    expect(stats.activity.reduce((sum, day) => sum + day.runs, 0)).toBe(2);
    expect(stats.targets).toEqual([
      expect.objectContaining({ target: 'assistant', kind: 'agent', runs: 3, failed: 1, cost: 1 }),
      expect.objectContaining({ target: 'researcher', kind: 'agent', runs: 1, cost: 0.5 }),
    ]);
  });

  it('counts the spend of a workflow once, not again through its agents', () => {
    const { store: s } = store();
    const now = new Date(2026, 9, 7, 15).getTime();
    s.apply({
      type: 'run.started',
      runId: 'w',
      kind: 'workflow',
      target: 'report',
      input: '{}',
      rootRunId: 'w',
      startedAt: now - 1000,
    });
    s.apply(started('a', 'w', now - 900, 'researcher'));
    finish(s, 'a', now - 500, 0.25);
    s.apply(started('b', 'w', now - 400, 'writer'));
    finish(s, 'b', now - 100, 0.5);
    s.apply({
      type: 'run.completed',
      runId: 'w',
      output: '{}',
      usage: { inputTokens: 0, outputTokens: 0, cost: 0, duration: 900 },
      endedAt: now,
    });

    expect(s.getRun('w')?.usage?.cost).toBe(0.75);
    const stats = s.stats(now, 1);
    expect(stats.runs).toBe(1);
    expect(stats.cost).toBe(0.75);
    expect(stats.inputTokens).toBe(20);
    expect(stats.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'report', kind: 'workflow', cost: 0.75 }),
        expect.objectContaining({ target: 'researcher', cost: 0.25 }),
      ])
    );
  });

  it('has no latency before a run finished', () => {
    const { store: s } = store();
    s.apply(started('r', 'r', Date.now()));
    expect(s.stats().duration).toBeNull();
    expect(s.stats().byStatus.running).toBe(1);
  });
});

describe('reloadsProject', () => {
  it('reloads on source and config changes, not on data and dependencies', () => {
    expect(reloadsProject('src/agents/assistant.ts')).toBe(true);
    expect(reloadsProject('cogitator.yml')).toBe(true);
    expect(reloadsProject('.env')).toBe(true);
    expect(reloadsProject('node_modules/x/index.js')).toBe(false);
    expect(reloadsProject('.cogitator/studio/runs/r.json')).toBe(false);
    expect(reloadsProject('data/memory.db')).toBe(false);
    expect(reloadsProject('README.md')).toBe(false);
  });
});
