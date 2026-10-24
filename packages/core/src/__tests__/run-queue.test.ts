import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { MemoryEntry } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { RunQueue } from '../cogitator/run-queue';
import {
  answer,
  callTools,
  deferred,
  scriptedBackend,
  userTexts,
  type ScriptedTurn,
} from './helpers/scripted-backend';

function setup(turns: ScriptedTurn[], withMemory = false) {
  const scripted = scriptedBackend(turns);
  const cog = new Cogitator({
    llm: { backends: { mock: scripted.backend } },
    ...(withMemory && { memory: { adapter: 'memory' as const } }),
  });
  return { cog, ...scripted };
}

function blockingTool() {
  const started = deferred();
  const release = deferred();
  const execute = vi.fn(async ({ step }: { step: string }) => {
    started.resolve();
    await release.promise;
    return { done: step };
  });
  const work = tool({
    name: 'work',
    description: 'Does a step of work',
    parameters: z.object({ step: z.string() }),
    execute,
  });
  return { work, started, release, execute };
}

const plain = new Agent({ name: 'helper', model: 'mock/m', instructions: 'Help.' });

async function threadEntries(cog: Cogitator, threadId: string): Promise<MemoryEntry[]> {
  const memory = cog.memory;
  if (!memory) throw new Error('no memory');
  const entries = await memory.getEntries({ threadId });
  if (!entries.success) throw new Error(entries.error);
  return entries.data;
}

describe('RunQueue', () => {
  it('takes steering messages one at a time by default, injected ones always', () => {
    const queue = new RunQueue();
    queue.push('steer', 'a');
    queue.push('inject', 'b');
    queue.push('steer', 'c');
    expect(queue.takeForTurn().map((m) => m.content)).toEqual(['a', 'b']);
    expect(queue.takeForTurn().map((m) => m.content)).toEqual(['c']);
    expect(queue.takeForTurn()).toEqual([]);
  });

  it('takes every follow-up at once in all mode, and only once nothing steers', () => {
    const queue = new RunQueue({ followUp: 'all' });
    queue.push('followUp', 'x');
    queue.push('followUp', 'y');
    expect(queue.takeForTurn()).toEqual([]);
    expect(queue.takeAtStop().map((m) => m.content)).toEqual(['x', 'y']);
  });

  it('refuses messages once closed and keeps what was left', () => {
    const queue = new RunQueue();
    queue.push('followUp', 'later');
    expect(queue.close()).toEqual([{ kind: 'followUp', content: 'later' }]);
    expect(queue.push('steer', 'too late')).toBe(false);
    expect(queue.takeAtStop()).toEqual([]);
    expect(queue.pending).toEqual([{ kind: 'followUp', content: 'later' }]);
  });

  it('refuses an empty message and an unknown drain mode', () => {
    expect(() => new RunQueue().push('steer', '  ')).toThrow(/must not be empty/);
    expect(() => new RunQueue({ steering: 'some' as 'all' })).toThrow(/queue.steering/);
  });
});

