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
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
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
    expect(paused.checkpoint?.turn.toolCalls.map((call) => call.id)).toEqual(['c1']);

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
