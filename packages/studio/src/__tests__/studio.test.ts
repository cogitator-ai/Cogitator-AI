import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { startStudio, type StudioHandle } from '../server/server.js';
import type { HostStatus, RunRecord, StudioEvent, StudioStats, ThreadRecord } from '../protocol.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'project');
const SCRATCH = join(HERE, '.scratch');
const PRICE = 0.002;

let studio: StudioHandle;
let base: string;
const studioDir = mkdtempSync(join(tmpdir(), 'cogitator-studio-'));
const output: string[] = [];

async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined && { 'content-type': 'application/json' }),
      ...init.headers,
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
  const json = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(`${response.status} ${json.error ?? ''}`);
  return json;
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function run(
  id: string
): Promise<{ run: RunRecord; descendants: RunRecord[]; forks: RunRecord[] }> {
  return api(`/api/runs/${id}`);
}

function settled(id: string, statuses: RunRecord['status'][] = ['completed', 'failed', 'stopped']) {
  return waitFor(async () => {
    const tree = await run(id);
    return statuses.includes(tree.run.status) ? tree : undefined;
  });
}

async function chat(
  input: string,
  threadId?: string
): Promise<{ runId: string; threadId: string }> {
  return api('/api/chat', {
    method: 'POST',
    body: { agent: 'assistant', input, ...(threadId && { threadId }) },
  });
}

beforeAll(async () => {
  studio = await startStudio({
    projectDir: FIXTURE,
    studioDir,
    port: 0,
    watch: false,
    price: () => PRICE,
    log: (line) => output.push(line),
  });
  base = studio.url.replace(/\/$/, '').replace('localhost', '127.0.0.1');
  await studio.ready();
}, 60_000);

