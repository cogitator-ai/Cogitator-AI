import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  ChatRequest,
  DurableRunMark,
  DurableRunRecord,
  DurableRunStore,
  MemoryEntry,
  RunMiddleware,
} from '@cogitator-ai/types';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { InMemoryDurableRunStore, ThreadDurableRunStore } from '../cogitator/durable-stores';
import { ABORTED_BEFORE_DISPATCH, OUTCOME_UNKNOWN } from '../utils/tool-history';
import {
  answer,
  callTools,
  deferred,
  scriptedBackend,
  userTexts,
  type ScriptedTurn,
} from './helpers/scripted-backend';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'durable-runs-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A runtime on the SQLite file of the test, as a process that starts on the same database: a pod
 * whose owner is unique to it, so a restart takes its runs back at once
 */
function processOn(turns: ScriptedTurn[], owner = 'host-a', takeoverOnRestart = true) {
  const scripted = scriptedBackend(turns);
  const cog = new Cogitator({
    llm: { backends: { mock: scripted.backend } },
    memory: { adapter: 'sqlite', sqlite: { path: join(dir, 'memory.db') } },
    durable: { owner, takeoverOnRestart },
  });
  return { cog, ...scripted };
}

/** A runtime on a store shared in memory, its leases running out by `clock` */
function processWith(turns: ScriptedTurn[], store: DurableRunStore, owner: string) {
  const scripted = scriptedBackend(turns);
  const cog = new Cogitator({
    llm: { backends: { mock: scripted.backend } },
    durable: { store, owner, takeoverOnRestart: true },
  });
  return { cog, ...scripted };
}

async function entriesOf(cog: Cogitator, threadId: string): Promise<MemoryEntry[]> {
  const memory = await cog.getMemory();
  const entries = await memory!.getEntries({ threadId, includeToolCalls: true, types: 'all' });
  if (!entries.success) throw new Error(entries.error);
  return entries.data;
}

function toolTexts(request: ChatRequest): Record<string, string> {
  return Object.fromEntries(
    request.messages
      .filter((message) => message.role === 'tool')
      .map((message) => [message.toolCallId ?? '', String(message.content)])
  );
}

/** A tool that counts its calls and waits until `release` resolves, when one is given */
function countedTool(name: string, release?: Promise<void>) {
  const started = deferred();
  const calls = vi.fn(async () => {
    started.resolve();
    if (release) await release;
    return `${name} done`;
  });
  return {
    calls,
    started: started.promise,
    tool: tool({
      name,
      description: name,
      parameters: z.object({}),
      execute: calls,
    }),
  };
}

const forever = new Promise<void>(() => undefined);

/** A store that passes every call on to `inner` */
function around(inner: DurableRunStore): DurableRunStore {
  return {
    acquire: (...args) => inner.acquire(...args),
    renew: (...args) => inner.renew(...args),
    release: (...args) => inner.release(...args),
    save: (...args) => inner.save(...args),
    append: (...args) => inner.append(...args),
    load: (...args) => inner.load(...args),
    list: (...args) => inner.list(...args),
    delete: (...args) => inner.delete(...args),
  };
}

