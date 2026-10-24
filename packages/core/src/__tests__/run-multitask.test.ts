import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import type { ChatRequest, ChatResponse, CogitatorConfig, LLMBackend } from '@cogitator-ai/types';
import { ErrorCode } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { abortReason, answer, callTools, deferred, userTexts } from './helpers/scripted-backend';

type Reply = (request: ChatRequest) => ChatResponse | Promise<ChatResponse>;

/** A backend that answers by the last user message, `fallback` for any it has no reply for */
function byInput(replies: Record<string, Reply>) {
  const requests: ChatRequest[] = [];
  const backend: LLMBackend = {
    provider: 'openai',
    chat: async (request) => {
      requests.push({ ...request, messages: [...request.messages] });
      const last = userTexts(request).at(-1) ?? '';
      const key = Object.keys(replies).find((input) => last.includes(input));
      return key ? replies[key](request) : answer(`echo ${last}`);
    },
    async *chatStream() {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    },
  };
  return { backend, requests };
}

function cogitator(backend: LLMBackend, config: CogitatorConfig = {}) {
  return new Cogitator({
    ...config,
    llm: { backends: { mock: backend } },
    memory: { adapter: 'memory' },
  });
}

const agent = new Agent({ name: 'chat', model: 'mock/m', instructions: 'Chat.' });

/** A reply that tells when the model call began and waits for `release`, or for an abort */
function heldReply(events: string[], name: string) {
  const began = deferred();
  const release = deferred();
  const reply: Reply = async (request) => {
    events.push(`${name}-start`);
    began.resolve();
    await new Promise<void>((resolve, reject) => {
      void release.promise.then(resolve);
      request.signal?.addEventListener('abort', () => reject(abortReason(request.signal)), {
        once: true,
      });
    });
    events.push(`${name}-end`);
    return answer(`${name} done`);
  };
  return { reply, began, release };
}