afterAll(async () => {
  await studio?.close();
  rmSync(studioDir, { recursive: true, force: true });
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe('loading the project', () => {
  it('finds the agents and workflows of the registry and relays the project output', async () => {
    const state = await api<{ host: HostStatus; project: string }>('/api/state');
    expect(state.host.state).toBe('ready');
    if (state.host.state !== 'ready') return;
    expect(state.host.registry.agents.map((agent) => agent.key)).toEqual([
      'assistant',
      'researcher',
    ]);
    expect(state.host.registry.defaultModel).toBe('scripted/test-model');
    expect(
      state.host.registry.agents[0].tools.map((tool) => [tool.name, tool.requiresApproval])
    ).toEqual([
      ['lookup_weather', false],
      ['publish', true],
      ['researcher', false],
    ]);
    expect(state.host.registry.workflows).toEqual([
      expect.objectContaining({
        key: 'report',
        nodes: ['draft', 'review'],
        initialState: { topic: 'tides' },
      }),
    ]);
    expect(state.host.memory).toBe('studio');
    expect(output).toContain('the fixture registry loads');
  });
});

describe('chat', () => {
  it('streams tokens and reasoning and records the run with its trace and cost', async () => {
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

    const { runId, threadId } = await chat('hello there');
    const { run: record } = await settled(runId);
    controller.abort();
    await stream;

    expect(record.status).toBe('completed');
    expect(record.output).toBe('Echo: hello there (turn 1)');
    expect(record.reasoning).toBe('Thinking about it');
    expect(record.threadId).toBe(threadId);
    const tokens = events.filter((event) => event.type === 'token' && event.runId === runId);
    expect(tokens.map((event) => (event.type === 'token' ? event.text : '')).join('')).toBe(
      record.output
    );
    expect(events.some((event) => event.type === 'reasoning' && event.runId === runId)).toBe(true);

    const llm = record.spans.filter((span) => span.kind === 'llm');
    expect(llm).toHaveLength(1);
    expect(llm[0]).toMatchObject({
      model: 'scripted/test-model',
      inputTokens: 10,
      outputTokens: 5,
      cost: PRICE,
    });
    expect(record.spans.some((span) => span.kind === 'agent')).toBe(true);
    expect(record.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(record.steps).toEqual([expect.objectContaining({ index: 0, label: 'from the start' })]);

    const thread = await api<{ thread: ThreadRecord; runs: RunRecord[] }>(
      `/api/threads/${threadId}`
    );
    expect(thread.thread).toMatchObject({
      agent: 'assistant',
      title: 'hello there',
      runs: [runId],
    });
  });

  it('keeps the conversation of a thread', async () => {
    const first = await chat('one');
    await settled(first.runId);
    const second = await chat('two', first.threadId);
    const { run: record } = await settled(second.runId);
    expect(record.output).toBe('Echo: two (turn 2)');
  });

  it('shows tool calls with their arguments and results', async () => {
    const { runId } = await chat('what is the weather');
    const { run: record } = await settled(runId);
    expect(record.output).toBe('Done: sunny in Lisbon');
    expect(record.toolCalls).toEqual([
      expect.objectContaining({
        name: 'lookup_weather',
        arguments: { city: 'Lisbon' },
        result: 'sunny in Lisbon',
      }),
    ]);
    expect(record.spans.filter((span) => span.kind === 'tool').map((span) => span.name)).toEqual([
      'tool.lookup_weather',
    ]);
    expect(record.spans.filter((span) => span.kind === 'llm')).toHaveLength(2);
    expect(record.steps?.map((step) => step.label)).toEqual(['before lookup_weather']);
  });
});

describe('approvals', () => {
  it('pause the run until the studio approves the call', async () => {
    const { runId } = await chat('please publish');
    const waiting = await settled(runId, ['waiting']);
    const call = waiting.run.toolCalls.find((candidate) => candidate.name === 'publish');
    expect(call?.approval?.status).toBe('waiting');
    expect(call?.arguments).toEqual({ title: 'Hello' });

    await api(`/api/approvals/${encodeURIComponent(call!.approval!.id)}`, {
      method: 'POST',
      body: { approved: true },
    });
    const { run: record } = await settled(runId);
    expect(record.status).toBe('completed');
    expect(record.output).toBe('Done: published Hello');
    expect(record.toolCalls[0].approval?.status).toBe('approved');
  });

  it('tell the model why a call was rejected', async () => {
    const { runId } = await chat('publish it');
    const waiting = await settled(runId, ['waiting']);
    const approval = waiting.run.toolCalls[0].approval!;
    await api(`/api/approvals/${encodeURIComponent(approval.id)}`, {
      method: 'POST',
      body: { approved: false, reason: 'not today' },
    });
    const { run: record } = await settled(runId);
    expect(record.toolCalls[0].approval).toMatchObject({ status: 'rejected', reason: 'not today' });
    expect(record.output).toContain('not today');
  });

  it('end when the run is stopped', async () => {
    const { runId } = await chat('publish now');
    await settled(runId, ['waiting']);
    await api(`/api/runs/${runId}/stop`, { method: 'POST', body: {} });
    const { run: record } = await settled(runId);
    expect(record.status).toBe('stopped');
    expect(record.toolCalls[0].approval?.status).toBe('rejected');
  });
});

describe('nested agents', () => {
  it('put the run an agent tool started under its tool call', async () => {
    const { runId } = await chat('do some research');
    const tree = await settled(runId);
    expect(tree.run.output).toContain('Done:');
    expect(tree.run.children).toHaveLength(1);
    const child = tree.descendants[0];
    expect(child).toMatchObject({ target: 'researcher', parentRunId: runId, status: 'completed' });
    expect(child.parentToolCallId).toBe(tree.run.toolCalls[0].id);
    expect(child.spans.some((span) => span.kind === 'llm')).toBe(true);

    const list = await api<{ runs: RunRecord[] }>('/api/runs?target=researcher');
    expect(list.runs).toEqual([]);
  });
});

describe('time-travel forks', () => {
  it('run again from a step with a changed tool result, next to the original', async () => {
    const { runId } = await chat('weather again');
    const { run: original } = await settled(runId);
    const fork = await api<{ runId: string }>(`/api/runs/${runId}/fork`, {
      method: 'POST',
      body: { step: 0, toolResults: { lookup_weather: 'snowing in Lisbon' } },
    });
    const { run: forked } = await settled(fork.runId);

    expect(forked.kind).toBe('fork');
    expect(forked.forkOf).toEqual({
      runId,
      step: 0,
      toolResults: { lookup_weather: 'snowing in Lisbon' },
    });
    expect(forked.output).toBe('Done: snowing in Lisbon');
    expect(forked.toolCalls).toEqual([
      expect.objectContaining({ name: 'lookup_weather', result: 'snowing in Lisbon' }),
    ]);
    expect(forked.usage?.priced).toBe(true);
    expect(original.output).toBe('Done: sunny in Lisbon');
    const tree = await run(runId);
    expect(tree.forks.map((candidate) => candidate.id)).toEqual([fork.runId]);
  });

  it('refuse a step the run does not have', async () => {
    const { runId } = await chat('weather once more');
    await settled(runId);
    await expect(
      api(`/api/runs/${runId}/fork`, { method: 'POST', body: { step: 7 } })
    ).rejects.toThrow('no step 7');
  });
});

describe('workflows', () => {
  it('run with live node statuses and rerun from a node', async () => {
    const started = await api<{ runId: string }>('/api/workflows/report/run', {
      method: 'POST',
      body: { input: { topic: 'whales' } },
    });
    const tree = await settled(started.runId);
    expect(tree.run.status).toBe('completed');
    expect(tree.run.nodes?.map((node) => [node.name, node.status])).toEqual([
      ['draft', 'completed'],
      ['review', 'completed'],
    ]);
    expect(JSON.parse(tree.run.output ?? '{}')).toMatchObject({
      topic: 'whales',
      draft: 'Draft about whales',
    });
    expect(tree.descendants.map((child) => child.target)).toEqual(['researcher']);
    expect(tree.run.usage?.inputTokens).toBe(10);
    expect(tree.run.workflowRunId).toBeTruthy();

    const rerun = await api<{ runId: string }>(`/api/runs/${started.runId}/rerun`, {
      method: 'POST',
      body: { fromNode: 'review' },
    });
    const again = await settled(rerun.runId);
    expect(again.run.rerunOf).toEqual({ runId: started.runId, fromNode: 'review' });
    expect(again.run.nodes?.map((node) => [node.name, node.status])).toEqual([
      ['draft', 'skipped'],
      ['review', 'completed'],
    ]);
  });
});

describe('history', () => {
  it('is searchable and filtered by agent', async () => {
    const found = await api<{ runs: RunRecord[] }>('/api/runs?q=weather%20again');
    expect(found.runs.map((candidate) => [candidate.kind, candidate.input])).toEqual([
      ['fork', 'weather again'],
      ['agent', 'weather again'],
    ]);
    const forks = await api<{ runs: RunRecord[] }>('/api/runs?kind=fork');
    expect(forks.runs.every((candidate) => candidate.kind === 'fork')).toBe(true);
    const workflows = await api<{ runs: RunRecord[] }>('/api/runs?target=report');
    expect(workflows.runs.length).toBeGreaterThanOrEqual(2);
  });

  it('sums up every run for the overview', async () => {
    const { runs } = await api<{ runs: RunRecord[] }>('/api/runs?limit=1000');
    const stats = await api<StudioStats>('/api/stats');
    expect(stats.runs).toBe(runs.length);
    expect(Object.values(stats.byStatus).reduce((sum, count) => sum + count, 0)).toBe(runs.length);
    expect(stats.activity.at(-1)?.runs).toBe(runs.length);
    expect(stats.cost).toBeGreaterThan(0);
    expect(stats.targets.map((target) => target.target)).toEqual(
      expect.arrayContaining(['assistant', 'report'])
    );
    expect(stats.duration?.p95).toBeGreaterThanOrEqual(stats.duration?.p50 ?? Infinity);
  });

  it('survives a restart of the studio, threads included', async () => {
    const before = await api<{ runs: RunRecord[]; threads: ThreadRecord[] }>('/api/state');
    const thread = before.threads.find((candidate) => candidate.title === 'one');
    await studio.close();
    studio = await startStudio({
      projectDir: FIXTURE,
      studioDir,
      port: 0,
      watch: false,
      price: () => PRICE,
    });
    base = studio.url.replace(/\/$/, '').replace('localhost', '127.0.0.1');
    await studio.ready();

    const after = await api<{ runs: RunRecord[]; threads: ThreadRecord[] }>('/api/state');
    expect(after.runs.map((candidate) => candidate.id)).toEqual(
      before.runs.map((candidate) => candidate.id)
    );
    const continued = await chat('three', thread!.id);
    const { run: record } = await settled(continued.runId);
    expect(record.output).toBe('Echo: three (turn 3)');
  });
});

describe('access', () => {
  it('refuses other host names and cross-site posts on loopback', async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const url = new URL(`${base}/api/state`);
      request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          headers: { host: 'attacker.example' },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        }
      )
        .on('error', reject)
        .end();
    });
    expect(status).toBe(403);
    const crossSite = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
      body: JSON.stringify({ agent: 'assistant', input: 'hi' }),
    });
    expect(crossSite.status).toBe(403);
  });

  it('asks for the token when it listens beyond loopback', async () => {
    const exposed = await startStudio({
      projectDir: FIXTURE,
      studioDir: mkdtempSync(join(tmpdir(), 'cogitator-studio-exposed-')),
      host: '0.0.0.0',
      port: 0,
      watch: false,
      price: () => PRICE,
    });
    try {
      const root = `http://127.0.0.1:${exposed.port}`;
      expect((await fetch(`${root}/api/state`)).status).toBe(401);
      const withToken = await fetch(`${root}/api/state?token=${exposed.token}`);
      expect(withToken.status).toBe(200);
      expect(withToken.headers.get('set-cookie')).toContain('cogitator_studio=');
      expect(exposed.url).toContain(`token=${exposed.token}`);
    } finally {
      await exposed.close();
    }
  });
});