describe('durable runs', () => {
  it('recovers a run whose process stopped while a tool ran, without running a finished call again', async () => {
    const charge = countedTool('charge');
    const ship = countedTool('ship', forever);
    const agent = new Agent({
      id: 'clerk',
      name: 'clerk',
      model: 'mock/m',
      instructions: 'Handle the order.',
      tools: [charge.tool, ship.tool],
    });
    const first = processOn([
      callTools([
        { id: 'c1', name: 'charge', arguments: {} },
        { id: 'c2', name: 'ship', arguments: {} },
      ]),
    ]);
    const crashed = first.cog.run(agent, { input: 'Order 42', threadId: 'order-42' });
    crashed.catch(() => undefined);
    await ship.started;
    await first.cog.close();

    const second = processOn([answer('Charged, shipping needs a check')]);
    const kept = await second.cog.durableRuns();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ threadId: 'order-42', agentId: 'clerk', held: false });

    const recovered = await second.cog.recoverRuns({ agents: [agent] });
    expect(recovered.skipped).toEqual([]);
    expect(recovered.resumed).toHaveLength(1);
    const result = await recovered.resumed[0].handle.result;

    expect(result.output).toBe('Charged, shipping needs a check');
    expect(charge.calls).toHaveBeenCalledTimes(1);
    expect(ship.calls).toHaveBeenCalledTimes(1);
    expect(second.requests).toHaveLength(1);
    const answers = toolTexts(second.requests[0]);
    expect(answers.c1).toContain('charge done');
    expect(answers.c2).toContain(OUTCOME_UNKNOWN);
    expect(userTexts(second.requests[0]).at(-1)).toContain('Order 42');

    const results = (await entriesOf(second.cog, 'order-42')).flatMap(
      (entry) => entry.toolResults ?? []
    );
    expect(results.map((entry) => entry.callId).sort()).toEqual(['c1', 'c2']);
    expect(await second.cog.durableRuns()).toEqual([]);
    await second.cog.close();
  });

  it('gives a call that never started after a lost one "aborted before dispatch"', async () => {
    const hang = countedTool('hang', forever);
    const later = countedTool('later');
    const agent = new Agent({
      name: 'worker',
      model: 'mock/m',
      instructions: 'Work.',
      tools: [hang.tool, later.tool],
    });
    const first = processOn([
      callTools([
        { id: 'h', name: 'hang', arguments: {} },
        { id: 'l', name: 'later', arguments: {} },
      ]),
    ]);
    first.cog.run(agent, { input: 'Go', threadId: 'abort-later' }).catch(() => undefined);
    await hang.started;
    await first.cog.close();

    const second = processOn([answer('ok')]);
    const { resumed } = await second.cog.recoverRuns({ agents: [agent] });
    await resumed[0].handle.result;

    const answers = toolTexts(second.requests[0]);
    expect(answers.h).toContain(OUTCOME_UNKNOWN);
    expect(answers.l).toContain(ABORTED_BEFORE_DISPATCH);
    expect(later.calls).not.toHaveBeenCalled();
    await second.cog.close();
  });

  it('runs the calls of a step that had not started when no call was lost', async () => {
    const steps = countedTool('step');
    const agent = new Agent({
      name: 'planner',
      model: 'mock/m',
      instructions: 'Plan.',
      tools: [steps.tool],
    });
    const stuck = deferred();
    const parked: DurableRunStore = new InMemoryDurableRunStore();
    let saves = 0;
    const store: DurableRunStore = {
      ...around(parked),
      save: async (record, holder) => {
        saves++;
        if (saves === 2) {
          stuck.resolve();
          return forever.then(() => false);
        }
        return parked.save(record, holder);
      },
    };
    const scripted = scriptedBackend([callTools([{ id: 's1', name: 'step', arguments: {} }])]);
    const first = new Cogitator({
      llm: { backends: { mock: scripted.backend } },
      memory: { adapter: 'sqlite', sqlite: { path: join(dir, 'memory.db') } },
      durable: { store, owner: 'host-a', takeoverOnRestart: true },
    });
    first.run(agent, { input: 'Plan it', threadId: 'adopt' }).catch(() => undefined);
    await stuck.promise;
    await first.close();

    const resumedScript = scriptedBackend([answer('planned')]);
    const second = new Cogitator({
      llm: { backends: { mock: resumedScript.backend } },
      memory: { adapter: 'sqlite', sqlite: { path: join(dir, 'memory.db') } },
      durable: { store: parked, owner: 'host-a', takeoverOnRestart: true },
    });
    const { resumed } = await second.recoverRuns({ agents: [agent] });
    const result = await resumed[0].handle.result;

    expect(result.output).toBe('planned');
    expect(scripted.requests).toHaveLength(1);
    expect(resumedScript.requests).toHaveLength(1);
    expect(steps.calls).toHaveBeenCalledTimes(1);
    expect(toolTexts(resumedScript.requests[0]).s1).toContain('step done');
    const assistants = (await entriesOf(second, 'adopt')).filter(
      (entry) => entry.message.role === 'assistant'
    );
    expect(assistants).toHaveLength(2);
    await second.close();
  });

  it('ends a run that had answered before its process stopped without asking the model again', async () => {
    const hold: RunMiddleware = { name: 'hold', afterRun: () => forever };
    const agent = new Agent({ name: 'poet', model: 'mock/m', instructions: 'Rhyme.' });
    const scripted = scriptedBackend([answer('Roses are red')]);
    const first = new Cogitator({
      llm: { backends: { mock: scripted.backend } },
      memory: { adapter: 'sqlite', sqlite: { path: join(dir, 'memory.db') } },
      durable: { owner: 'host-a', takeoverOnRestart: true },
      middleware: [hold],
    });
    const done = deferred();
    first
      .run(agent, {
        input: 'A poem',
        threadId: 'poem',
        onModelTurn: () => done.resolve(),
      })
      .catch(() => undefined);
    await done.promise;
    await vi.waitFor(async () => {
      const entries = await entriesOf(first, 'poem');
      expect(entries.some((entry) => entry.message.role === 'assistant')).toBe(true);
    });
    await first.close();

    const second = processOn([answer('never asked')]);
    const { resumed } = await second.cog.recoverRuns({ agents: [agent] });
    const result = await resumed[0].handle.result;

    expect(result.output).toBe('Roses are red');
    expect(second.requests).toHaveLength(0);
    await second.cog.close();
  });

  it('keeps each step small: the base once, logged messages as references', async () => {
    const parked = new InMemoryDurableRunStore();
    const saved: DurableRunRecord[] = [];
    const store: DurableRunStore = {
      ...around(parked),
      save: async (record, holder) => {
        saved.push(structuredClone(record));
        return parked.save(record, holder);
      },
    };
    const lookup = countedTool('lookup');
    const agent = new Agent({
      name: 'reader',
      model: 'mock/m',
      instructions: 'Read.',
      tools: [lookup.tool],
    });
    const scripted = scriptedBackend([
      callTools([{ id: 'k1', name: 'lookup', arguments: {} }]),
      callTools([{ id: 'k2', name: 'lookup', arguments: { again: true } }]),
      answer('read'),
    ]);
    const cog = new Cogitator({
      llm: { backends: { mock: scripted.backend } },
      memory: { adapter: 'memory' },
      durable: { store, owner: 'solo' },
    });

    const result = await cog.run(agent, { input: 'Look it up', threadId: 'small' });

    expect(result.output).toBe('read');
    expect(saved).toHaveLength(7);
    expect(saved[0].base?.length).toBeGreaterThan(0);
    expect(saved.slice(1).every((record) => record.base === undefined)).toBe(true);
    const last = saved.at(-1)!;
    expect(last.checkpoint.status).toBe('running');
    expect(last.checkpoint.messages.some((message) => message.role === 'tool')).toBe(false);
    expect(last.checkpoint.compact?.logged.length).toBe(5);
    expect(last.checkpoint.toolCalls).toEqual([]);
    expect(last.checkpoint.compact?.calls).toEqual([
      { at: expect.any(Number), index: 0 },
      { at: expect.any(Number), index: 0 },
    ]);
    expect(await parked.list()).toEqual([]);
    await cog.close();
  });

  it('adds only the new messages to the base at each step without a memory log', async () => {
    const parked = new InMemoryDurableRunStore();
    const saved: DurableRunRecord[] = [];
    const store: DurableRunStore = {
      ...around(parked),
      save: async (record, holder) => {
        saved.push(structuredClone(record));
        return parked.save(record, holder);
      },
    };
    const lookup = countedTool('lookup');
    const agent = new Agent({
      name: 'plain',
      model: 'mock/m',
      instructions: 'Read.',
      tools: [lookup.tool],
    });
    const scripted = scriptedBackend([
      callTools([{ id: 'k1', name: 'lookup', arguments: {} }]),
      answer('read'),
    ]);
    const cog = new Cogitator({
      llm: { backends: { mock: scripted.backend } },
      durable: { store, owner: 'solo' },
      middleware: [
        {
          name: 'peek',
          beforeModel: async () => {
            const [kept] = await parked.list();
            const record = kept && (await parked.load(kept));
            if (record) expect(record.base?.length).toBe(scripted.requests.length * 2 + 2);
          },
        },
      ],
    });

    await cog.run(agent, { input: 'Look it up' });

    expect(saved[0].baseFrom).toBeUndefined();
    expect(saved.slice(1).map((record) => record.baseFrom)).toEqual([2, 3, 4, undefined]);
    expect(saved.slice(1).map((record) => record.base?.length)).toEqual([1, 1, 1, undefined]);
    expect(saved.at(-2)?.checkpoint.stopping).toBe(true);
    expect(saved.at(-1)?.checkpoint.stopping).toBeUndefined();
    expect(saved.every((record) => record.checkpoint.messages.length === 0)).toBe(true);
  });

  it('delivers the messages queued on a run that its process left undelivered', async () => {
    const wait = countedTool('wait', forever);
    const agent = new Agent({
      name: 'helper',
      model: 'mock/m',
      instructions: 'Help.',
      tools: [wait.tool],
    });
    const first = processOn([callTools([{ id: 'w', name: 'wait', arguments: {} }])]);
    const handle = first.cog.start(agent, { input: 'Start', threadId: 'queued' });
    handle.result.catch(() => undefined);
    await wait.started;
    handle.steer('Use the blue box');
    await vi.waitFor(async () => {
      const [record] = await first.cog.durableRuns({ threadId: 'queued' });
      expect(record).toBeDefined();
      const store = await loadRecord(first.cog, 'queued');
      expect(store?.journal.some((mark: DurableRunMark) => mark.kind === 'queue')).toBe(true);
    });
    await first.cog.close();

    const second = processOn([answer('blue it is')]);
    const { resumed } = await second.cog.recoverRuns({ agents: [agent] });
    const result = await resumed[0].handle.result;

    expect(result.output).toBe('blue it is');
    expect(userTexts(second.requests[0])).toContain('Use the blue box');
    await second.cog.close();
  });

  it('lets one process hold a run: the others wait for its lease to run out', async () => {
    let now = 1_000;
    const store = new InMemoryDurableRunStore({ now: () => now });
    const release = deferred();
    const slow = countedTool('slow', release.promise);
    const agent = new Agent({
      name: 'mover',
      model: 'mock/m',
      instructions: 'Move.',
      tools: [slow.tool],
    });
    const owner = processWith(
      [callTools([{ id: 'm1', name: 'slow', arguments: {} }]), answer('moved twice')],
      store,
      'a'
    );
    const running = owner.cog.run(agent, { input: 'Move it', threadId: 'lease' });
    running.catch(() => undefined);
    await slow.started;

    const rival = processWith([answer('moved')], store, 'b');
    const third = processWith([answer('moved too')], store, 'c');
    expect(await rival.cog.durableRuns()).toEqual([expect.objectContaining({ held: true })]);
    expect((await rival.cog.recoverRuns({ agents: [agent] })).resumed).toEqual([]);
    const [kept] = await rival.cog.durableRuns();
    await expect(rival.cog.recoverRun(agent, kept.runId)).rejects.toMatchObject({
      code: ErrorCode.RUN_LEASED,
    });

    now += 61_000;
    const { resumed } = await rival.cog.recoverRuns({ agents: [agent] });
    expect(resumed).toHaveLength(1);
    await expect(third.cog.recoverRun(agent, kept.runId)).rejects.toMatchObject({
      code: ErrorCode.RUN_LEASED,
    });
    expect((await third.cog.recoverRuns({ agents: [agent] })).resumed).toEqual([]);

    const result = await resumed[0].handle.result;
    expect(result.output).toBe('moved');
    release.resolve();
    await expect(running).rejects.toMatchObject({ code: ErrorCode.RUN_LEASED });
    expect(rival.requests).toHaveLength(1);
    expect(owner.requests).toHaveLength(1);
  });

  it('hands a run over to another process when it is stopped with RUN_SUSPENDED', async () => {
    const wait = countedTool('wait', forever);
    const agent = new Agent({
      name: 'handover',
      model: 'mock/m',
      instructions: 'Wait.',
      tools: [wait.tool],
    });
    const store = new InMemoryDurableRunStore();
    const first = processWith([callTools([{ id: 'x', name: 'wait', arguments: {} }])], store, 'a');
    const controller = new AbortController();
    const run = first.cog.run(agent, {
      input: 'Wait',
      threadId: 'handover',
      signal: controller.signal,
    });
    await wait.started;
    controller.abort(
      new CogitatorError({ message: 'shutting down', code: ErrorCode.RUN_SUSPENDED })
    );
    await expect(run).rejects.toThrow('shutting down');

    const [kept] = await store.list();
    expect(kept?.lease).toBeUndefined();
    const second = processWith([answer('taken over')], store, 'b');
    const { resumed } = await second.cog.recoverRuns({ agents: [agent] });
    const result = await resumed[0].handle.result;
    expect(result.output).toBe('taken over');
    expect(toolTexts(second.requests[0]).x).toContain(OUTCOME_UNKNOWN);
  });

  it('forgets a run that ends, fails or pauses, and keeps none without durable', async () => {
    const store = new InMemoryDurableRunStore();
    const agent = new Agent({ name: 'plain', model: 'mock/m', instructions: 'Answer.' });
    const durable = processWith([answer('hi')], store, 'a');
    await durable.cog.run(agent, { input: 'Hi', threadId: 't1' });
    expect(await store.list()).toEqual([]);

    const failing = processWith(
      [
        () => {
          throw new Error('provider down');
        },
      ],
      store,
      'a'
    );
    await expect(failing.cog.run(agent, { input: 'Hi', threadId: 't2' })).rejects.toThrow(
      'provider down'
    );
    expect(await store.list()).toEqual([]);

    const risky = tool({
      name: 'risky',
      description: 'Risky',
      parameters: z.object({}),
      requiresApproval: true,
      execute: async () => 'done',
    });
    const asking = new Agent({
      name: 'asking',
      model: 'mock/m',
      instructions: 'Ask.',
      tools: [risky],
    });
    const pausing = processWith(
      [callTools([{ id: 'r', name: 'risky', arguments: {} }]), answer('approved and done')],
      store,
      'a'
    );
    const paused = await pausing.cog.run(asking, { input: 'Do it', threadId: 't3' });
    expect(paused.status).toBe('paused');
    expect(await store.list()).toEqual([]);
    const resumed = await pausing.cog.resume(asking, 't3', { defaultDecision: { approved: true } });
    expect(resumed.output).toBe('approved and done');
    expect(await store.list()).toEqual([]);

    const optedOut = processWith([answer('hi')], store, 'a');
    const saves = vi.spyOn(store, 'save');
    await optedOut.cog.run(agent, { input: 'Hi', threadId: 't4', durable: false });
    expect(saves).not.toHaveBeenCalled();
  });

  it('does not make a run durable without durable set', async () => {
    const scripted = scriptedBackend([answer('hi')]);
    const cog = new Cogitator({ llm: { backends: { mock: scripted.backend } } });
    const agent = new Agent({ name: 'plain', model: 'mock/m', instructions: 'Answer.' });
    await cog.run(agent, { input: 'Hi', threadId: 'none' });
    expect(await cog.durableRuns()).toEqual([]);
  });

  it('refuses a run id a kept durable run has, and an unusable one', async () => {
    const store = new InMemoryDurableRunStore();
    const agent = new Agent({ name: 'plain', model: 'mock/m', instructions: 'Answer.' });
    const wait = countedTool('wait', forever);
    const waiting = new Agent({
      name: 'waiting',
      model: 'mock/m',
      instructions: 'Wait.',
      tools: [wait.tool],
    });
    const first = processWith([callTools([{ id: 'w', name: 'wait', arguments: {} }])], store, 'a');
    first.cog
      .run(waiting, { input: 'Go', threadId: 'jobs', runId: 'job:7' })
      .catch(() => undefined);
    await wait.started;

    const second = processWith([answer('hi')], store, 'b');
    await expect(
      second.cog.run(agent, { input: 'Hi', threadId: 'other', runId: 'job:7' })
    ).rejects.toMatchObject({ code: ErrorCode.RUN_LEASED });
    await expect(
      second.cog.run(agent, { input: 'Hi', threadId: 'other', runId: 'has space' })
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    await expect(second.cog.recoverRun(agent, 'job:8')).rejects.toMatchObject({
      code: ErrorCode.RUN_NOT_FOUND,
    });
  });

  it('discards a stopped run, answering its calls so the thread stays whole', async () => {
    const hang = countedTool('hang', forever);
    const agent = new Agent({
      name: 'discarded',
      model: 'mock/m',
      instructions: 'Work.',
      tools: [hang.tool],
    });
    const first = processOn([callTools([{ id: 'd', name: 'hang', arguments: {} }])]);
    first.cog.run(agent, { input: 'Go', threadId: 'discard' }).catch(() => undefined);
    await hang.started;
    await first.cog.close();

    const second = processOn([answer('next')]);
    const [kept] = await second.cog.durableRuns();
    await second.cog.discardRun(kept.runId);

    expect(await second.cog.durableRuns()).toEqual([]);
    const results = (await entriesOf(second.cog, 'discard')).flatMap(
      (entry) => entry.toolResults ?? []
    );
    expect(results).toEqual([expect.objectContaining({ callId: 'd', error: OUTCOME_UNKNOWN })]);
    await second.cog.run(agent, { input: 'Again', threadId: 'discard' });
    expect(toolTexts(second.requests[0]).d).toContain(OUTCOME_UNKNOWN);
    await second.cog.close();
  });

  it('reports the runs with resume: false and skips those whose agent is missing', async () => {
    const hang = countedTool('hang', forever);
    const agent = new Agent({
      id: 'lost-agent',
      name: 'lost',
      model: 'mock/m',
      instructions: 'Work.',
      tools: [hang.tool],
    });
    let now = 0;
    const store = new InMemoryDurableRunStore({ now: () => now });
    const first = processWith([callTools([{ id: 'q', name: 'hang', arguments: {} }])], store, 'a');
    first.cog.run(agent, { input: 'Go', threadId: 'report' }).catch(() => undefined);
    await hang.started;
    now += 61_000;

    const second = processWith([answer('ok')], store, 'b');
    const found = await second.cog.recoverRuns({ agents: [], resume: false });
    expect(found.found).toEqual([
      expect.objectContaining({ threadId: 'report', agentName: 'lost', held: false }),
    ]);
    const skipped = await second.cog.recoverRuns({ agents: [] });
    expect(skipped.skipped[0].reason).toContain('"lost"');
    const filtered = await second.cog.recoverRuns({
      agents: [agent],
      filter: (run) => run.threadId !== 'report',
    });
    expect(filtered.resumed).toEqual([]);
  });
});

