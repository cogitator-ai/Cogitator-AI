import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { MemoryEntry, RunCheckpoint, ToolContext } from '@cogitator-ai/types';
import { ErrorCode } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { fromAgentWireRunResult, toAgentWireRunResult } from '../agent-wire';
import { AgentRunPausedError } from '../run-pause';
import { answer, callTools, scriptedBackend, type ScriptedTurn } from './helpers/scripted-backend';

const roundTrip = (checkpoint: RunCheckpoint | undefined): RunCheckpoint =>
  JSON.parse(JSON.stringify(checkpoint)) as RunCheckpoint;

function echoTools(): ScriptedTurn {
  return (request) =>
    answer(
      request.messages
        .filter((message) => message.role === 'tool')
        .map((message) => String(message.content))
        .join(' | ')
    );
}

function setup(turns: ScriptedTurn[]) {
  const scripted = scriptedBackend(turns);
  const cog = new Cogitator({
    llm: { backends: { mock: scripted.backend } },
    memory: { adapter: 'memory' },
  });
  return { cog, ...scripted };
}

async function eventsOf(cog: Cogitator, threadId: string): Promise<MemoryEntry[]> {
  const entries = await cog.memory!.getEntries({ threadId, types: 'all' });
  if (!entries.success) throw new Error(entries.error);
  return entries.data.filter((entry) => entry.type === 'interrupt');
}

const confirmImpl = vi.fn(async ({ plan }: { plan: string }, context: ToolContext) => {
  const reply = await context.interrupt!({
    reason: 'confirm_plan',
    message: `Go ahead with ${plan}?`,
    responseSchema: z.object({ ok: z.boolean(), note: z.string().optional() }),
  });
  return { plan, ok: reply.ok, note: reply.note ?? null };
});
const confirm = tool({
  name: 'confirm',
  description: 'Asks the user to confirm a plan',
  parameters: z.object({ plan: z.string() }),
  execute: confirmImpl,
});

const lookupImpl = vi.fn(async () => 'looked up');
const lookup = tool({
  name: 'lookup',
  description: 'Looks something up',
  parameters: z.object({}),
  execute: lookupImpl,
});

const planner = new Agent({
  name: 'planner',
  model: 'mock/m',
  instructions: 'Plan.',
  tools: [confirm, lookup],
});

const confirmCall = { id: 'c1', name: 'confirm', arguments: { plan: 'the migration' } };