describe('reloading', () => {
  it('loads the changed code without restarting the studio', async () => {
    const project = join(SCRATCH, 'reload');
    mkdirSync(SCRATCH, { recursive: true });
    cpSync(FIXTURE, project, { recursive: true });
    const reloading = await startStudio({
      projectDir: project,
      studioDir: mkdtempSync(join(tmpdir(), 'cogitator-studio-reload-')),
      port: 0,
      price: () => PRICE,
    });
    try {
      await reloading.ready();
      const file = join(project, 'src/cogitator.ts');
      writeFileSync(
        file,
        readFileSync(file, 'utf-8').replace("'The fixture assistant'", "'The reloaded assistant'")
      );
      const status = await waitFor(async () => {
        const current = reloading.hostStatus();
        return current.state === 'ready' &&
          current.registry.agents[0].description === 'The reloaded assistant'
          ? current
          : undefined;
      });
      expect(status.state).toBe('ready');
    } finally {
      await reloading.close();
    }
  });

  it('explains a project without a registry', async () => {
    const empty = join(SCRATCH, 'empty');
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, 'package.json'), '{"type":"module"}');
    const broken = await startStudio({
      projectDir: empty,
      port: 0,
      watch: false,
      price: () => PRICE,
    });
    try {
      await expect(broken.ready()).rejects.toThrow('src/cogitator.ts not found');
    } finally {
      await broken.close();
    }
  });
});

describe('a run whose fork steps cannot be recorded', () => {
  it('still completes, without steps, and says why', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cogitator-studio-steps-'));
    writeFileSync(join(dir, 'checkpoints'), 'a file where the checkpoints directory goes');
    const lines: string[] = [];
    const broken = await startStudio({
      projectDir: FIXTURE,
      studioDir: dir,
      port: 0,
      watch: false,
      price: () => PRICE,
      log: (line) => lines.push(line),
    });
    try {
      await broken.ready();
      const url = broken.url.replace(/\/$/, '').replace('localhost', '127.0.0.1');
      const response = await fetch(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'assistant', input: 'hello' }),
      });
      const { runId } = (await response.json()) as { runId: string };
      const finished = await waitFor(async () => {
        const tree = (await (await fetch(`${url}/api/runs/${runId}`)).json()) as {
          run: RunRecord;
        };
        return tree.run.status === 'running' ? undefined : tree.run;
      });
      expect(finished.status).toBe('completed');
      expect(finished.steps).toBeUndefined();
      expect(lines.join('\n')).toContain(`could not record the steps of run ${runId}`);
    } finally {
      await broken.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