describe('durable runs under stress', () => {
  it('continues a run once when it is recovered twice at once', async () => {
    const pay = countedTool('pay');
    const hang = countedTool('hang', forever);
    const agent = new Agent({
      id: 'payer',
      name: 'payer',
      model: 'mock/m',
      instructions: 'Pay.',
      tools: [hang.tool, pay.tool],
    });
    const first = processOn([callTools([{ id: 'h', name: 'hang', arguments: {} }])]);
    first.cog.run(agent, { input: 'Go', threadId: 'twice' }).catch(() => undefined);
    await hang.started;
    await first.cog.close();

    const second = processOn([
      callTools([{ id: 'p', name: 'pay', arguments: {} }]),
      answer('paid'),
    ]);
    const [kept] = await second.cog.durableRuns();
    const both = await Promise.allSettled([
      second.cog.recoverRun(agent, kept.runId),
      second.cog.recoverRun(agent, kept.runId),
    ]);
    const taken = both.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? [outcome.value] : []
    );
    expect(taken).toHaveLength(1);
    expect(both.find((outcome) => outcome.status === 'rejected')).toMatchObject({
      reason: { code: ErrorCode.RUN_LEASED },
    });
    const sweeps = await Promise.all([
      second.cog.recoverRuns({ agents: [agent] }),
      second.cog.recoverRuns({ agents: [agent] }),
    ]);
    expect(sweeps.flatMap((sweep) => sweep.resumed)).toEqual([]);
    await taken[0].result;
    expect(pay.calls).toHaveBeenCalledTimes(1);
    await second.cog.close();
  });

  it('never takes a run another live runtime of the same owner holds', async () => {
    const hang = countedTool('hang', forever);
    const agent = new Agent({
      name: 'holder',
      model: 'mock/m',
      instructions: 'Hold.',
      tools: [hang.tool],
    });
    const first = processOn([callTools([{ id: 'h', name: 'hang', arguments: {} }])]);
    first.cog.run(agent, { input: 'Go', threadId: 'live' }).catch(() => undefined);
    await hang.started;

    const second = processOn([answer('took it')]);
    expect(await second.cog.durableRuns()).toEqual([expect.objectContaining({ held: true })]);
    expect((await second.cog.recoverRuns({ agents: [agent] })).resumed).toEqual([]);
    const [kept] = await second.cog.durableRuns();
    await expect(second.cog.recoverRun(agent, kept.runId)).rejects.toMatchObject({
      code: ErrorCode.RUN_LEASED,
    });

    await first.cog.close();
    const { resumed } = await second.cog.recoverRuns({ agents: [agent] });
    expect(resumed).toHaveLength(1);
    expect((await resumed[0].handle.result).output).toBe('took it');
    await second.cog.close();
  });

  it('takes a run of its own owner before its lease runs out only with takeoverOnRestart', async () => {
    const hang = countedTool('hang', forever);
    const agent = new Agent({
      name: 'shared',
      model: 'mock/m',
      instructions: 'Go.',
      tools: [hang.tool],
    });
    const first = processOn([callTools([{ id: 'h', name: 'hang', arguments: {} }])], 'web', false);
    first.cog.run(agent, { input: 'Go', threadId: 'same-owner' }).catch(() => undefined);
    await hang.started;
    await first.cog.close();

    const sibling = processOn([answer('stolen')], 'web', false);
    expect(await sibling.cog.durableRuns()).toEqual([expect.objectContaining({ held: true })]);
    expect((await sibling.cog.recoverRuns({ agents: [agent] })).resumed).toEqual([]);
    const [kept] = await sibling.cog.durableRuns();
    await expect(sibling.cog.recoverRun(agent, kept.runId)).rejects.toMatchObject({
      code: ErrorCode.RUN_LEASED,
    });
    await sibling.cog.close();

    const restarted = processOn([answer('taken back')], 'web', true);
    const { resumed } = await restarted.cog.recoverRuns({ agents: [agent] });
    expect((await resumed[0].handle.result).output).toBe('taken back');
    await restarted.cog.close();
  });

  it('rides out a store that fails once, running each tool once', async () => {
    const step = countedTool('step');
    const agent = new Agent({
      name: 'steady',
      model: 'mock/m',
      instructions: 'Go.',
      tools: [step.tool],
    });
    const parked = new InMemoryDurableRunStore();
    const failed = { save: 0, append: 0 };
    const store: DurableRunStore = {
      ...around(parked),
      save: async (record, holder) => {
        if (failed.save++ === 1) throw new Error('ECONNRESET');
        return parked.save(record, holder);
      },
      append: async (ref, marks, holder) => {
        if (failed.append++ === 0) throw new Error('ECONNRESET');
        return parked.append(ref, marks, holder);
      },
    };
    const scripted = scriptedBackend([
      callTools([{ id: 's', name: 'step', arguments: {} }]),
      answer('done'),
    ]);
    const cog = new Cogitator({
      llm: { backends: { mock: scripted.backend } },
      durable: { store, owner: 'solo' },
    });

    const result = await cog.run(agent, { input: 'Go', threadId: 'flaky' });

    expect(result.output).toBe('done');
    expect(step.calls).toHaveBeenCalledTimes(1);
    expect(await parked.list()).toEqual([]);
  });

  it('suspends a run whose store keeps failing, keeping its last checkpoint for a recovery', async () => {
    const step = countedTool('step');
    const agent = new Agent({
      name: 'suspended',
      model: 'mock/m',
      instructions: 'Go.',
      tools: [step.tool],
    });
    const parked = new InMemoryDurableRunStore();
    let saves = 0;
    const store: DurableRunStore = {
      ...around(parked),
      save: async (record, holder) => {
        if (++saves > 2) throw new Error('ECONNRESET');
        return parked.save(record, holder);
      },
    };
    const scripted = scriptedBackend([callTools([{ id: 's', name: 'step', arguments: {} }])]);
    const cog = new Cogitator({
      llm: { backends: { mock: scripted.backend } },
      durable: { store, owner: 'a', storeRetries: 1 },
    });

    await expect(cog.run(agent, { input: 'Go', threadId: 'down' })).rejects.toMatchObject({
      code: ErrorCode.RUN_SUSPENDED,
    });

    const [kept] = await parked.list();
    expect(kept).toBeDefined();
    expect(kept.lease).toBeUndefined();
    const next = processWith([answer('recovered')], parked, 'b');
    const { resumed } = await next.cog.recoverRuns({ agents: [agent] });
    expect((await resumed[0].handle.result).output).toBe('recovered');
    expect(step.calls).toHaveBeenCalledTimes(1);
    expect(toolTexts(next.requests[0]).s).toContain('step done');
  });

  it('goes on without checkpoints when onStoreError is continue', async () => {
    const agent = new Agent({ name: 'careless', model: 'mock/m', instructions: 'Go.' });
    const parked = new InMemoryDurableRunStore();
    const store: DurableRunStore = {
      ...around(parked),
      save: async () => {
        throw new Error('ECONNRESET');
      },
    };
    const scripted = scriptedBackend([answer('fine')]);
    const cog = new Cogitator({
      llm: { backends: { mock: scripted.backend } },
      durable: { store, owner: 'a', storeRetries: 0, onStoreError: 'continue' },
    });
    expect((await cog.run(agent, { input: 'Go' })).output).toBe('fine');
  });

  it('keeps a final answer without a memory log, so a recovery asks the model nothing', async () => {
    const store = new InMemoryDurableRunStore();
    const hold: RunMiddleware = { name: 'hold', afterRun: () => forever };
    const agent = new Agent({ name: 'poet', model: 'mock/m', instructions: 'Rhyme.' });
    const scripted = scriptedBackend([answer('Violets are blue')]);
    const first = new Cogitator({
      llm: { backends: { mock: scripted.backend } },
      durable: { store, owner: 'a', takeoverOnRestart: true },
      middleware: [hold],
    });
    const turned = deferred();
    first
      .run(agent, { input: 'A poem', threadId: 'no-log', onModelTurn: () => turned.resolve() })
      .catch(() => undefined);
    await turned.promise;
    await vi.waitFor(async () => {
      const [kept] = await store.list();
      expect(kept?.iterations).toBe(1);
    });
    await first.close();

    const second = processWith([answer('a different poem')], store, 'a');
    const { resumed } = await second.cog.recoverRuns({ agents: [agent] });
    expect((await resumed[0].handle.result).output).toBe('Violets are blue');
    expect(second.requests).toHaveLength(0);
  });

  it('writes the answers of a lost step once, also when a recovery stops before its first checkpoint', async () => {
    const done = countedTool('done');
    const hang = countedTool('hang', forever);
    const agent = new Agent({
      name: 'twice-lost',
      model: 'mock/m',
      instructions: 'Go.',
      tools: [done.tool, hang.tool],
    });
    const first = processOn([
      callTools([
        { id: 'd', name: 'done', arguments: {} },
        { id: 'h', name: 'hang', arguments: {} },
      ]),
    ]);
    first.cog.run(agent, { input: 'Go', threadId: 'repairs' }).catch(() => undefined);
    await hang.started;
    await first.cog.close();

    const stuck = deferred();
    let inner: ThreadDurableRunStore | undefined;
    const scripted = scriptedBackend([answer('never')]);
    const memoryOf = async (): Promise<ThreadDurableRunStore> => {
      inner ??= new ThreadDurableRunStore((await second.getMemory())!);
      return inner;
    };
    const second: Cogitator = new Cogitator({
      llm: { backends: { mock: scripted.backend } },
      memory: { adapter: 'sqlite', sqlite: { path: join(dir, 'memory.db') } },
      durable: {
        owner: 'host-a',
        takeoverOnRestart: true,
        store: {
          acquire: async (...args) => (await memoryOf()).acquire(...args),
          renew: async (...args) => (await memoryOf()).renew(...args),
          release: async (...args) => (await memoryOf()).release(...args),
          append: async (...args) => (await memoryOf()).append(...args),
          load: async (...args) => (await memoryOf()).load(...args),
          list: async (...args) => (await memoryOf()).list(...args),
          delete: async (...args) => (await memoryOf()).delete(...args),
          save: async () => {
            stuck.resolve();
            return forever.then(() => false);
          },
        },
      },
    });
    const { resumed } = await second.recoverRuns({ agents: [agent] });
    resumed[0].handle.result.catch(() => undefined);
    await stuck.promise;
    await second.close();

    const third = processOn([answer('settled')]);
    const recovered = await third.cog.recoverRuns({ agents: [agent] });
    expect((await recovered.resumed[0].handle.result).output).toBe('settled');
    const results = (await entriesOf(third.cog, 'repairs')).flatMap(
      (entry) => entry.toolResults ?? []
    );
    expect(results.map((entry) => entry.callId).sort()).toEqual(['d', 'h']);
    const answers = third.requests[0].messages.filter((message) => message.role === 'tool');
    expect(answers).toHaveLength(2);
    expect(done.calls).toHaveBeenCalledTimes(1);
    await third.cog.close();
  });

  it('tells a recovered run that the background agents it started were lost', async () => {
    const inner = scriptedBackend([() => forever.then(() => answer('never'))]);
    const outer = scriptedBackend([
      callTools([
        {
          id: 'o1',
          name: 'agent',
          arguments: {
            description: 'x',
            prompt: 'dig',
            subagent_type: 'digger',
            run_in_background: true,
            name: 'dig',
          },
        },
      ]),
      () => forever.then(() => answer('never')),
    ]);
    const config = (backends: { outer: typeof outer; inner: typeof inner }) => ({
      llm: {
        backends: { outer: backends.outer.backend, inner: backends.inner.backend },
        retry: false as const,
      },
      memory: { adapter: 'sqlite' as const, sqlite: { path: join(dir, 'memory.db') } },
      durable: { owner: 'host-a', takeoverOnRestart: true },
      subagents: { agents: { digger: { description: 'digs', model: 'inner/m' } } },
    });
    const lead = new Agent({ name: 'lead', model: 'outer/m', instructions: 'Lead.' });
    const first = new Cogitator(config({ outer, inner }));
    first.run(lead, { input: 'Dig', threadId: 'background' }).catch(() => undefined);
    await vi.waitFor(() => expect(outer.requests).toHaveLength(2));
    await first.close();

    const nextOuter = scriptedBackend([
      callTools([{ id: 'o2', name: 'task_output', arguments: { task_id: 'dig' } }]),
      answer('the digger was lost'),
    ]);
    const second = new Cogitator(config({ outer: nextOuter, inner }));
    const { resumed } = await second.recoverRuns({ agents: [lead] });
    expect((await resumed[0].handle.result).output).toBe('the digger was lost');
    const report = toolTexts(nextOuter.requests[1]).o2;
    expect(report).toContain('failed');
    expect(report).toContain('outcome unknown');
    await second.close();
  });

  it('tells a recovered run at its stop about a background agent it lost', async () => {
    const inner = scriptedBackend([() => forever.then(() => answer('never'))]);
    const outer = scriptedBackend([
      callTools([
        {
          id: 'o1',
          name: 'agent',
          arguments: {
            description: 'x',
            prompt: 'dig',
            subagent_type: 'digger',
            run_in_background: true,
          },
        },
      ]),
      () => forever.then(() => answer('never')),
    ]);
    const config = (backends: { outer: typeof outer; inner: typeof inner }) => ({
      llm: {
        backends: { outer: backends.outer.backend, inner: backends.inner.backend },
        retry: false as const,
      },
      memory: { adapter: 'sqlite' as const, sqlite: { path: join(dir, 'memory.db') } },
      durable: { owner: 'host-a', takeoverOnRestart: true },
      subagents: { agents: { digger: { description: 'digs', model: 'inner/m' } } },
    });
    const lead = new Agent({ name: 'lead', model: 'outer/m', instructions: 'Lead.' });
    const first = new Cogitator(config({ outer, inner }));
    first.run(lead, { input: 'Dig', threadId: 'lost-notice' }).catch(() => undefined);
    await vi.waitFor(() => expect(outer.requests).toHaveLength(2));
    await first.close();

    const nextOuter = scriptedBackend([answer('all done'), answer('the digger was lost')]);
    const second = new Cogitator(config({ outer: nextOuter, inner }));
    const { resumed } = await second.recoverRuns({ agents: [lead] });
    expect((await resumed[0].handle.result).output).toBe('the digger was lost');
    const notice = userTexts(nextOuter.requests[1]).at(-1) ?? '';
    expect(notice).toContain('<task-notification>');
    expect(notice).toContain('outcome unknown');
    await second.close();
  });

  it('refuses to resume the checkpoint of a run left running', async () => {
    const store = new InMemoryDurableRunStore();
    const hang = countedTool('hang', forever);
    const agent = new Agent({
      name: 'r',
      model: 'mock/m',
      instructions: 'Go.',
      tools: [hang.tool],
    });
    const first = processWith([callTools([{ id: 'h', name: 'hang', arguments: {} }])], store, 'a');
    first.cog.run(agent, { input: 'Go', threadId: 'running' }).catch(() => undefined);
    await hang.started;
    const [kept] = await store.list();
    const record = await store.load(kept);
    await expect(first.cog.resume(agent, record!.checkpoint)).rejects.toThrow(/recoverRun/);
  });
});