describe('cogitator.start()', () => {
  it('returns what run() returns when nothing is queued', async () => {
    const { cog } = setup([answer('Hello.')]);
    const result = await cog.start(plain, { input: 'Hi' }).result;
    expect(result.output).toBe('Hello.');
    expect(result.undelivered).toBeUndefined();
    await cog.close();
  });

  it('merges a steering message after the tool calls of the step, which all run', async () => {
    const { work, started, release, execute } = blockingTool();
    const agent = new Agent({
      name: 'worker',
      model: 'mock/m',
      instructions: 'Work.',
      tools: [work],
    });
    const { cog, requests } = setup([
      callTools([
        { id: 'c1', name: 'work', arguments: { step: 'one' } },
        { id: 'c2', name: 'work', arguments: { step: 'two' } },
      ]),
      answer('Done, in metric.'),
    ]);

    const handle = cog.start(agent, { input: 'Do the work' });
    await started.promise;
    expect(handle.steer('Use metric units')).toBe(true);
    release.resolve();
    const result = await handle.result;

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.output).toBe('Done, in metric.');
    const second = requests[1].messages;
    const roles = second.slice(-3).map((m) => m.role);
    expect(roles).toEqual(['tool', 'tool', 'user']);
    expect(second.at(-1)?.content).toBe('Use metric units');
    await cog.close();
  });

  it('delivers a steering message queued before the first model call to that call', async () => {
    const gate = deferred();
    const { cog, requests } = setup([
      async () => {
        await gate.promise;
        return answer('ok');
      },
    ]);
    const handle = cog.start(plain, { input: 'Hi' });
    handle.steer('Answer in French');
    gate.resolve();
    await handle.result;
    expect(userTexts(requests[0]).at(-1)).toBe('Answer in French');
    await cog.close();
  });

  it('runs a follow-up only when the agent would stop, one at a time by default', async () => {
    const { cog, requests } = setup([answer('first'), answer('second'), answer('third')]);
    const handle = cog.start(plain, { input: 'Start' });
    handle.followUp('Then this');
    handle.followUp('And this');
    const result = await handle.result;

    expect(requests).toHaveLength(3);
    expect(userTexts(requests[0])).not.toContain('Then this');
    expect(userTexts(requests[1]).at(-1)).toBe('Then this');
    expect(userTexts(requests[2]).at(-1)).toBe('And this');
    expect(result.output).toBe('third');
    await cog.close();
  });

  it('takes every follow-up at once with followUp: all', async () => {
    const { cog, requests } = setup([answer('first'), answer('second')]);
    const handle = cog.start(plain, { input: 'Start', queue: { followUp: 'all' } });
    handle.followUp('One');
    handle.followUp('Two');
    await handle.result;
    expect(requests).toHaveLength(2);
    expect(userTexts(requests[1]).slice(-2)).toEqual(['One', 'Two']);
    await cog.close();
  });

  it('gives a follow-up its own iterations, past maxIterations', async () => {
    const agent = new Agent({
      name: 'short',
      model: 'mock/m',
      instructions: 'Hi.',
      maxIterations: 1,
    });
    const { cog, requests } = setup([answer('first'), answer('second')]);
    const handle = cog.start(agent, { input: 'Start' });
    handle.followUp('More');
    const result = await handle.result;
    expect(requests).toHaveLength(2);
    expect(result.output).toBe('second');
    expect(result.iterationLimitReached).toBeUndefined();
    await cog.close();
  });

  it('lands an injected message in the next model call without waking the agent', async () => {
    const { work, started, release } = blockingTool();
    const agent = new Agent({
      name: 'worker',
      model: 'mock/m',
      instructions: 'Work.',
      tools: [work],
    });
    const { cog, requests } = setup([
      callTools([{ id: 'c1', name: 'work', arguments: { step: 'one' } }]),
      answer('Done.'),
    ]);
    const handle = cog.start(agent, { input: 'Do it' });
    await started.promise;
    handle.inject('The user is in Berlin');
    release.resolve();
    const result = await handle.result;

    expect(requests).toHaveLength(2);
    expect(requests[1].messages.at(-1)?.content).toBe('The user is in Berlin');
    expect(result.output).toBe('Done.');
    await cog.close();
  });

  it('keeps an injected message the run had no model call left for in the thread', async () => {
    let handle: ReturnType<Cogitator['start']> | undefined;
    const { cog } = setup(
      [
        () => {
          handle?.inject('Remember the deadline');
          return answer('Noted.');
        },
      ],
      true
    );
    handle = cog.start(plain, { input: 'Hi', threadId: 'inject-thread' });
    const result = await handle.result;

    expect(result.undelivered).toBeUndefined();
    const entries = await threadEntries(cog, 'inject-thread');
    const kept = entries.find((entry) => entry.metadata?.queued === 'inject');
    expect(kept?.message).toEqual({ role: 'user', content: 'Remember the deadline' });
    expect(entries.at(-1)?.id).toBe(kept?.id);
    await cog.close();
  });

  it('saves delivered messages with metadata.queued, and a later run reads them as history', async () => {
    const { cog, requests } = setup([answer('first'), answer('second'), answer('third')], true);
    const handle = cog.start(plain, { input: 'Start', threadId: 'queued-thread' });
    handle.followUp('Follow this up');
    await handle.result;

    const entries = await threadEntries(cog, 'queued-thread');
    const queued = entries.filter((entry) => entry.metadata?.queued !== undefined);
    expect(queued.map((entry) => [entry.metadata?.queued, entry.message.content])).toEqual([
      ['followUp', 'Follow this up'],
    ]);

    await cog.run(plain, { input: 'Next', threadId: 'queued-thread' });
    expect(userTexts(requests[2])).toContain('Follow this up');
    await cog.close();
  });

  it('abort returns the messages the run did not deliver and refuses new ones', async () => {
    const { work, started } = blockingTool();
    const agent = new Agent({
      name: 'worker',
      model: 'mock/m',
      instructions: 'Work.',
      tools: [work],
    });
    const { cog } = setup([callTools([{ id: 'c1', name: 'work', arguments: { step: 'one' } }])]);
    const handle = cog.start(agent, { input: 'Do it' });
    await started.promise;
    handle.followUp('After that');
    handle.steer('Faster');

    const left = handle.abort(new Error('stop now'));

    expect(left).toEqual([
      { kind: 'followUp', content: 'After that' },
      { kind: 'steer', content: 'Faster' },
    ]);
    await expect(handle.result).rejects.toThrow('stop now');
    expect(handle.steer('too late')).toBe(false);
    await cog.close();
  });

  it('hands queued messages back in undelivered when the run pauses', async () => {
    const refund = tool({
      name: 'refund',
      description: 'Refund',
      parameters: z.object({ order: z.string() }),
      requiresApproval: true,
      execute: async () => 'ok',
    });
    const agent = new Agent({
      name: 'support',
      model: 'mock/m',
      instructions: 'Help.',
      tools: [refund],
    });
    let handle: ReturnType<Cogitator['start']> | undefined;
    const { cog } = setup([
      () => {
        handle?.followUp('And email them');
        return callTools([{ id: 'c1', name: 'refund', arguments: { order: 'A' } }]);
      },
    ]);
    handle = cog.start(agent, { input: 'Refund A' });
    const result = await handle.result;
    expect(result.status).toBe('paused');
    expect(result.undelivered).toEqual([{ kind: 'followUp', content: 'And email them' }]);
    await cog.close();
  });

  it('runs the first tool call of a follow-up even when it repeats the last one', async () => {
    const lookup = vi.fn(async () => 'found');
    const agent = new Agent({
      name: 'finder',
      model: 'mock/m',
      instructions: 'Find.',
      tools: [
        tool({
          name: 'lookup',
          description: 'Looks up',
          parameters: z.object({}),
          execute: lookup,
        }),
      ],
    });
    const { cog } = setup([
      callTools([{ id: 'l1', name: 'lookup', arguments: {} }]),
      answer('first'),
      callTools([{ id: 'l2', name: 'lookup', arguments: {} }]),
      answer('second'),
    ]);
    const handle = cog.start(agent, { input: 'Find it' });
    handle.followUp('Find it again');
    const result = await handle.result;
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(result.output).toBe('second');
    await cog.close();
  });

  it('saves nothing abort handed back, even when the abort comes after the last model turn', async () => {
    let handle: ReturnType<Cogitator['start']> | undefined;
    let left: readonly unknown[] = [];
    const { cog } = setup([answer('Done.')], true);
    handle = cog.start(plain, {
      input: 'Hi',
      threadId: 'late-abort',
      onModelTurn: () => {
        handle?.inject('Too late');
        left = handle?.abort() ?? [];
      },
    });
    await handle.result.catch(() => undefined);
    expect(left).toEqual([{ kind: 'inject', content: 'Too late' }]);
    const entries = await threadEntries(cog, 'late-abort');
    expect(entries.some((entry) => entry.metadata?.queued !== undefined)).toBe(false);
    expect(handle.queued).toEqual([]);
    await cog.close();
  });

  it('no longer lists an injected message once the run saved it', async () => {
    let handle: ReturnType<Cogitator['start']> | undefined;
    const { cog } = setup(
      [
        () => {
          handle?.inject('Keep this');
          return answer('Noted.');
        },
      ],
      true
    );
    handle = cog.start(plain, { input: 'Hi', threadId: 'saved-inject' });
    await handle.result;
    expect(handle.queued).toEqual([]);
    await cog.close();
  });

  it('refuses queued messages the input checks block, and the run goes on without them', async () => {
    const scripted = scriptedBackend([answer('first'), answer('second')]);
    const cog = new Cogitator({
      llm: { backends: { mock: scripted.backend } },
      memory: { adapter: 'memory' },
      security: { pii: { mode: 'block' } },
    });
    const heard: string[] = [];
    let handle: ReturnType<Cogitator['start']> | undefined;
    handle = cog.start(plain, {
      input: 'Hi',
      threadId: 'checked',
      onRefusedMessage: (refused) => heard.push(`${refused.kind}:${refused.error.message}`),
      onModelTurn: () => {
        if (scripted.requests.length === 1) handle?.inject('Reach me at ann@example.com');
      },
    });
    handle.steer('My email is ann@example.com');
    handle.followUp('Now say goodbye');
    const result = await handle.result;

    expect(result.output).toBe('second');
    expect(handle.refused.map((refused) => [refused.kind, refused.error.message])).toEqual([
      ['steer', 'The input contains personal data: email'],
      ['inject', 'The input contains personal data: email'],
    ]);
    expect(heard).toHaveLength(2);
    const sent = scripted.requests.flatMap((request) => userTexts(request)).join('\n');
    expect(sent).not.toContain('ann@example.com');
    const entries = await threadEntries(cog, 'checked');
    expect(entries.some((entry) => String(entry.message.content).includes('ann@'))).toBe(false);
    expect(handle.queued).toEqual([]);
    await cog.close();
  });

  it('gives each steering message its own model call in one-at-a-time mode', async () => {
    const { cog, requests } = setup([answer('one'), answer('two'), answer('three')]);
    const handle = cog.start(plain, { input: 'Start' });
    handle.steer('First');
    handle.steer('Second');
    handle.steer('Third');
    await handle.result;
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => userTexts(request).at(-1))).toEqual([
      'First',
      'Second',
      'Third',
    ]);
    await cog.close();
  });

  it('hands back a message abort catches while its input check runs', async () => {
    const checking = deferred();
    const never = new Promise<void>(() => undefined);
    const { cog } = setup([answer('one'), answer('two')], true);
    const handle = cog.start(plain, {
      input: 'Start',
      threadId: 'slow-check',
      middleware: [
        {
          name: 'slow-check',
          async beforeRun({ input }) {
            if (input !== 'Later') return;
            checking.resolve();
            await never;
          },
        },
      ],
    });
    handle.followUp('Later');
    await checking.promise;
    expect(handle.queued).toEqual([{ kind: 'followUp', content: 'Later' }]);
    expect(handle.abort(new Error('stop'))).toEqual([{ kind: 'followUp', content: 'Later' }]);
    await expect(handle.result).rejects.toThrow('stop');
    const entries = await threadEntries(cog, 'slow-check');
    expect(entries.some((entry) => entry.metadata?.queued !== undefined)).toBe(false);
    await cog.close();
  });

  it('does not go on for an injected message alone when the checks refuse the steering one', async () => {
    const scripted = scriptedBackend([answer('only'), answer('extra')]);
    const cog = new Cogitator({
      llm: { backends: { mock: scripted.backend } },
      memory: { adapter: 'memory' },
      security: { pii: { mode: 'block' } },
    });
    let handle: ReturnType<Cogitator['start']> | undefined;
    handle = cog.start(plain, {
      input: 'Hi',
      threadId: 'inject-alone',
      onModelTurn: () => {
        handle?.steer('Mail ann@example.com');
        handle?.inject('The user is in Berlin');
      },
    });
    const result = await handle.result;
    expect(scripted.requests).toHaveLength(1);
    expect(result.output).toBe('only');
    expect(handle.refused.map((refused) => refused.kind)).toEqual(['steer']);
    const entries = await threadEntries(cog, 'inject-alone');
    expect(entries.at(-1)?.message.content).toBe('The user is in Berlin');
    await cog.close();
  });
});