describe('interrupts from tools', () => {
  it('pauses the run with the question, its schema and a checkpoint', async () => {
    confirmImpl.mockClear();
    const { cog } = setup([callTools([confirmCall], 'Let me ask.'), echoTools()]);

    const paused = await cog.run(planner, { input: 'Migrate', threadId: 'ask' });

    expect(paused.status).toBe('paused');
    expect(paused.output).toBe('Let me ask.');
    expect(paused.pendingApprovals).toEqual([]);
    expect(paused.interrupts).toEqual([
      {
        id: 'c1#0',
        kind: 'input',
        reason: 'confirm_plan',
        message: 'Go ahead with the migration?',
        responseSchema: expect.objectContaining({
          type: 'object',
          required: ['ok'],
        }),
        toolCallId: 'c1',
        toolName: 'confirm',
      },
    ]);
    expect(paused.checkpoint?.version).toBe(1);
    expect(paused.checkpoint?.interrupts).toEqual(paused.interrupts);
    const overWire = fromAgentWireRunResult(
      JSON.parse(JSON.stringify(toAgentWireRunResult(paused))),
      { agentId: planner.id }
    );
    expect(overWire.interrupts).toEqual(paused.interrupts);
    expect(new AgentRunPausedError(paused, 'planner').message).toContain(
      'to wait for answers to confirm_plan'
    );
    const [event] = await eventsOf(cog, 'ask');
    expect(event.event).toMatchObject({
      status: 'paused',
      interrupts: [{ id: 'c1#0', kind: 'input', reason: 'confirm_plan' }],
    });
    await cog.close();
  });

  it('goes on with the answer, parsed by the schema, and logs the resume', async () => {
    confirmImpl.mockClear();
    const { cog } = setup([callTools([confirmCall]), echoTools()]);
    const paused = await cog.run(planner, { input: 'Migrate', threadId: 'answer' });

    const result = await cog.resume(planner, roundTrip(paused.checkpoint), {
      responses: { 'c1#0': { ok: true, note: 'after 6pm' } },
    });

    expect(result.status).toBe('completed');
    expect(result.output).toBe('{"plan":"the migration","ok":true,"note":"after 6pm"}');
    expect(confirmImpl).toHaveBeenCalledTimes(2);
    const events = await eventsOf(cog, 'answer');
    expect(events.map((entry) => entry.event?.status)).toEqual(['paused', 'resumed']);
    expect(events[1].event).toMatchObject({
      interrupts: [{ id: 'c1#0', response: { ok: true, note: 'after 6pm' } }],
    });
    await cog.close();
  });

  it('resumes by thread id from the checkpoint store', async () => {
    const { cog } = setup([callTools([confirmCall]), echoTools()]);
    await cog.run(planner, { input: 'Migrate', threadId: 'by-thread' });
    const result = await cog.resume(planner, 'by-thread', {
      responses: { 'c1#0': { ok: false } },
    });
    expect(result.output).toContain('"ok":false');
    await cog.close();
  });

  it('refuses an answer that does not match the schema, and runs nothing', async () => {
    confirmImpl.mockClear();
    const { cog } = setup([callTools([confirmCall]), echoTools()]);
    const paused = await cog.run(planner, { input: 'Migrate' });

    await expect(
      cog.resume(planner, paused.checkpoint!, { responses: { 'c1#0': { ok: 'yes' } } })
    ).rejects.toMatchObject({ code: ErrorCode.INTERRUPT_ANSWER_INVALID });
    expect(confirmImpl).toHaveBeenCalledTimes(1);
    await cog.close();
  });

  it('refuses an answer to an interrupt the run does not wait on', async () => {
    const { cog } = setup([callTools([confirmCall]), echoTools()]);
    const paused = await cog.run(planner, { input: 'Migrate' });
    await expect(
      cog.resume(planner, paused.checkpoint!, { responses: { nope: true } })
    ).rejects.toThrow(/no interrupt "nope"/);
    await cog.close();
  });

  it('refuses an answer after the interrupt expired', async () => {
    const hurried = tool({
      name: 'hurried',
      description: 'Asks with a deadline already gone',
      parameters: z.object({}),
      execute: async (_params, context) =>
        context.interrupt!({ reason: 'now', message: 'Now?', expiresAt: new Date(0) }),
    });
    const agent = new Agent({ name: 'a', model: 'mock/m', instructions: 'x', tools: [hurried] });
    const { cog } = setup([callTools([{ id: 'h1', name: 'hurried', arguments: {} }]), echoTools()]);
    const paused = await cog.run(agent, { input: 'Go' });
    expect(paused.interrupts?.[0]?.expiresAt).toBe('1970-01-01T00:00:00.000Z');

    await expect(
      cog.resume(agent, paused.checkpoint!, { responses: { 'h1#0': 'yes' } })
    ).rejects.toMatchObject({ code: ErrorCode.INTERRUPT_EXPIRED });
    await cog.close();
  });

  it('asks again for each later question, and keeps earlier answers', async () => {
    const answers: unknown[] = [];
    const twice = tool({
      name: 'twice',
      description: 'Asks two questions',
      parameters: z.object({}),
      execute: async (_params, context) => {
        const name = await context.interrupt!({ reason: 'name', message: 'Name?' });
        const age = await context.interrupt!({ reason: 'age', message: 'Age?' });
        answers.push([name, age]);
        return `${String(name)} ${String(age)}`;
      },
    });
    const agent = new Agent({ name: 'a', model: 'mock/m', instructions: 'x', tools: [twice] });
    const { cog } = setup([callTools([{ id: 't1', name: 'twice', arguments: {} }]), echoTools()]);

    const first = await cog.run(agent, { input: 'Go' });
    const second = await cog.resume(agent, roundTrip(first.checkpoint), {
      responses: { 't1#0': 'Ada' },
    });
    expect(second.status).toBe('paused');
    expect(second.interrupts?.map((entry) => entry.id)).toEqual(['t1#1']);
    expect(second.checkpoint?.interrupts?.map((entry) => entry.id)).toEqual(['t1#0', 't1#1']);

    const done = await cog.resume(agent, roundTrip(second.checkpoint), {
      responses: { 't1#1': 36 },
    });
    expect(done.output).toBe('"Ada 36"');
    expect(answers).toEqual([['Ada', 36]]);
    await cog.close();
  });

  it('keeps the results of the turn calls that finished, and runs only the asking one again', async () => {
    lookupImpl.mockClear();
    confirmImpl.mockClear();
    const { cog } = setup([
      callTools([{ id: 'l1', name: 'lookup', arguments: {} }, confirmCall]),
      echoTools(),
    ]);
    const paused = await cog.run(planner, { input: 'Migrate' });
    expect(paused.checkpoint?.turn.toolCalls.map((call) => call.id)).toEqual(['l1', 'c1']);
    expect(paused.checkpoint?.turn.completed).toEqual(['l1']);

    const result = await cog.resume(planner, roundTrip(paused.checkpoint), {
      responses: { 'c1#0': { ok: true } },
    });
    expect(lookupImpl).toHaveBeenCalledTimes(1);
    expect(result.output).toBe('"looked up" | {"plan":"the migration","ok":true,"note":null}');
    await cog.close();
  });

  it('answers the waiting call when the user moves on with a new message', async () => {
    const { cog, requests } = setup([callTools([confirmCall]), echoTools()]);
    await cog.run(planner, { input: 'Migrate', threadId: 'moved-on' });
    await cog.run(planner, { input: 'Never mind', threadId: 'moved-on' });
    const tools = requests[1].messages.filter((message) => message.role === 'tool');
    expect(tools.map((message) => message.content)).toEqual([
      JSON.stringify({
        error: 'The user moved on without answering: Go ahead with the migration?',
      }),
    ]);
    await cog.close();
  });
});