describe('durable runs at the edges of a step', () => {
  it('keeps a follow-up it delivered without a memory log when the process stops right after', async () => {
    const store = new InMemoryDurableRunStore();
    const agent = new Agent({ name: 'follower', model: 'mock/m', instructions: 'Answer.' });
    const asked = deferred();
    const first = processWith(
      [
        answer('first answer'),
        () => {
          asked.resolve();
          return forever.then(() => answer('never'));
        },
      ],
      store,
      'a'
    );
    const handle = first.cog.start(agent, { input: 'Start', threadId: 'follow' });
    handle.followUp('And then the second part');
    handle.result.catch(() => undefined);
    await asked.promise;
    await first.cog.close();

    const second = processWith([answer('second answer')], store, 'a');
    const { resumed } = await second.cog.recoverRuns({ agents: [agent] });
    expect((await resumed[0].handle.result).output).toBe('second answer');
    const texts = userTexts(second.requests[0]);
    expect(texts.filter((text) => text === 'And then the second part')).toHaveLength(1);
    expect(second.requests).toHaveLength(1);
  });

  it('reads once a mark the store kept twice', async () => {
    const parked = new InMemoryDurableRunStore();
    const store: DurableRunStore = {
      ...around(parked),
      append: async (ref, marks, holder) => {
        await parked.append(ref, marks, holder);
        return parked.append(ref, marks, holder);
      },
    };
    const agent = new Agent({ name: 'doubled', model: 'mock/m', instructions: 'Answer.' });
    const asked = deferred();
    const first = processWith(
      [
        answer('first answer'),
        () => {
          asked.resolve();
          return forever.then(() => answer('never'));
        },
      ],
      store,
      'a'
    );
    const handle = first.cog.start(agent, { input: 'Start', threadId: 'doubled' });
    handle.followUp('Only once please');
    handle.result.catch(() => undefined);
    await asked.promise;
    await first.cog.close();

    const second = processWith([answer('done')], parked, 'a');
    const { resumed } = await second.cog.recoverRuns({ agents: [agent] });
    await resumed[0].handle.result;
    expect(
      userTexts(second.requests[0]).filter((text) => text === 'Only once please')
    ).toHaveLength(1);
  });

  it('writes what was queued before it hands its run over', async () => {
    const parked = new InMemoryDurableRunStore();
    const slow = deferred();
    let appends = 0;
    const store: DurableRunStore = {
      ...around(parked),
      append: async (ref, marks, holder) => {
        if (++appends === 2) await slow.promise;
        return parked.append(ref, marks, holder);
      },
    };
    const wait = countedTool('wait', forever);
    const agent = new Agent({
      name: 'handing',
      model: 'mock/m',
      instructions: 'Wait.',
      tools: [wait.tool],
    });
    const first = processWith([callTools([{ id: 'w', name: 'wait', arguments: {} }])], store, 'a');
    const controller = new AbortController();
    const handle = first.cog.start(agent, {
      input: 'Wait',
      threadId: 'handing',
      signal: controller.signal,
    });
    await wait.started;
    handle.steer('First note');
    handle.steer('Second note');
    controller.abort(new CogitatorError({ message: 'redeploy', code: ErrorCode.RUN_SUSPENDED }));
    slow.resolve();
    await expect(handle.result).rejects.toThrow('redeploy');

    const [kept] = await parked.list();
    const record = await parked.load(kept);
    const queues = record!.journal.filter((mark) => mark.kind === 'queue');
    expect(queues.at(-1)).toMatchObject({
      pending: [
        { kind: 'steer', content: 'First note' },
        { kind: 'steer', content: 'Second note' },
      ],
    });
  });

  it('writes nothing more once another process took its run over', async () => {
    let now = 0;
    const store = new InMemoryDurableRunStore({ now: () => now });
    const release = deferred();
    const slow = countedTool('slow', release.promise);
    const agent = new Agent({
      name: 'zombie',
      model: 'mock/m',
      instructions: 'Go.',
      tools: [slow.tool],
    });
    const ended: string[] = [];
    const memory = { adapter: 'sqlite' as const, sqlite: { path: join(dir, 'memory.db') } };
    const zombieScript = scriptedBackend([
      callTools([{ id: 'z', name: 'slow', arguments: {} }]),
      answer('zombie answer'),
    ]);
    const zombie = new Cogitator({
      llm: { backends: { mock: zombieScript.backend } },
      memory,
      durable: { store, owner: 'a', takeoverOnRestart: true },
      middleware: [{ name: 'end', afterRun: (event) => void ended.push(event.status) }],
    });
    const running = zombie.run(agent, { input: 'Go', threadId: 'zombie' });
    running.catch(() => undefined);
    await slow.started;

    now += 61_000;
    const nextScript = scriptedBackend([answer('taken over')]);
    const next = new Cogitator({
      llm: { backends: { mock: nextScript.backend } },
      memory,
      durable: { store, owner: 'b' },
    });
    const { resumed } = await next.recoverRuns({ agents: [agent] });
    expect((await resumed[0].handle.result).output).toBe('taken over');

    release.resolve();
    await expect(running).rejects.toMatchObject({ code: ErrorCode.RUN_LEASED });
    const results = (await entriesOf(next, 'zombie')).flatMap((entry) => entry.toolResults ?? []);
    expect(results).toEqual([expect.objectContaining({ callId: 'z', error: OUTCOME_UNKNOWN })]);
    expect(ended).toEqual([]);
    expect(zombieScript.requests).toHaveLength(1);
    await zombie.close();
    await next.close();
  });

  it('runs the stop hooks again for an answer whose stop had not settled', async () => {
    const store = new InMemoryDurableRunStore();
    const agent = new Agent({ name: 'stopper', model: 'mock/m', instructions: 'Answer.' });
    const reached = deferred();
    const first = new Cogitator({
      llm: { backends: { mock: scriptedBackend([answer('draft')]).backend } },
      durable: { store, owner: 'a', takeoverOnRestart: true },
      middleware: [
        {
          name: 'stuck-stop',
          beforeStop: () => {
            reached.resolve();
            return forever.then(() => undefined);
          },
        },
      ],
    });
    first.run(agent, { input: 'Write', threadId: 'stop' }).catch(() => undefined);
    await reached.promise;
    await first.close();

    const stops: string[] = [];
    const scripted = scriptedBackend([answer('final')]);
    const second = new Cogitator({
      llm: { backends: { mock: scripted.backend } },
      durable: { store, owner: 'a', takeoverOnRestart: true },
      middleware: [
        {
          name: 'review',
          beforeStop: (event) => {
            stops.push(event.output);
            return stops.length === 1 ? { continueWith: 'Polish it' } : undefined;
          },
        },
      ],
    });
    const { resumed } = await second.recoverRuns({ agents: [agent] });
    expect((await resumed[0].handle.result).output).toBe('final');
    expect(stops).toEqual(['draft', 'final']);
    expect(userTexts(scripted.requests[0]).at(-1)).toBe('Polish it');
  });

  it('asks for the closing answer at the iteration limit after a stop before it', async () => {
    const store = new InMemoryDurableRunStore();
    const step = countedTool('step');
    const agent = new Agent({
      name: 'limited',
      model: 'mock/m',
      instructions: 'Go.',
      tools: [step.tool],
      maxIterations: 1,
      onIterationLimit: 'answer',
    });
    const closing = deferred();
    const first = processWith(
      [
        callTools([{ id: 's', name: 'step', arguments: {} }]),
        () => {
          closing.resolve();
          return forever.then(() => answer('never'));
        },
      ],
      store,
      'a'
    );
    first.cog.run(agent, { input: 'Go', threadId: 'limit' }).catch(() => undefined);
    await closing.promise;
    await first.cog.close();

    const second = processWith([answer('closing answer')], store, 'a');
    const { resumed } = await second.cog.recoverRuns({ agents: [agent] });
    const result = await resumed[0].handle.result;
    expect(result.output).toBe('closing answer');
    expect(result.iterationLimitReached).toBe(true);
    expect(second.requests[0].toolChoice).toBe('none');
    expect(userTexts(second.requests[0]).at(-1)).toContain('Give your final answer now');
    expect(step.calls).toHaveBeenCalledTimes(1);
  });
});

