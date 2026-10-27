import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { DurableRunStore } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { InMemoryDurableRunStore } from '../cogitator/durable-stores';
import { rebuildDurableRun } from '../cogitator/durable-runs';
import { answer, callTools, deferred, scriptedBackend } from './helpers/scripted-backend';

type StoreMethod = keyof DurableRunStore;

const METHODS: StoreMethod[] = [
  'list',
  'acquire',
  'load',
  'renew',
  'save',
  'append',
  'delete',
  'release',
];

const forever = new Promise<void>(() => undefined);

/** Every await point of a recovery: the nth call of a store method fails or aborts the run */
const CASES = METHODS.flatMap((method) =>
  [1, 2, 3].flatMap((nth) => (['throw', 'abort'] as const).map((mode) => ({ method, nth, mode })))
);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a durable run recovered with a fault at every step of its lifecycle', () => {
  it.each(CASES)('$mode at call $nth of $method', async ({ method, nth, mode }) => {
    const parked = new InMemoryDurableRunStore();
    const started = deferred();
    let stepRuns = 0;
    let afterAbort = 0;
    const hang = tool({
      name: 'hang',
      description: 'Hangs',
      parameters: z.object({}),
      execute: async () => {
        started.resolve();
        await forever;
        return 'never';
      },
    });
    const step = tool({
      name: 'step',
      description: 'Steps',
      parameters: z.object({}),
      execute: async (_args, context) => {
        if (context.signal?.aborted) afterAbort++;
        stepRuns++;
        return 'stepped';
      },
    });
    const agent = new Agent({
      id: 'lifecycle',
      name: 'lifecycle',
      model: 'mock/m',
      instructions: 'Go.',
      tools: [hang, step],
      budget: { maxToolCalls: 10 },
    });
    const crashed = new Cogitator({
      llm: {
        backends: {
          mock: scriptedBackend([callTools([{ id: 'h', name: 'hang', arguments: {} }])]).backend,
        },
      },
      durable: { store: parked, owner: 'a', takeoverOnRestart: true },
    });
    crashed.run(agent, { input: 'Go', threadId: 'lifecycle' }).catch(() => undefined);
    await started.promise;
    await crashed.close();
    const [kept] = await parked.list();

    const controller = new AbortController();
    let calls = 0;
    let injecting = true;
    const faulty = <T>(name: StoreMethod, call: () => Promise<T>): Promise<T> => {
      if (!injecting || name !== method || ++calls !== nth) return call();
      if (mode === 'throw') return Promise.reject(new Error('ECONNRESET'));
      controller.abort(new Error('stopped by the host'));
      return call();
    };
    const store: DurableRunStore = {
      acquire: (...args) => faulty('acquire', () => parked.acquire(...args)),
      renew: (...args) => faulty('renew', () => parked.renew(...args)),
      release: (...args) => faulty('release', () => parked.release(...args)),
      save: (...args) => faulty('save', () => parked.save(...args)),
      append: (...args) => faulty('append', () => parked.append(...args)),
      load: (...args) => faulty('load', () => parked.load(...args)),
      list: (...args) => faulty('list', () => parked.list(...args)),
      delete: (...args) => faulty('delete', () => parked.delete(...args)),
    };

    const created: ReturnType<typeof setInterval>[] = [];
    const cleared = new Set<unknown>();
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: () => void, ms?: number) => {
      const id = realSet(handler, ms);
      created.push(id);
      return id;
    }) as typeof setInterval);
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(((
      id: ReturnType<typeof setInterval> | undefined
    ) => {
      cleared.add(id);
      realClear(id);
    }) as typeof clearInterval);

    const recovering = new Cogitator({
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
    const completed = await recovering
      .recoverRun(agent, kept.runId, { signal: controller.signal })
      .then((handle) => handle.result)
      .then(
        () => true,
        () => false
      );
    await new Promise((resolve) => setImmediate(resolve));
    injecting = false;

    expect(afterAbort).toBe(0);
    expect(stepRuns).toBeLessThanOrEqual(1);
    expect(created.filter((id) => !cleared.has(id))).toEqual([]);
    for (const run of await recovering.durableRuns()) expect(run.held).toBe(false);
    await recovering.close();
    vi.restoreAllMocks();

    const left = await parked.list();
    if (!completed && mode === 'throw') expect(left).toHaveLength(1);
    if (left.length === 0) return;

    const record = await parked.load(left[0]);
    const rebuilt = await rebuildDurableRun(record!, undefined);
    const charged = rebuilt.checkpoint.budget?.spent.toolCalls ?? 0;
    expect(charged).toBeGreaterThanOrEqual(1 + stepRuns);
    expect(charged).toBeLessThanOrEqual(2);

    const finishing = new Cogitator({
      llm: {
        backends: {
          mock: scriptedBackend([
            callTools([{ id: 's2', name: 'step', arguments: {} }]),
            answer('done'),
          ]).backend,
        },
      },
      durable: { store: parked, owner: 'a', takeoverOnRestart: true },
    });
    const { resumed } = await finishing.recoverRuns({ agents: [agent] });
    expect((await resumed[0].handle.result).output).toBe('done');
    expect(stepRuns).toBeLessThanOrEqual(2);
    expect(await parked.list()).toEqual([]);
    await finishing.close();
  });
});