describe('approvals as interrupts', () => {
  const refundImpl = vi.fn(async () => 'refunded');
  const refund = tool({
    name: 'refund',
    description: 'Refund an order',
    parameters: z.object({ order: z.string() }),
    requiresApproval: true,
    execute: refundImpl,
  });
  const support = new Agent({ name: 's', model: 'mock/m', instructions: 'x', tools: [refund] });
  const refundCall = { id: 'r1', name: 'refund', arguments: { order: 'A' } };

  it('lists a pending approval as an approval interrupt keyed by the tool call', async () => {
    const { cog } = setup([callTools([refundCall]), echoTools()]);
    const paused = await cog.run(support, { input: 'Refund A' });
    expect(paused.pendingApprovals?.map((request) => request.toolCallId)).toEqual(['r1']);
    expect(paused.interrupts).toEqual([
      expect.objectContaining({
        id: 'r1',
        kind: 'approval',
        reason: 'tool_approval',
        toolCallId: 'r1',
        toolName: 'refund',
      }),
    ]);
    await cog.close();
  });

  it('takes a decision as the answer to an approval interrupt', async () => {
    refundImpl.mockClear();
    const { cog } = setup([callTools([refundCall]), echoTools()]);
    const paused = await cog.run(support, { input: 'Refund A' });
    const result = await cog.resume(support, roundTrip(paused.checkpoint), {
      responses: { r1: { approved: true } },
    });
    expect(result.status).toBe('completed');
    expect(refundImpl).toHaveBeenCalledTimes(1);
    await cog.close();
  });

  it('answers approvals of a checkpoint saved before interrupts existed', async () => {
    refundImpl.mockClear();
    const { cog } = setup([callTools([refundCall]), echoTools()]);
    const paused = await cog.run(support, { input: 'Refund A' });
    const legacy = roundTrip(paused.checkpoint);
    delete legacy.interrupts;
    const result = await cog.resume(support, legacy, {
      responses: { r1: { approved: false, reason: 'too much' } },
    });
    expect(result.output).toContain('The user declined this tool call: too much');
    expect(refundImpl).not.toHaveBeenCalled();
    await cog.close();
  });
});