describe('durable runs after a takeover and around follow-ups', () => {
  it('never writes the answer of a model call that came back after its lease was taken', async () => {
    let now = 0;
    const store = new InMemoryDurableRunStore({ now: () => now });
    const memory = { adapter: 'sqlite' as const, sqlite: { path: join(dir, 'memory.db') } };
    const late = deferred<void>();
    const asked = deferred();
    const agent = new Agent({ name: 'late', model: 'mock/m', instructions: 'Answer.' });
    const old = new Cogitator({
      llm: {
        backends: {
          mock: scriptedBackend([
            async () => {
              asked.resolve();
              await late.promise;
              return answer('stale answer');
            },
          ]).backend,
        },
      },
      memory,
      durable: { store, owner: 'a' },
    });
    const running = old.run(agent, { input: 'Hi', threadId: 'late' });
    running.catch(() => undefined);
    await asked.promise;

    now += 61_000;
    const next = new Cogitator({
      llm: { backends: { mock: scriptedBackend([answer('fresh answer')]).backend } },
      memory,
      durable: { store, owner: 'b' },
    });
    const { resumed } = await next.recoverRuns({ agents: [agent] });
    expect((await resumed[0].handle.result).output).toBe('fresh answer');

    late.resolve();
    await expect(running).rejects.toMatchObject({ code: ErrorCode.RUN_LEASED });
    const answers = (await entriesOf(next, 'late'))
      .filter((entry) => entry.message.role === 'assistant')
      .map((entry) => entry.message.content);
    expect(answers).toEqual(['fresh answer']);
    await old.close();
    await next.close();
  });

  it.each([
    ['without a memory log', false],
    ['with a memory log', true],
  ])('keeps the iterations a follow-up gave the run %s', async (_name, logged) => {
    const store = new InMemoryDurableRunStore();
    const agent = new Agent({
      name: 'short',
      model: 'mock/m',
      instructions: 'Answer.',
      maxIterations: 1,
    });
    const asked = deferred();
    const config = (turns: ScriptedTurn[]) => {
      const scripted = scriptedBackend(turns);
      return {
        scripted,
        cog: new Cogitator({
          llm: { backends: { mock: scripted.backend } },
          ...(logged && {
            memory: { adapter: 'sqlite' as const, sqlite: { path: join(dir, 'm.db') } },
          }),
          durable: { store, owner: 'a', takeoverOnRestart: true },
        }),
      };
    };
    const first = config([
      answer('first'),
      () => {
        asked.resolve();
        return forever.then(() => answer('never'));
      },
    ]);
    const handle = first.cog.start(agent, { input: 'Start', threadId: 'limits' });
    handle.followUp('One more thing');
    handle.result.catch(() => undefined);
    await asked.promise;
    await first.cog.close();

    const second = config([answer('second')]);
    const { resumed } = await second.cog.recoverRuns({ agents: [agent] });
    expect((await resumed[0].handle.result).output).toBe('second');
    expect(second.scripted.requests).toHaveLength(1);
  });

  it('tells two follow-ups with the same text apart', async () => {
    const store = new InMemoryDurableRunStore();
    const memory = { adapter: 'sqlite' as const, sqlite: { path: join(dir, 'memory.db') } };
    const agent = new Agent({ name: 'twins', model: 'mock/m', instructions: 'Answer.' });
    const asked = deferred();
    const firstScript = scriptedBackend([
      answer('first'),
      () => {
        asked.resolve();
        return forever.then(() => answer('never'));
      },
    ]);
    const first = new Cogitator({
      llm: { backends: { mock: firstScript.backend } },
      memory,
      durable: { store, owner: 'a', takeoverOnRestart: true },
    });
    const handle = first.start(agent, { input: 'Start', threadId: 'twins' });
    handle.followUp('Again');
    handle.followUp('Again');
    handle.result.catch(() => undefined);
    await asked.promise;
    await first.close();

    const nextScript = scriptedBackend([answer('second'), answer('third')]);
    const next = new Cogitator({
      llm: { backends: { mock: nextScript.backend } },
      memory,
      durable: { store, owner: 'a', takeoverOnRestart: true },
    });
    const { resumed } = await next.recoverRuns({ agents: [agent] });
    expect((await resumed[0].handle.result).output).toBe('third');
    expect(nextScript.requests).toHaveLength(2);
    expect(userTexts(nextScript.requests[1]).filter((text) => text === 'Again')).toHaveLength(2);
    await next.close();
  });

  it('writes the answers of a discarded run once when a discard is tried again', async () => {
    const hang = countedTool('hang', forever);
    const agent = new Agent({
      name: 'again',
      model: 'mock/m',
      instructions: 'Go.',
      tools: [hang.tool],
    });
    const first = processOn([callTools([{ id: 'd', name: 'hang', arguments: {} }])]);
    first.cog.run(agent, { input: 'Go', threadId: 'discard-twice' }).catch(() => undefined);
    await hang.started;
    await first.cog.close();

    let inner: ThreadDurableRunStore | undefined;
    let deletes = 0;
    const scripted = scriptedBackend([answer('unused')]);
    const storeOf = async (): Promise<ThreadDurableRunStore> => {
      inner ??= new ThreadDurableRunStore((await second.getMemory())!);
      return inner;
    };
    const second: Cogitator = new Cogitator({
      llm: { backends: { mock: scripted.backend } },
      memory: { adapter: 'sqlite', sqlite: { path: join(dir, 'memory.db') } },
      durable: {
        owner: 'host-a',
        takeoverOnRestart: true,
        storeRetries: 0,
        store: {
          acquire: async (...args) => (await storeOf()).acquire(...args),
          renew: async (...args) => (await storeOf()).renew(...args),
          release: async (...args) => (await storeOf()).release(...args),
          save: async (...args) => (await storeOf()).save(...args),
          append: async (...args) => (await storeOf()).append(...args),
          load: async (...args) => (await storeOf()).load(...args),
          list: async (...args) => (await storeOf()).list(...args),
          delete: async (...args) => {
            if (deletes++ === 0) throw new Error('ECONNRESET');
            return (await storeOf()).delete(...args);
          },
        },
      },
    });
    const [kept] = await second.durableRuns();
    await expect(second.discardRun(kept.runId)).rejects.toThrow('ECONNRESET');
    await second.discardRun(kept.runId);

    const results = (await entriesOf(second, 'discard-twice')).flatMap(
      (entry) => entry.toolResults ?? []
    );
    expect(results.map((entry) => entry.callId)).toEqual(['d']);
    expect(await second.durableRuns()).toEqual([]);
    await second.close();
  });
});

