import { describe, expect, spyOn, test } from 'bun:test';
import { createApp, group } from '@tetsujs/core';
import { serve } from '@tetsujs/core/testing';
import { Agent } from '@cogitator-ai/core';
import { Swarm } from '@cogitator-ai/swarms';
import { WorkflowBuilder, WorkflowExecutor } from '@cogitator-ai/workflows';
import type { Workflow, WorkflowState } from '@cogitator-ai/types';
import { cogitatorController } from '../index.js';
import type { CogitatorDeps } from '../index.js';
import { chatAgent, deferred, fakeCogitator, json } from './helpers.js';

function serveCogitator(deps: CogitatorDeps) {
  return serve(
    createApp({ routes: group('/cogitator', { children: [cogitatorController(deps)] }) })
  );
}

/** Waits for `signal` to be aborted, the way a run notices its client went away */
async function abortedSoon(signal: AbortSignal): Promise<boolean> {
  for (let i = 0; i < 100 && !signal.aborted; i++) await Bun.sleep(10);
  return signal.aborted;
}

/** A run that holds until its signal is aborted, handing the signal over once it started */
function heldRun(started: ReturnType<typeof deferred<AbortSignal>>) {
  return (signal: AbortSignal | undefined) =>
    new Promise<never>((_resolve, reject) => {
      if (!signal) return;
      started.resolve(signal);
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
}

/** Sends a JSON request, then goes away once the run started */
async function leaveDuring(
  request: ReturnType<typeof serveCogitator>,
  path: string,
  body: unknown,
  started: Promise<unknown>
): Promise<void> {
  const client = new AbortController();
  const answer = request(path, { ...json(body), signal: client.signal }).catch(() => undefined);
  await started;
  client.abort();
  await answer;
}

const team = {
  name: 'team',
  strategy: 'round-robin' as const,
  agents: [new Agent({ name: 'alpha', model: 'ollama/qwen3:0.6b', instructions: 'Hi.' })],
};

function steps(): Workflow<WorkflowState> {
  return new WorkflowBuilder('steps')
    .addNode('one', async () => ({ output: 'done' }))
    .build() as unknown as Workflow<WorkflowState>;
}

describe('a JSON run whose client goes away', () => {
  test('aborts an agent run', async () => {
    const started = deferred<AbortSignal>();
    const hold = heldRun(started);
    const { cogitator } = fakeCogitator((_agent, options) => hold(options.signal));
    const request = serveCogitator({ cogitator, agents: { chat: chatAgent() } });

    await leaveDuring(request, '/cogitator/agents/chat/run', { input: 'hi' }, started.promise);

    expect(await abortedSoon(await started.promise)).toBe(true);
  });

  test('aborts a resume', async () => {
    const started = deferred<AbortSignal>();
    const hold = heldRun(started);
    const { cogitator } = fakeCogitator(undefined, undefined, (_agent, _thread, options) =>
      hold(options.signal)
    );
    const request = serveCogitator({ cogitator, agents: { chat: chatAgent() } });

    await leaveDuring(
      request,
      '/cogitator/agents/chat/resume',
      { threadId: 'thread-1', defaultDecision: { approved: true } },
      started.promise
    );

    expect(await abortedSoon(await started.promise)).toBe(true);
  });

  test('aborts a workflow run', async () => {
    const started = deferred<AbortSignal>();
    const hold = heldRun(started);
    const execute = spyOn(WorkflowExecutor.prototype, 'execute').mockImplementation(
      (_workflow, _input, options) => hold(options?.signal)
    );
    try {
      const request = serveCogitator({
        cogitator: fakeCogitator().cogitator,
        workflows: { steps: steps() },
      });

      await leaveDuring(
        request,
        '/cogitator/workflows/steps/run',
        { input: { topic: 'x' } },
        started.promise
      );

      expect(await abortedSoon(await started.promise)).toBe(true);
    } finally {
      execute.mockRestore();
    }
  });

  test('aborts a swarm run', async () => {
    const started = deferred<void>();
    let failRun: (error: Error) => void = () => undefined;
    const swarmRun = spyOn(Swarm.prototype, 'run').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failRun = reject;
          started.resolve();
        })
    );
    const abort = spyOn(Swarm.prototype, 'abort').mockImplementation(() => {
      failRun(new Error('aborted'));
    });
    try {
      const request = serveCogitator({ cogitator: fakeCogitator().cogitator, swarms: { team } });

      await leaveDuring(request, '/cogitator/swarms/team/run', { input: 'go' }, started.promise);

      for (let i = 0; i < 100 && abort.mock.calls.length === 0; i++) await Bun.sleep(10);
      expect(abort).toHaveBeenCalledTimes(1);
    } finally {
      swarmRun.mockRestore();
      abort.mockRestore();
    }
  });
});