describe('interrupts in a turn of several calls', () => {
  it('runs nothing after the asking call in sequential mode until the answer comes', async () => {
    const deleteAll = vi.fn(async () => 'deleted');
    const agent = new Agent({
      name: 'a',
      model: 'mock/m',
      instructions: 'x',
      tools: [
        confirm,
        tool({
          name: 'delete_all',
          description: 'Deletes',
          parameters: z.object({}),
          execute: deleteAll,
        }),
      ],
    });
    const { cog, requests } = setup([
      callTools([confirmCall, { id: 'd1', name: 'delete_all', arguments: {} }]),
      echoTools(),
    ]);
    const paused = await cog.run(agent, { input: 'Clean up', threadId: 'seq' });
    expect(paused.status).toBe('paused');
    expect(deleteAll).not.toHaveBeenCalled();

    const result = await cog.resume(agent, roundTrip(paused.checkpoint), {
      responses: { 'c1#0': { ok: true } },
    });
    expect(deleteAll).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('completed');
    const sent = requests.at(-1)!.messages.filter((message) => message.role === 'tool');
    expect(sent.map((message) => message.toolCallId)).toEqual(['c1', 'd1']);
  });

  it('tells calls that never ran why when the user moves on', async () => {
    const deleteAll = tool({
      name: 'delete_all',
      description: 'Deletes',
      parameters: z.object({}),
      execute: async () => 'deleted',
    });
    const agent = new Agent({
      name: 'a',
      model: 'mock/m',
      instructions: 'x',
      tools: [confirm, deleteAll],
    });
    const { cog, requests } = setup([
      callTools([confirmCall, { id: 'd1', name: 'delete_all', arguments: {} }]),
      echoTools(),
    ]);
    await cog.run(agent, { input: 'Clean up', threadId: 'moved-on-seq' });
    await cog.run(agent, { input: 'Forget it', threadId: 'moved-on-seq' });
    const sent = requests.at(-1)!.messages.filter((message) => message.role === 'tool');
    expect(sent.map((message) => message.content)).toEqual([
      JSON.stringify({
        error: 'The user moved on without answering: Go ahead with the migration?',
      }),
      JSON.stringify({
        error:
          'Not started: the user moved on while an earlier tool call of this step waited for an answer',
      }),
    ]);
  });

  it('hands over after the resume when a finished call of the turn was a handoff', async () => {
    const specialist = new Agent({ name: 'specialist', model: 'mock/m', instructions: 'Expert.' });
    const triage = new Agent({
      name: 'triage',
      model: 'mock/m',
      instructions: 'Route.',
      tools: [confirm],
      handoffs: [specialist],
    });
    const { cog } = setup([
      callTools([{ id: 'h1', name: 'transfer_to_specialist', arguments: {} }, confirmCall]),
      answer('From the specialist.'),
    ]);
    const paused = await cog.run(triage, { input: 'Help', threadId: 'handoff' });
    expect(paused.status).toBe('paused');
    expect(paused.handoffs).toBeUndefined();

    const result = await cog.resume(triage, roundTrip(paused.checkpoint), {
      responses: { 'c1#0': { ok: true } },
    });
    expect(result.finalAgent).toBe('specialist');
    expect(result.handoffs).toEqual([{ from: 'triage', to: 'specialist' }]);
  });

  it('keeps an unanswered question as it was asked, and does not run its tool again', async () => {
    let asks = 0;
    const late = tool({
      name: 'late',
      description: 'Asks with a deadline',
      parameters: z.object({}),
      execute: async (_params, context) => {
        asks++;
        return context.interrupt!({
          reason: 'when',
          message: 'When?',
          expiresAt: asks === 1 ? '2999-01-01T00:00:00.000Z' : '2000-01-01T00:00:00.000Z',
        });
      },
    });
    const agent = new Agent({ name: 'a', model: 'mock/m', instructions: 'x', tools: [late] });
    const { cog } = setup([callTools([{ id: 'w1', name: 'late', arguments: {} }]), echoTools()]);
    const first = await cog.run(agent, { input: 'Go' });

    const again = await cog.resume(agent, roundTrip(first.checkpoint), {});
    expect(again.status).toBe('paused');
    expect(again.interrupts).toEqual(first.interrupts);
    expect(asks).toBe(1);
  });

  it('answers an expired question nobody answered with an error, instead of pausing on it', async () => {
    const parallelAsk = (id: string, expiresAt: string) =>
      tool({
        name: `ask_${id}`,
        description: 'Asks',
        parameters: z.object({}),
        isConcurrencySafe: true,
        execute: async (_params, context) =>
          context.interrupt!({ reason: id, message: `Question ${id}?`, expiresAt }),
      });
    const agent = new Agent({
      name: 'a',
      model: 'mock/m',
      instructions: 'x',
      tools: [
        parallelAsk('one', '2999-01-01T00:00:00.000Z'),
        parallelAsk('two', '2000-01-01T00:00:00.000Z'),
      ],
    });
    const { cog, requests } = setup([
      callTools([
        { id: 'q1', name: 'ask_one', arguments: {} },
        { id: 'q2', name: 'ask_two', arguments: {} },
      ]),
      echoTools(),
    ]);
    const paused = await cog.run(agent, { input: 'Go', parallelToolCalls: true });
    expect(paused.interrupts?.map((entry) => entry.id)).toEqual(['q1#0', 'q2#0']);

    const done = await cog.resume(agent, roundTrip(paused.checkpoint), {
      parallelToolCalls: true,
      responses: { 'q1#0': 'yes' },
    });
    expect(done.status).toBe('completed');
    const sent = requests.at(-1)!.messages.filter((message) => message.role === 'tool');
    expect(sent.map((message) => message.content)).toEqual([
      '"yes"',
      JSON.stringify({
        error: 'Nobody answered "Question two?" before it expired at 2000-01-01T00:00:00.000Z',
      }),
    ]);
  });
});