describe('durable runs and what the thread lets go of', () => {
  it.each([
    ['the thread store', false],
    ['a store of its own', true],
  ])('forgets a stopped run whose input was forgotten, in %s', async (_name, own) => {
    const hang = countedTool('hang', forever);
    const agent = new Agent({
      name: 'private',
      model: 'mock/m',
      instructions: 'Go.',
      tools: [hang.tool],
    });
    const store = own ? new InMemoryDurableRunStore() : undefined;
    const memory = { adapter: 'sqlite' as const, sqlite: { path: join(dir, 'memory.db') } };
    const make = (turns: ScriptedTurn[]) => {
      const scripted = scriptedBackend(turns);
      return {
        scripted,
        cog: new Cogitator({
          llm: { backends: { mock: scripted.backend } },
          memory,
          durable: { owner: 'host-a', takeoverOnRestart: true, ...(store && { store }) },
        }),
      };
    };
    const first = make([callTools([{ id: 'h', name: 'hang', arguments: {} }])]);
    first.cog.run(agent, { input: 'My card is 4242', threadId: 'secret' }).catch(() => undefined);
    await hang.started;
    await first.cog.close();

    const second = make([answer('nothing to recall')]);
    const input = (await entriesOf(second.cog, 'secret')).find(
      (entry) => entry.message.role === 'user'
    );
    expect(await second.cog.durableRuns()).toHaveLength(1);
    await second.cog.forget({ entryIds: [input!.id] });

    expect(await second.cog.durableRuns()).toEqual([]);
    expect((await second.cog.recoverRuns({ agents: [agent] })).resumed).toEqual([]);
    expect(second.scripted.requests).toHaveLength(0);
    await second.cog.close();
  });

  it('refuses a run id another run holds before it writes anything', async () => {
    const store = new InMemoryDurableRunStore();
    const memory = { adapter: 'sqlite' as const, sqlite: { path: join(dir, 'memory.db') } };
    const hang = countedTool('hang', forever);
    const agent = new Agent({
      name: 'held',
      model: 'mock/m',
      instructions: 'Go.',
      tools: [hang.tool],
    });
    const first = new Cogitator({
      llm: {
        backends: {
          mock: scriptedBackend([callTools([{ id: 'h', name: 'hang', arguments: {} }])]).backend,
        },
      },
      memory,
      durable: { store, owner: 'a' },
    });
    first.run(agent, { input: 'First', threadId: 'one', runId: 'job:1' }).catch(() => undefined);
    await hang.started;

    const second = new Cogitator({
      llm: { backends: { mock: scriptedBackend([answer('no')]).backend } },
      memory,
      durable: { store, owner: 'b' },
    });
    await expect(
      second.run(agent, { input: 'Second', threadId: 'two', runId: 'job:1' })
    ).rejects.toMatchObject({ code: ErrorCode.RUN_LEASED });
    expect(await entriesOf(second, 'two')).toEqual([]);
    await first.close();
    await second.close();
  });

  it('brings back the usage of an answer the log has and the last checkpoint does not', async () => {
    const parked = new InMemoryDurableRunStore();
    const stuck = deferred();
    let saves = 0;
    const store: DurableRunStore = {
      ...around(parked),
      save: async (record, holder) => {
        if (++saves === 2) {
          stuck.resolve();
          return forever.then(() => false);
        }
        return parked.save(record, holder);
      },
    };
    const agent = new Agent({ name: 'counted', model: 'mock/m', instructions: 'Answer.' });
    const memory = { adapter: 'sqlite' as const, sqlite: { path: join(dir, 'memory.db') } };
    const first = new Cogitator({
      llm: { backends: { mock: scriptedBackend([answer('counted answer')]).backend } },
      memory,
      durable: { store, owner: 'a', takeoverOnRestart: true },
    });
    first.run(agent, { input: 'Count', threadId: 'usage' }).catch(() => undefined);
    await stuck.promise;
    await first.close();

    const scripted = scriptedBackend([answer('never')]);
    const second = new Cogitator({
      llm: { backends: { mock: scripted.backend } },
      memory,
      durable: { store: parked, owner: 'a', takeoverOnRestart: true },
    });
    const { resumed } = await second.recoverRuns({ agents: [agent] });
    const result = await resumed[0].handle.result;
    expect(result.output).toBe('counted answer');
    expect(result.usage.totalTokens).toBe(15);
    expect(scripted.requests).toHaveLength(0);
    await second.close();
  });
});

