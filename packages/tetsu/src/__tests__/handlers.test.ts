import { describe, expect, test } from 'bun:test';
import { HttpError } from '@tetsujs/core';
import { testCtx } from '@tetsujs/core/testing';
import { cogitatorController, describeError } from '../index.js';
import { importOptional } from '../errors.js';
import { eventsOf } from '../streaming.js';
import { chatAgent, deferred, fakeCogitator, lastRunOptions, runResult } from './helpers.js';

describe('handlers called directly', () => {
  const { cogitator, run } = fakeCogitator(() => Promise.resolve(runResult({ output: 'direct' })));
  const routes = cogitatorController({
    cogitator,
    agents: { chat: chatAgent() },
    authorizeThread: (auth) => auth?.userId === 'ada',
  });

  test('lists agents', () => {
    expect(routes.listAgents.handler(testCtx({ params: {}, cogitatorAuth: undefined }))).toEqual({
      agents: [{ name: 'chat', description: 'Answers questions', tools: ['get_weather'] }],
    });
  });

  test('runs an agent as the caller', async () => {
    const ctx = testCtx({
      params: { name: 'chat' },
      body: { input: 'hi', threadId: 'ada-1' },
      cogitatorAuth: { userId: 'ada' },
    });

    const response = await routes.runAgent.handler(ctx);

    expect(response).toMatchObject({ output: 'direct', threadId: 'thread-1' });
    expect(lastRunOptions(run).userId).toBe('ada');
  });

  test('refuses a thread the caller may not use', async () => {
    const ctx = testCtx({
      params: { name: 'chat' },
      body: { input: 'hi', threadId: 'grace-1' },
      cogitatorAuth: { userId: 'grace' },
    });

    const error = await Promise.resolve(routes.runAgent.handler(ctx)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(403);
  });

  test('throws 404 for an unknown agent', () => {
    const ctx = testCtx({
      params: { name: 'ghost' },
      body: { input: 'hi' },
      cogitatorAuth: undefined,
    });
    expect(() => routes.runAgent.handler(ctx)).toThrow(HttpError);
  });
});

describe('eventsOf', () => {
  test('yields events pushed before and after the reader waits', async () => {
    const gate = deferred<void>();
    const events = eventsOf<number>(new AbortController().signal, async (emit) => {
      emit(1);
      await gate.promise;
      emit(2);
    });

    const first = await events.next();
    setTimeout(() => gate.resolve(), 5);
    const rest: number[] = [];
    for await (const event of events) rest.push(event);

    expect(first.value).toBe(1);
    expect(rest).toEqual([2]);
  });

  test('rethrows the error of the task after draining its events', async () => {
    const seen: number[] = [];
    const failing = eventsOf<number>(new AbortController().signal, async (emit) => {
      emit(1);
      throw new Error('task failed');
    });

    const error = await (async () => {
      for await (const event of failing) seen.push(event);
    })().catch((e: unknown) => e);

    expect(seen).toEqual([1]);
    expect((error as Error).message).toBe('task failed');
  });

  test('ends at once when the signal aborts, without waiting for the task', async () => {
    const controller = new AbortController();
    const events = eventsOf<number>(controller.signal, () => new Promise<void>(() => undefined));

    setTimeout(() => controller.abort(), 5);
    const received: number[] = [];
    for await (const event of events) received.push(event);

    expect(received).toEqual([]);
  });

  test('ends at once for a signal that has already aborted', async () => {
    const events = eventsOf<number>(AbortSignal.abort(), async (emit) => emit(1));
    const received: number[] = [];
    for await (const event of events) received.push(event);
    expect(received).toEqual([]);
  });
});

describe('errors', () => {
  test('a missing optional package answers 501', async () => {
    const missing = Object.assign(new Error('Cannot find module'), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const error = await importOptional(() => Promise.reject(missing), '@cogitator-ai/swarms').catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(HttpError);
    expect(describeError(error)).toEqual({
      message: '@cogitator-ai/swarms is not installed: add it to use this endpoint',
      code: 'PACKAGE_NOT_INSTALLED',
      unexpected: false,
    });
  });

  test('an HttpError without a body is described by its status', () => {
    expect(describeError(new HttpError(404))).toEqual({
      message: 'Not Found',
      code: 'NOT_FOUND',
      unexpected: false,
    });
  });
});