describe('answers checked by the Zod schema the tool asked with', () => {
  const seen: unknown[] = [];
  const pick = (schema: z.ZodType) =>
    tool({
      name: 'pick',
      description: 'Asks for a pick',
      parameters: z.object({}),
      execute: async (_params, context) => {
        const answer = await context.interrupt!({
          reason: 'pick',
          message: 'Pick',
          responseSchema: schema,
        });
        seen.push(answer);
        return 'picked';
      },
    });
  const pickCall = { id: 'p1', name: 'pick', arguments: {} };
  const agentWith = (schema: z.ZodType) =>
    new Agent({ name: 'a', model: 'mock/m', instructions: 'x', tools: [pick(schema)] });

  it('stores the input schema, fills defaults and drops keys it does not know', async () => {
    seen.length = 0;
    const agent = agentWith(z.object({ n: z.number(), note: z.string().default('') }));
    const { cog } = setup([callTools([pickCall]), answer('done')]);
    const paused = await cog.run(agent, { input: 'Go' });
    expect(paused.interrupts?.[0]?.responseSchema).toMatchObject({ required: ['n'] });
    await cog.resume(agent, roundTrip(paused.checkpoint), {
      responses: { 'p1#0': { n: 1, extra: true } },
    });
    expect(seen).toEqual([{ n: 1, note: '' }]);
  });

  it('coerces and pipes the answer as the schema says', async () => {
    seen.length = 0;
    const agent = agentWith(
      z.object({ n: z.coerce.number(), s: z.string().pipe(z.string().min(2)) })
    );
    const { cog } = setup([callTools([pickCall]), answer('done')]);
    const paused = await cog.run(agent, { input: 'Go' });
    await expect(
      cog.resume(agent, roundTrip(paused.checkpoint), { responses: { 'p1#0': { n: '5', s: 'a' } } })
    ).rejects.toMatchObject({ code: ErrorCode.INTERRUPT_ANSWER_INVALID });
    await cog.resume(agent, roundTrip(paused.checkpoint), {
      responses: { 'p1#0': { n: '5', s: 'ab' } },
    });
    expect(seen).toEqual([{ n: 5, s: 'ab' }]);
  });

  it('refuses an answer a refinement rejects and keeps the run resumable', async () => {
    seen.length = 0;
    const agent = agentWith(
      z.object({ n: z.number() }).refine((value) => value.n > 5, 'too small')
    );
    const { cog } = setup([callTools([pickCall]), answer('done')]);
    const paused = await cog.run(agent, { input: 'Go', threadId: 'refined' });
    await expect(cog.resume(agent, 'refined', { responses: { 'p1#0': { n: 1 } } })).rejects.toThrow(
      /too small/
    );
    const done = await cog.resume(agent, 'refined', { responses: { 'p1#0': { n: 9 } } });
    expect(done.status).toBe('completed');
    expect(seen).toEqual([{ n: 9 }]);
    expect(paused.status).toBe('paused');
  });

  it('asks again when another process resumes with an answer only the refinement refuses', async () => {
    seen.length = 0;
    const agent = agentWith(
      z.object({ n: z.number() }).refine((value) => value.n > 5, 'too small')
    );
    const first = setup([callTools([pickCall]), answer('done')]);
    const paused = await first.cog.run(agent, { input: 'Go' });
    const other = setup([answer('done')]);
    const again = await other.cog.resume(agent, roundTrip(paused.checkpoint), {
      responses: { 'p1#0': { n: 1 } },
    });
    expect(again.status).toBe('paused');
    expect(again.interrupts?.map((entry) => entry.id)).toEqual(['p1#0']);
    expect(again.checkpoint?.interrupts?.map((entry) => entry.id)).toEqual(['p1#0']);
    expect(seen).toEqual([]);

    const third = setup([answer('done')]);
    const done = await third.cog.resume(agent, roundTrip(again.checkpoint), {
      responses: { 'p1#0': { n: 9 } },
    });
    expect(done.status).toBe('completed');
    expect(seen).toEqual([{ n: 9 }]);
  });

  it('keeps the schemas of waiting questions only, and forgets them when the run ends', async () => {
    const agent = agentWith(z.object({ n: z.number() }));
    const { cog } = setup([callTools([pickCall]), answer('done')]);
    const schemas = (cog as unknown as { interruptSchemas: { size: number } }).interruptSchemas;
    const paused = await cog.run(agent, { input: 'Go', threadId: 'kept' });
    expect(schemas.size).toBe(1);
    await cog.resume(agent, roundTrip(paused.checkpoint), { responses: { 'p1#0': { n: 1 } } });
    expect(schemas.size).toBe(0);

    const again = setup([callTools([pickCall]), answer('done')]);
    const left = (again.cog as unknown as { interruptSchemas: { size: number } }).interruptSchemas;
    await again.cog.run(agent, { input: 'Go', threadId: 'moved' });
    expect(left.size).toBe(1);
    await again.cog.run(agent, { input: 'Something else', threadId: 'moved' });
    expect(left.size).toBe(0);
    await again.cog.run(agent, { input: 'Go', threadId: 'closing' });
    await again.cog.close();
    expect(left.size).toBe(0);
  });

  describe('cancelPause and pausedRun', () => {
    it('lists what a thread waits on, and cancelling answers the calls as declined', async () => {
      const { cog, requests } = setup([callTools([confirmCall]), echoTools()]);
      await cog.run(planner, { input: 'Migrate', threadId: 'cancel-me', userId: 'ann' });

      const waiting = await cog.pausedRun('cancel-me');
      expect(waiting?.userId).toBe('ann');
      expect(waiting?.interrupts.map((entry) => entry.id)).toEqual(['c1#0']);
      await expect(cog.cancelPause('cancel-me', { userId: 'bob' })).rejects.toMatchObject({
        code: ErrorCode.THREAD_ACCESS_DENIED,
      });

      expect(await cog.cancelPause('cancel-me', { userId: 'ann', reason: 'not now' })).toBe(true);
      expect(await cog.pausedRun('cancel-me')).toBeUndefined();
      expect(await cog.cancelPause('cancel-me', { userId: 'ann' })).toBe(false);

      await cog.run(planner, { input: 'Anything else?', threadId: 'cancel-me', userId: 'ann' });
      const tools = requests.at(-1)!.messages.filter((message) => message.role === 'tool');
      expect(tools.map((message) => message.content)).toEqual([
        JSON.stringify({
          error: 'The user declined to answer "Go ahead with the migration?": not now',
        }),
      ]);
      await cog.close();
    });
  });
});