describe('durable runs while they wait and start', () => {
  it('drops a recovery whose run went on elsewhere while it waited for a slot', async () => {
    let now = 0;
    const store = new InMemoryDurableRunStore({ now: () => now });
    const hang = countedTool('hang', forever);
    const pay = countedTool('pay');
    const agent = new Agent({
      name: 'slotted',
      model: 'mock/m',
      instructions: 'Go.',
      tools: [hang.tool, pay.tool],
    });
    const first = processWith([callTools([{ id: 'h', name: 'hang', arguments: {} }])], store, 'a');
    first.cog.run(agent, { input: 'Go', threadId: 'slot' }).catch(() => undefined);
    await hang.started;
    now += 61_000;

    const busy = deferred();
    const waiting = new Cogitator({
      llm: {
        backends: {
          mock: scriptedBackend([
            () => {
              busy.resolve();
              return forever.then(() => answer('never'));
            },
            callTools([{ id: 'p', name: 'pay', arguments: {} }]),
            answer('paid twice'),
          ]).backend,
        },
      },
      limits: { maxConcurrentRuns: 1 },
      durable: { store, owner: 'b' },
    });
    const plain = new Agent({ name: 'other', model: 'mock/m', instructions: 'Wait.' });
    const blocker = new AbortController();
    waiting
      .run(plain, { input: 'Hold the slot', signal: blocker.signal, durable: false })
      .catch(() => undefined);
    await busy.promise;
    const [kept] = await store.list();
    const late = await waiting.recoverRun(agent, kept.runId);
    late.result.catch(() => undefined);

    now += 61_000;
    const other = processWith(
      [callTools([{ id: 'p', name: 'pay', arguments: {} }]), answer('paid once')],
      store,
      'c'
    );
    const { resumed } = await other.cog.recoverRuns({ agents: [agent] });
    expect((await resumed[0].handle.result).output).toBe('paid once');

    blocker.abort();
    await expect(late.result).rejects.toMatchObject({ code: ErrorCode.RUN_LEASED });
    expect(pay.calls).toHaveBeenCalledTimes(1);
  });

  it('creates a new thread for the user of a durable run', async () => {
    const scripted = scriptedBackend([answer('hello alice')]);
    const cog = new Cogitator({
      llm: { backends: { mock: scripted.backend } },
      memory: { adapter: 'memory' },
      durable: true,
    });
    const agent = new Agent({
      id: 'greeter',
      name: 'greeter',
      model: 'mock/m',
      instructions: 'Greet.',
    });

    const result = await cog.run(agent, { input: 'Hi', threadId: 'alice-new', userId: 'alice' });

    expect(result.output).toBe('hello alice');
    const thread = await (await cog.getMemory())!.getThread('alice-new');
    expect(thread.success && thread.data?.metadata).toMatchObject({
      agentId: 'greeter',
      userId: 'alice',
    });
    await cog.close();
  });

  it('keeps a message queued while the run starts, before its first checkpoint', async () => {
    const store = new InMemoryDurableRunStore();
    const scripted = scriptedBackend([answer('saw it')]);
    let steered: (() => void) | undefined;
    const cog = new Cogitator({
      llm: { backends: { mock: scripted.backend } },
      durable: { store, owner: 'a' },
      middleware: [{ name: 'early', startRun: () => void steered?.() }],
    });
    const agent = new Agent({ name: 'early', model: 'mock/m', instructions: 'Answer.' });
    const handle = cog.start(agent, { input: 'Start', threadId: 'early' });
    steered = () => handle.steer('Early note');

    const result = await handle.result;

    expect(result.output).toBe('saw it');
    expect(userTexts(scripted.requests[0])).toContain('Early note');
  });

  it('lets a recovery go when its run stops before it starts', async () => {
    const store = new InMemoryDurableRunStore();
    const hang = countedTool('hang', forever);
    const agent = new Agent({
      name: 'gone',
      model: 'mock/m',
      instructions: 'Go.',
      tools: [hang.tool],
    });
    const first = processWith([callTools([{ id: 'h', name: 'hang', arguments: {} }])], store, 'a');
    first.cog.run(agent, { input: 'Go', threadId: 'aborted' }).catch(() => undefined);
    await hang.started;
    await first.cog.close();

    const second = processWith([answer('done')], store, 'a');
    const [kept] = await second.cog.durableRuns();
    const stopped = new AbortController();
    stopped.abort(new Error('not now'));
    const handle = await second.cog.recoverRun(agent, kept.runId, { signal: stopped.signal });
    await expect(handle.result).rejects.toThrow('not now');

    await vi.waitFor(async () => {
      expect(await second.cog.durableRuns()).toEqual([expect.objectContaining({ held: false })]);
    });
    const again = await second.cog.recoverRun(agent, kept.runId);
    expect((await again.result).output).toBe('done');
  });
});

