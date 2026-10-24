import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { MemoryEntry } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { ABORTED_BEFORE_DISPATCH, OUTCOME_UNKNOWN } from '../utils/tool-history';
import {
  answer,
  callTools,
  deferred,
  scriptedBackend,
  type ScriptedTurn,
} from './helpers/scripted-backend';

function setup(turns: ScriptedTurn[]) {
  const scripted = scriptedBackend(turns);
  const cog = new Cogitator({
    llm: { backends: { mock: scripted.backend } },
    memory: { adapter: 'memory' },
  });
  return { cog, ...scripted };
}

async function entriesOf(cog: Cogitator, threadId: string): Promise<MemoryEntry[]> {
  const entries = await cog.memory!.getEntries({ threadId, includeToolCalls: true, types: 'all' });
  if (!entries.success) throw new Error(entries.error);
  return entries.data;
}

function toolResultsOf(entries: MemoryEntry[]) {
  return entries.flatMap((entry) => entry.toolResults ?? []);
}

const plain = new Agent({ name: 'writer', model: 'mock/m', instructions: 'Write.' });

describe('aborting a run', () => {
  it('keeps the text already streamed as an interrupted assistant message', async () => {
    const { cog, requests } = setup([{ stream: ['Hel', 'lo th'], thenWait: true }, answer('ok')]);
    const shown = deferred();
    const tokens: string[] = [];
    const controller = new AbortController();

    const run = cog.run(plain, {
      input: 'Greet me',
      threadId: 'partial',
      stream: true,
      signal: controller.signal,
      onToken: (token) => {
        tokens.push(token);
        if (tokens.length === 2) shown.resolve();
      },
    });
    await shown.promise;
    controller.abort(new Error('user stopped'));
    await expect(run).rejects.toThrow('user stopped');

    const entries = await entriesOf(cog, 'partial');
    const reply = entries.find((entry) => entry.message.role === 'assistant');
    expect(reply?.message.content).toBe('Hello th');
    expect(reply?.metadata?.interrupted).toBe(true);
    expect(entries.at(-1)?.type).toBe('interrupt');

    await cog.run(plain, { input: 'Go on', threadId: 'partial' });
    const history = requests[1].messages.filter((message) => message.role === 'assistant');
    expect(history.at(-1)?.content).toBe('Hello th [interrupted by the user]');
    await cog.close();
  });

  it('answers the calls it never started with aborted before dispatch', async () => {
    const started = deferred();
    const first = vi.fn(async () => {
      started.resolve();
      return new Promise<string>(() => undefined);
    });
    const second = vi.fn(async () => 'never');
    const agent = new Agent({
      name: 'worker',
      model: 'mock/m',
      instructions: 'Work.',
      tools: [
        tool({ name: 'first', description: 'First', parameters: z.object({}), execute: first }),
        tool({ name: 'second', description: 'Second', parameters: z.object({}), execute: second }),
      ],
    });
    const { cog, requests } = setup([
      callTools([
        { id: 'c1', name: 'first', arguments: {} },
        { id: 'c2', name: 'second', arguments: {} },
      ]),
      answer('Checked.'),
    ]);
    const controller = new AbortController();
    const run = cog.run(agent, { input: 'Work', threadId: 'dispatch', signal: controller.signal });
    await started.promise;
    controller.abort(new Error('stop'));
    await expect(run).rejects.toThrow('stop');

    expect(second).not.toHaveBeenCalled();
    const results = toolResultsOf(await entriesOf(cog, 'dispatch'));
    expect(results).toEqual([
      { callId: 'c2', name: 'second', result: null, error: ABORTED_BEFORE_DISPATCH },
    ]);

    await cog.run(agent, { input: 'What happened?', threadId: 'dispatch' });
    const sent = requests[1].messages.filter((message) => message.role === 'tool');
    expect(sent.map((message) => [message.toolCallId, message.content])).toEqual([
      ['c1', JSON.stringify({ error: OUTCOME_UNKNOWN })],
      ['c2', JSON.stringify({ error: ABORTED_BEFORE_DISPATCH })],
    ]);
    expect(toolResultsOf(await entriesOf(cog, 'dispatch')).map((r) => r.callId)).toEqual(['c2']);
    await cog.close();
  });

  it('saves the result of a call that finished before the abort', async () => {
    const blocked = deferred();
    const agent = new Agent({
      name: 'worker',
      model: 'mock/m',
      instructions: 'Work.',
      tools: [
        tool({
          name: 'fast',
          description: 'Fast',
          parameters: z.object({}),
          execute: async () => 'fast done',
        }),
        tool({
          name: 'slow',
          description: 'Slow',
          parameters: z.object({}),
          execute: async () => {
            blocked.resolve();
            return new Promise<string>(() => undefined);
          },
        }),
        tool({
          name: 'later',
          description: 'Later',
          parameters: z.object({}),
          execute: async () => 'later done',
        }),
      ],
    });
    const { cog } = setup([
      callTools([
        { id: 'a', name: 'fast', arguments: {} },
        { id: 'b', name: 'slow', arguments: {} },
        { id: 'c', name: 'later', arguments: {} },
      ]),
    ]);
    const controller = new AbortController();
    const run = cog.run(agent, { input: 'Work', threadId: 'mixed', signal: controller.signal });
    await blocked.promise;
    controller.abort(new Error('stop'));
    await expect(run).rejects.toThrow('stop');

    const results = toolResultsOf(await entriesOf(cog, 'mixed'));
    expect(results.map((result) => [result.callId, result.result, result.error])).toEqual([
      ['a', 'fast done', undefined],
      ['c', null, ABORTED_BEFORE_DISPATCH],
    ]);
    await cog.close();
  });

  it('never writes the late result of a tool that ignores the signal', async () => {
    const started = deferred();
    const release = deferred();
    const finished = deferred();
    const agent = new Agent({
      name: 'worker',
      model: 'mock/m',
      instructions: 'Work.',
      tools: [
        tool({
          name: 'stubborn',
          description: 'Ignores the signal',
          parameters: z.object({}),
          execute: async () => {
            started.resolve();
            await release.promise;
            finished.resolve();
            return 'late';
          },
        }),
      ],
    });
    const { cog } = setup([callTools([{ id: 's1', name: 'stubborn', arguments: {} }])]);
    const controller = new AbortController();
    const run = cog.run(agent, { input: 'Work', threadId: 'late', signal: controller.signal });
    await started.promise;
    controller.abort(new Error('stop'));
    await expect(run).rejects.toThrow('stop');
    const before = await entriesOf(cog, 'late');

    release.resolve();
    await finished.promise;
    await new Promise((resolve) => setImmediate(resolve));

    const after = await entriesOf(cog, 'late');
    expect(after).toHaveLength(before.length);
    expect(toolResultsOf(after)).toEqual([]);
    await cog.close();
  });

  it('leaves the streamed text to the caller with saveInterruptedReply: false', async () => {
    const { cog } = setup([{ stream: ['Hel', 'lo'], thenWait: true }]);
    const shown = deferred();
    const controller = new AbortController();
    const run = cog.run(plain, {
      input: 'Greet me',
      threadId: 'own-reply',
      stream: true,
      saveInterruptedReply: false,
      signal: controller.signal,
      onToken: () => shown.resolve(),
    });
    await shown.promise;
    controller.abort(new Error('barge-in'));
    await expect(run).rejects.toThrow('barge-in');
    const entries = await entriesOf(cog, 'own-reply');
    expect(entries.some((entry) => entry.message.role === 'assistant')).toBe(false);
    await cog.close();
  });
});