describe('runs of one thread at once', () => {
  it('go on side by side without a strategy, as they always did', async () => {
    const events: string[] = [];
    const first = heldReply(events, 'first');
    const { backend } = byInput({
      'first question': first.reply,
      'second question': () => {
        events.push('second-start');
        return answer('second done');
      },
    });
    const cog = cogitator(backend);
    const running = cog.run(agent, { input: 'first question', threadId: 't' });
    await first.began.promise;
    const second = await cog.run(agent, { input: 'second question', threadId: 't' });
    first.release.resolve();
    await running;
    expect(second.output).toBe('second done');
    expect(events).toEqual(['first-start', 'second-start', 'first-end']);
    await cog.close();
  });

  it('enqueue waits for the run going on, then runs', async () => {
    const events: string[] = [];
    const first = heldReply(events, 'first');
    const { backend } = byInput({
      'first question': first.reply,
      'second question': () => {
        events.push('second-start');
        return answer('second done');
      },
    });
    const cog = cogitator(backend);
    const running = cog.run(agent, { input: 'first question', threadId: 't' });
    await first.began.promise;
    const queued = cog.run(agent, {
      input: 'second question',
      threadId: 't',
      multitaskStrategy: 'enqueue',
    });
    first.release.resolve();
    await running;
    expect((await queued).output).toBe('second done');
    expect(events).toEqual(['first-start', 'first-end', 'second-start']);
    await cog.close();
  });

  it('takes the strategy of the config when the run sets none', async () => {
    const events: string[] = [];
    const first = heldReply(events, 'first');
    const { backend } = byInput({ 'first question': first.reply });
    const cog = cogitator(backend, { multitaskStrategy: 'reject' });
    const running = cog.run(agent, { input: 'first question', threadId: 't' });
    await first.began.promise;
    await expect(cog.run(agent, { input: 'other', threadId: 't' })).rejects.toMatchObject({
      code: ErrorCode.THREAD_BUSY,
    });
    const elsewhere = await cog.run(agent, { input: 'other', threadId: 'u' });
    expect(elsewhere.output).toBe('echo other');
    first.release.resolve();
    await running;
    expect((await cog.run(agent, { input: 'later', threadId: 't' })).output).toBe('echo later');
    await cog.close();
  });

  it('interrupt stops the run going on, which fails with RUN_INTERRUPTED', async () => {
    const events: string[] = [];
    const first = heldReply(events, 'first');
    const { backend } = byInput({ 'first question': first.reply });
    const cog = cogitator(backend);
    const running = cog.run(agent, { input: 'first question', threadId: 't' });
    await first.began.promise;
    const stopped = expect(running).rejects.toMatchObject({ code: ErrorCode.RUN_INTERRUPTED });
    const newer = await cog.run(agent, {
      input: 'newer',
      threadId: 't',
      multitaskStrategy: 'interrupt',
    });
    await stopped;
    expect(newer.output).toBe('echo newer');
    await cog.close();
  });

  it('rollback runs on a branch from where the interrupted run started', async () => {
    const events: string[] = [];
    const first = heldReply(events, 'first');
    const { backend, requests } = byInput({ 'first question': first.reply });
    const cog = cogitator(backend);
    await cog.run(agent, { input: 'hello', threadId: 't' });
    const running = cog.run(agent, { input: 'first question', threadId: 't' });
    await first.began.promise;
    const stopped = expect(running).rejects.toMatchObject({ code: ErrorCode.RUN_INTERRUPTED });

    const newer = await cog.run(agent, {
      input: 'instead',
      threadId: 't',
      multitaskStrategy: 'rollback',
    });
    await stopped;

    const sent = userTexts(requests.at(-1)!).join('\n');
    expect(sent).toContain('hello');
    expect(sent).not.toContain('first question');
    expect(newer.memory?.branchPoint).not.toBeNull();

    await cog.run(agent, { input: 'after', threadId: 't' });
    const later = userTexts(requests.at(-1)!).join('\n');
    expect(later).toContain('instead');
    expect(later).not.toContain('first question');

    const all = await cog.memory!.getEntries({ threadId: 't' });
    expect(
      all.success && all.data.some((entry) => entry.message.content === 'first question')
    ).toBe(true);
    await cog.close();
  });

  it('never holds back a run started from a tool of the run going on', async () => {
    const { backend } = byInput({
      'outer question': (request) =>
        request.messages.some((message) => message.role === 'tool')
          ? answer('outer done')
          : callTools([{ id: 'n1', name: 'nested', arguments: {} }]),
    });
    const cog = cogitator(backend, { multitaskStrategy: 'enqueue' });
    const nested = tool({
      name: 'nested',
      description: 'Runs the agent again on the thread',
      parameters: z.object({}),
      execute: async () =>
        (await cog.run(inner, { input: 'inner question', threadId: 't' })).output,
    });
    const inner = new Agent({ name: 'inner', model: 'mock/m', instructions: 'x' });
    const outer = new Agent({ name: 'outer', model: 'mock/m', instructions: 'x', tools: [nested] });

    const result = await cog.run(outer, { input: 'outer question', threadId: 't' });
    expect(result.output).toBe('outer done');
    await cog.close();
  });

  it('lets a waiting run leave the queue when its signal aborts', async () => {
    const events: string[] = [];
    const first = heldReply(events, 'first');
    const { backend } = byInput({ 'first question': first.reply });
    const cog = cogitator(backend, { multitaskStrategy: 'enqueue' });
    const running = cog.run(agent, { input: 'first question', threadId: 't' });
    await first.began.promise;
    const controller = new AbortController();
    const waiting = cog.run(agent, { input: 'second', threadId: 't', signal: controller.signal });
    controller.abort(new Error('gave up'));
    await expect(waiting).rejects.toThrow('gave up');
    first.release.resolve();
    await running;
    expect(events).toEqual(['first-start', 'first-end']);
    await cog.close();
  });

  it('refuses a stranger before it touches the run going on in the thread', async () => {
    const events: string[] = [];
    const first = heldReply(events, 'first');
    const { backend } = byInput({ 'first question': first.reply });
    const cog = cogitator(backend);
    const alice = cog.run(agent, { input: 'first question', threadId: 't', userId: 'alice' });
    await first.began.promise;

    for (const multitaskStrategy of ['interrupt', 'rollback', 'reject', 'enqueue'] as const) {
      await expect(
        cog.run(agent, { input: 'mine now', threadId: 't', userId: 'bob', multitaskStrategy })
      ).rejects.toMatchObject({ code: ErrorCode.THREAD_ACCESS_DENIED });
    }
    first.release.resolve();
    expect((await alice).output).toBe('first done');
    await cog.close();
  });

  it('refuses a stranger on a thread whose run has not written anything yet', async () => {
    const events: string[] = [];
    const first = heldReply(events, 'first');
    const { backend } = byInput({ 'first question': first.reply });
    const cog = cogitator(backend);
    const alice = cog.run(agent, { input: 'first question', threadId: 'fresh', userId: 'alice' });
    await expect(
      cog.run(agent, {
        input: 'mine',
        threadId: 'fresh',
        userId: 'mallory',
        multitaskStrategy: 'interrupt',
      })
    ).rejects.toMatchObject({ code: ErrorCode.THREAD_ACCESS_DENIED });
    await first.began.promise;
    first.release.resolve();
    expect((await alice).output).toBe('first done');
    await cog.close();
  });

  it('changes nothing for a run whose signal aborted before it asked for its thread', async () => {
    const events: string[] = [];
    const first = heldReply(events, 'first');
    const { backend } = byInput({ 'first question': first.reply });
    const cog = cogitator(backend);
    const running = cog.run(agent, { input: 'first question', threadId: 't' });
    await first.began.promise;
    const controller = new AbortController();
    controller.abort(new Error('never mind'));
    await expect(
      cog.run(agent, {
        input: 'newer',
        threadId: 't',
        signal: controller.signal,
        multitaskStrategy: 'interrupt',
      })
    ).rejects.toThrow('never mind');
    first.release.resolve();
    expect((await running).output).toBe('first done');
    await cog.close();
  });
});