describe('durable runs keep their checkpoint through store errors', () => {
  it.each([
    ['taking the lease back', 'acquire', 2],
    ['reading the checkpoint back', 'load', 2],
    ['renewing the lease', 'renew', 1],
    ['saving a step', 'save', 1],
    ['noting a tool call', 'append', 1],
  ] as const)('keeps it after an error %s', async (_name, method, from) => {
    const parked = new InMemoryDurableRunStore();
    const hang = countedTool('hang', forever);
    const step = countedTool('step');
    const agent = new Agent({
      name: 'kept',
      model: 'mock/m',
      instructions: 'Go.',
      tools: [hang.tool, step.tool],
    });
    const first = processWith([callTools([{ id: 'h', name: 'hang', arguments: {} }])], parked, 'a');
    first.cog.run(agent, { input: 'Go', threadId: 'kept' }).catch(() => undefined);
    await hang.started;
    await first.cog.close();

    const calls = { acquire: 0, load: 0, renew: 0, save: 0, append: 0 };
    const failing = <T>(name: keyof typeof calls, call: () => Promise<T>): Promise<T> => {
      if (name !== method) return call();
      calls[name]++;
      return calls[name] >= from ? Promise.reject(new Error('ECONNRESET')) : call();
    };
    const store: DurableRunStore = {
      ...around(parked),
      acquire: (...args) => failing('acquire', () => parked.acquire(...args)),
      load: (...args) => failing('load', () => parked.load(...args)),
      renew: (...args) => failing('renew', () => parked.renew(...args)),
      save: (...args) => failing('save', () => parked.save(...args)),
      append: (...args) => failing('append', () => parked.append(...args)),
    };
    const broken = new Cogitator({
      llm: {
        backends: {
          mock: scriptedBackend([
            callTools([{ id: 's', name: 'step', arguments: {} }]),
            answer('done'),
          ]).backend,
        },
      },
      durable: { store, owner: 'a', takeoverOnRestart: true, storeRetries: 0 },
    });
    const [kept] = await parked.list();
    const handle = await broken.recoverRun(agent, kept.runId);
    await expect(handle.result).rejects.toThrow();
    await broken.close();

    expect(await parked.list()).toHaveLength(1);
    const next = processWith([answer('recovered')], parked, 'a');
    const { resumed } = await next.cog.recoverRuns({ agents: [agent] });
    expect((await resumed[0].handle.result).output).toBe('recovered');
    expect(await parked.list()).toEqual([]);
  });
});

describe('durable runs and what they spent', () => {
  it('charges the tool calls of a step its process lost before the next checkpoint', async () => {
    const store = new InMemoryDurableRunStore();
    const quick = countedTool('quick');
    const hang = countedTool('hang', forever);
    const extra = countedTool('extra');
    const agent = new Agent({
      name: 'budgeted',
      model: 'mock/m',
      instructions: 'Go.',
      tools: [quick.tool, hang.tool, extra.tool],
      budget: { maxToolCalls: 2 },
    });
    const first = processWith(
      [
        callTools([
          { id: 'q', name: 'quick', arguments: {} },
          { id: 'h', name: 'hang', arguments: {} },
        ]),
      ],
      store,
      'a'
    );
    first.cog.run(agent, { input: 'Go', threadId: 'budget' }).catch(() => undefined);
    await hang.started;
    await first.cog.close();

    const second = processWith(
      [callTools([{ id: 'x', name: 'extra', arguments: {} }]), answer('stopped at the budget')],
      store,
      'a'
    );
    const { resumed } = await second.cog.recoverRuns({ agents: [agent] });
    await resumed[0].handle.result;
    expect(extra.calls).not.toHaveBeenCalled();
    expect(quick.calls).toHaveBeenCalledTimes(1);
  });

  it('stops renewing the lease of a run it discarded', async () => {
    const parked = new InMemoryDurableRunStore();
    const hang = countedTool('hang', forever);
    const agent = new Agent({
      name: 'renewed',
      model: 'mock/m',
      instructions: 'Go.',
      tools: [hang.tool],
    });
    const first = processWith([callTools([{ id: 'h', name: 'hang', arguments: {} }])], parked, 'a');
    first.cog.run(agent, { input: 'Go', threadId: 'renew' }).catch(() => undefined);
    await hang.started;
    await first.cog.close();

    const renew = vi.spyOn(parked, 'renew');
    const second = processWith([answer('unused')], parked, 'a');
    const [kept] = await second.cog.durableRuns();
    vi.useFakeTimers();
    try {
      await second.cog.discardRun(kept.runId);
      const before = renew.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(renew.mock.calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps telling about a lost background agent across a second stop', async () => {
    const inner = scriptedBackend([() => forever.then(() => answer('never'))]);
    const hangs = () => forever.then(() => answer('never'));
    const outer = scriptedBackend([
      callTools([
        {
          id: 'o1',
          name: 'agent',
          arguments: {
            description: 'x',
            prompt: 'dig',
            subagent_type: 'digger',
            run_in_background: true,
          },
        },
      ]),
      hangs,
    ]);
    const config = (backend: typeof outer) => ({
      llm: {
        backends: { outer: backend.backend, inner: inner.backend },
        retry: false as const,
      },
      memory: { adapter: 'sqlite' as const, sqlite: { path: join(dir, 'memory.db') } },
      durable: { owner: 'host-a', takeoverOnRestart: true },
      subagents: { agents: { digger: { description: 'digs', model: 'inner/m' } } },
    });
    const lead = new Agent({ name: 'lead', model: 'outer/m', instructions: 'Lead.' });
    const first = new Cogitator(config(outer));
    first.run(lead, { input: 'Dig', threadId: 'lost-twice' }).catch(() => undefined);
    await vi.waitFor(() => expect(outer.requests).toHaveLength(2));
    await first.close();

    const middle = scriptedBackend([hangs]);
    const second = new Cogitator(config(middle));
    const recovered = await second.recoverRuns({ agents: [lead] });
    recovered.resumed[0].handle.result.catch(() => undefined);
    await vi.waitFor(() => expect(middle.requests).toHaveLength(1));
    await second.close();

    const last = scriptedBackend([answer('all done'), answer('the digger was lost')]);
    const third = new Cogitator(config(last));
    const { resumed } = await third.recoverRuns({ agents: [lead] });
    expect((await resumed[0].handle.result).output).toBe('the digger was lost');
    expect(userTexts(last.requests[1]).at(-1)).toContain('outcome unknown');
    await third.close();
  });
});

/** The durable record of the one run kept for `threadId`, read from the store on the memory */
async function loadRecord(cog: Cogitator, threadId: string): Promise<DurableRunRecord | null> {
  const [run] = await cog.durableRuns({ threadId });
  const memory = await cog.getMemory();
  if (!run || !memory) return null;
  return new ThreadDurableRunStore(memory).load(run);
}
