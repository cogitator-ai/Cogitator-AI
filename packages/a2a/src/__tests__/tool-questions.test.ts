import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import type {
  RunCheckpoint,
  RunInterrupt,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  ToolCall,
  ToolContext,
} from '@cogitator-ai/types';
import { A2AServer } from '../server';
import { A2AClient } from '../client';
import type { A2AMessage, A2ATask, AgentRunResult, CogitatorLike, Part } from '../types';
import { TaskManager } from '../task-manager';
import { readToolApprovalRequest, toolApprovalResponsePart } from '../approvals';
import {
  answersFromMessage,
  interruptResponsePart,
  questionPrompt,
  readInterruptRequest,
  readInterruptResponse,
  toTaskQuestion,
} from '../questions';
import { expectResponse } from './helpers';
import { messageText, toMessage } from '../protocol';

let expiresAt: string | undefined;
const confirmImpl = vi.fn(async ({ plan }: { plan: string }, context: ToolContext) => {
  const reply = await context.interrupt!({
    reason: 'confirm_plan',
    message: `Go ahead with ${plan}?`,
    responseSchema: z.object({ ok: z.boolean() }),
    ...(expiresAt && { expiresAt }),
  });
  return { plan, ok: reply.ok };
});
const confirm = tool({
  name: 'confirm_plan',
  description: 'Asks the user to confirm a plan',
  parameters: z.object({ plan: z.string() }),
  execute: confirmImpl,
});

const refundImpl = vi.fn(async ({ order }: { order: string }) => ({ refunded: order }));
const refund = tool({
  name: 'refund',
  description: 'Refund an order',
  parameters: z.object({ order: z.string() }),
  requiresApproval: true,
  execute: refundImpl,
});

const confirmCall: ToolCall = { id: 'q1', name: 'confirm_plan', arguments: { plan: 'the move' } };
const refundCall: ToolCall = { id: 'c1', name: 'refund', arguments: { order: 'A-1' } };
let firstTurnCalls: ToolCall[] = [confirmCall];

function planningBackend(): LLMBackend {
  const respond = (request: ChatRequest): ChatResponse => {
    const results = request.messages.filter((m) => m.role === 'tool');
    if (results.length === 0) {
      return {
        id: 'r1',
        content: 'Let me check with you.',
        toolCalls: firstTurnCalls,
        finishReason: 'tool_calls',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
    }
    return {
      id: 'r2',
      content: `Done: ${results.map((m) => String(m.content)).join(' | ')}`,
      finishReason: 'stop',
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    };
  };
  return {
    provider: 'openai',
    chat: vi.fn(async (request: ChatRequest) => respond(request)),
    chatStream: vi.fn(async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    }),
  };
}

const planner = new Agent({
  name: 'planner',
  model: 'mock/m',
  instructions: 'Plan moves.',
  tools: [confirm, refund],
});

let cogitator: Cogitator;
let server: A2AServer;

beforeEach(() => {
  confirmImpl.mockClear();
  refundImpl.mockClear();
  firstTurnCalls = [confirmCall];
  expiresAt = undefined;
  cogitator = new Cogitator({ llm: { backends: { mock: planningBackend() } } });
  server = new A2AServer({ agents: { planner }, cogitator });
});

afterEach(async () => {
  await cogitator.close();
});

async function send(message: A2AMessage, id = 1): Promise<A2ATask> {
  const response = expectResponse(
    await server.handleJsonRpc({ jsonrpc: '2.0', method: 'message/send', params: { message }, id })
  );
  expect(response.error).toBeUndefined();
  return response.result as A2ATask;
}

const ask = (parts: Part[], taskId?: string): A2AMessage => ({
  kind: 'message',
  messageId: crypto.randomUUID(),
  role: 'user',
  parts,
  ...(taskId && { taskId }),
});

describe('A2A tasks whose run pauses on a question of a tool', () => {
  it('wait in input-required with the question in a data part, not as an approval', async () => {
    const task = await send(ask([{ kind: 'text', text: 'Plan the move' }]));

    expect(task.status.state).toBe('input-required');
    expect(messageText(task.status.message)).toBe('Go ahead with the move? (yes or no)');
    expect(readInterruptRequest(task)).toEqual([
      {
        id: 'q1#0',
        kind: 'input',
        reason: 'confirm_plan',
        message: 'Go ahead with the move?',
        responseSchema: expect.objectContaining({ required: ['ok'] }),
        toolName: 'confirm_plan',
      },
    ]);
    expect(readToolApprovalRequest(task)).toBeUndefined();
    expect(task.metadata?.['cogitator:pendingQuestions']).toBeUndefined();
    expect(task.metadata?.['cogitator:pausedRun']).toBeUndefined();
  });

  it('resume with the answers of an interrupt response, then complete', async () => {
    const paused = await send(ask([{ kind: 'text', text: 'Plan the move' }]));

    const done = await send(ask([interruptResponsePart({ 'q1#0': { ok: true } })], paused.id), 2);

    expect(done.status.state).toBe('completed');
    expect(messageText(done.status.message)).toContain('"ok":true');
    expect(confirmImpl).toHaveBeenCalledTimes(2);
  });

  it('take a plain data part as the answer to a single question', async () => {
    const paused = await send(ask([{ kind: 'text', text: 'Plan the move' }]));

    const done = await send(ask([{ kind: 'data', data: { ok: false } }], paused.id), 2);

    expect(done.status.state).toBe('completed');
    expect(messageText(done.status.message)).toContain('"ok":false');
  });

  it('read a plain text answer by the question schema', async () => {
    const paused = await send(ask([{ kind: 'text', text: 'Plan the move' }]));

    const done = await send(ask([{ kind: 'text', text: 'Yes.' }], paused.id), 2);

    expect(done.status.state).toBe('completed');
    expect(messageText(done.status.message)).toContain('"ok":true');
  });

  it('ask again in words when a text does not answer, without interrupt ids', async () => {
    const paused = await send(ask([{ kind: 'text', text: 'Plan the move' }]));

    const again = await send(ask([{ kind: 'text', text: 'maybe later' }], paused.id), 2);

    expect(again.status.state).toBe('input-required');
    expect(messageText(again.status.message)).toBe(
      'That does not answer the question: the answer should be yes or no.\n' +
        'Go ahead with the move? (yes or no)'
    );
    expect(messageText(again.status.message)).not.toContain('q1#0');
    expect(readInterruptRequest(again)?.map((question) => question.id)).toEqual(['q1#0']);
    expect(confirmImpl).toHaveBeenCalledTimes(1);

    const done = await send(ask([{ kind: 'text', text: 'no' }], again.id), 3);
    expect(done.status.state).toBe('completed');
    expect(messageText(done.status.message)).toContain('"ok":false');
  });

  it('ask again with why when the run refuses an answer, then take a good one', async () => {
    const paused = await send(ask([{ kind: 'text', text: 'Plan the move' }]));

    const again = await send(ask([interruptResponsePart({ 'q1#0': { ok: 'yes' } })], paused.id), 2);

    expect(again.status.state).toBe('input-required');
    expect(messageText(again.status.message)).toContain('does not match its schema');
    expect(messageText(again.status.message)).toContain('Go ahead with the move? (yes or no)');

    const done = await send(ask([interruptResponsePart({ 'q1#0': { ok: true } })], again.id), 3);
    expect(done.status.state).toBe('completed');
  });

  it('ask again when an interrupt response names no waiting question', async () => {
    const paused = await send(ask([{ kind: 'text', text: 'Plan the move' }]));

    const again = await send(ask([interruptResponsePart({ q9: { ok: true } })], paused.id), 2);

    expect(again.status.state).toBe('input-required');
    expect(messageText(again.status.message)).toContain(
      'The answers name no question this task waits on: q9.'
    );
    expect(readInterruptRequest(again)?.map((question) => question.id)).toEqual(['q1#0']);
  });

  it('end the task when its question expired and lift the pause', async () => {
    expiresAt = '2000-01-01T00:00:00.000Z';
    const paused = await send(ask([{ kind: 'text', text: 'Plan the move' }]));
    expect(readInterruptRequest(paused)?.[0].expiresAt).toBe(expiresAt);

    const expired = await send(
      ask([interruptResponsePart({ 'q1#0': { ok: true } })], paused.id),
      2
    );

    expect(expired.status.state).toBe('failed');
    expect(messageText(expired.status.message)).toBe(
      'The question "Go ahead with the move?" expired at 2000-01-01T00:00:00.000Z, ' +
        'so the answer came too late. Send a new message to go on.'
    );
    expect(expired.metadata?.['cogitator:pausedRun']).toBeUndefined();
    expect(await cogitator.pausedRun(paused.contextId)).toBeUndefined();
  });

  it('cancel a waiting task when a newer task of its context moves on, and answer the newer one', async () => {
    const first = await send(ask([{ kind: 'text', text: 'Plan the move' }]));

    const second = await send(
      { ...ask([{ kind: 'text', text: 'Plan the trip instead' }]), contextId: first.contextId },
      2
    );

    expect(second.status.state).toBe('input-required');
    const ended = expectResponse(
      await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'tasks/get',
        params: { id: first.id },
        id: 3,
      })
    ).result as A2ATask;
    expect(ended.status.state).toBe('canceled');
    expect(messageText(ended.status.message)).toContain('a newer message in its context');
    expect(readInterruptRequest(ended)).toBeUndefined();

    const late = expectResponse(
      await server.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'message/send',
        params: { message: ask([interruptResponsePart({ 'q1#0': { ok: true } })], first.id) },
        id: 4,
      })
    );
    expect(late.error?.message).toContain('canceled');

    const done = await send(ask([interruptResponsePart({ 'q1#0': { ok: true } })], second.id), 5);
    expect(done.status.state).toBe('completed');
    expect(messageText(done.status.message)).toContain('"ok":true');
  });

  it('ask the question a resumed approval leads to, then complete with its answer', async () => {
    firstTurnCalls = [refundCall, confirmCall];
    const paused = await send(ask([{ kind: 'text', text: 'Refund and plan' }]));
    expect(readToolApprovalRequest(paused)?.map((call) => call.toolCallId)).toEqual(['c1']);

    const asked = await send(
      ask([toolApprovalResponsePart({ decisions: { c1: { approved: true } } })], paused.id),
      2
    );

    expect(asked.status.state).toBe('input-required');
    expect(messageText(asked.status.message)).toBe('Go ahead with the move? (yes or no)');
    expect(readToolApprovalRequest(asked)).toBeUndefined();
    expect(readInterruptRequest(asked)?.map((question) => question.id)).toEqual(['q1#0']);

    const done = await send(ask([interruptResponsePart({ 'q1#0': { ok: true } })], asked.id), 3);

    expect(done.status.state).toBe('completed');
    expect(refundImpl).toHaveBeenCalledTimes(1);
  });
});

describe('A2AClient and questions of remote tools', () => {
  it('answerQuestions continues the task with an interrupt response', async () => {
    const client = new A2AClient('http://remote.invalid');
    const sendMessage = vi.spyOn(client, 'sendMessage').mockResolvedValue({} as A2ATask);

    await client.answerQuestions('task_1', { 'q1#0': { ok: true } });

    const [message] = sendMessage.mock.calls[0];
    expect(message.taskId).toBe('task_1');
    expect(readInterruptResponse(toMessage(message))).toEqual({ 'q1#0': { ok: true } });
  });

  it('asTool reports the questions a remote task waits on', async () => {
    const paused = await send(ask([{ kind: 'text', text: 'Plan the move' }]));
    const client = new A2AClient('http://remote.invalid');
    vi.spyOn(client, 'sendMessage').mockResolvedValue(paused);

    const result = await client.asTool().execute({ task: 'Plan the move' }, {
      agentId: 'a',
      runId: 'r',
      signal: new AbortController().signal,
    } as ToolContext);

    expect(result).toMatchObject({
      success: false,
      state: 'input-required',
      taskId: paused.id,
      error: expect.stringContaining('answers to confirm_plan ("Go ahead with the move?")'),
      pendingQuestions: [expect.objectContaining({ id: 'q1#0' })],
    });
    expect(result.pendingApprovals).toBeUndefined();
  });
});

describe('TaskManager and the paused run a task waits on', () => {
  const question: RunInterrupt = {
    id: 'q1#0',
    kind: 'input',
    reason: 'confirm_plan',
    message: 'Go ahead?',
    responseSchema: { type: 'boolean' },
    toolCallId: 'q1',
  };
  const checkpointOf = (runId: string): RunCheckpoint => ({
    version: 1,
    runId,
    agentId: 'a',
    threadId: 'ctx',
    model: 'mock/m',
    input: 'Plan',
    messages: [],
    toolCalls: [],
    turn: { toolCalls: [], decisions: {} },
    interrupts: [question],
    iterations: 1,
    lastToolCallSignature: '',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
    reasoning: [],
    startedAt: 0,
  });
  const runResult = (partial: Partial<AgentRunResult>): AgentRunResult => ({
    output: '',
    runId: 'run_1',
    agentId: 'a',
    threadId: 'ctx',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, duration: 0 },
    toolCalls: [],
    ...partial,
  });
  const pausedOn = (runId: string) =>
    runResult({
      runId,
      status: 'paused',
      interrupts: [question],
      checkpoint: checkpointOf(runId),
    });

  async function pausedTask(manager: TaskManager, host: CogitatorLike): Promise<A2ATask> {
    const message = ask([{ kind: 'text', text: 'Plan' }]);
    const task = await manager.createTask(message, 'ctx');
    return manager.executeTask(task, host, planner, message);
  }

  async function answer(
    manager: TaskManager,
    host: CogitatorLike,
    task: A2ATask,
    parts: Part[]
  ): Promise<A2ATask> {
    const message = ask(parts, task.id);
    return manager.executeTask(
      await manager.continueTask(task.id, message),
      host,
      planner,
      message
    );
  }

  it('resumes from the checkpoint of its own run, not by the thread of its context', async () => {
    const resume = vi.fn(async () => runResult({ output: 'done' }));
    const host: CogitatorLike = {
      run: vi.fn(async () => pausedOn('run_t1')),
      resume,
      pausedRun: vi.fn(async () => ({ runId: 'run_t1' })),
    };
    const manager = new TaskManager();
    const task = await pausedTask(manager, host);
    expect(task.metadata?.['cogitator:pausedRun']).toMatchObject({ runId: 'run_t1' });

    const done = await answer(manager, host, task, [{ kind: 'text', text: 'yes' }]);

    expect(done.status.state).toBe('completed');
    expect(resume).toHaveBeenCalledWith(
      planner,
      checkpointOf('run_t1'),
      expect.objectContaining({ responses: { 'q1#0': true } })
    );
    expect(done.metadata?.['cogitator:pausedRun']).toBeUndefined();
  });

  it('cancels the task instead of resuming when another run took its thread', async () => {
    const resume = vi.fn(async () => runResult({ output: 'done' }));
    const host: CogitatorLike = {
      run: vi.fn(async () => pausedOn('run_t1')),
      resume,
      pausedRun: vi.fn(async () => ({ runId: 'run_other' })),
    };
    const manager = new TaskManager();
    const task = await pausedTask(manager, host);

    const ended = await answer(manager, host, task, [{ kind: 'text', text: 'yes' }]);

    expect(ended.status.state).toBe('canceled');
    expect(messageText(ended.status.message)).toContain('a newer message in its context');
    expect(resume).not.toHaveBeenCalled();
  });

  it('fails the task on a resume error other than a refused answer', async () => {
    const host: CogitatorLike = {
      run: vi.fn(async () => pausedOn('run_t1')),
      resume: vi.fn(async () => {
        throw new CogitatorError({
          message: 'Interrupt "q1#0" was answered already',
          code: ErrorCode.VALIDATION_ERROR,
        });
      }),
    };
    const manager = new TaskManager();
    const task = await pausedTask(manager, host);

    const failed = await answer(manager, host, task, [{ kind: 'text', text: 'yes' }]);

    expect(failed.status.state).toBe('failed');
    expect(messageText(failed.status.message)).toContain('answered already');
  });

  it('lifts the pause through cancelPause when the question expired', async () => {
    const cancelPause = vi.fn(async () => true);
    const host: CogitatorLike = {
      run: vi.fn(async () => pausedOn('run_t1')),
      resume: vi.fn(async () => {
        throw new CogitatorError({
          message: 'Interrupt "q1#0" expired at 2000-01-01T00:00:00.000Z, its answer is refused',
          code: ErrorCode.INTERRUPT_EXPIRED,
          details: { interruptId: 'q1#0' },
        });
      }),
      pausedRun: vi.fn(async () => ({ runId: 'run_t1' })),
      cancelPause,
    };
    const manager = new TaskManager();
    const task = await pausedTask(manager, host);

    const failed = await answer(manager, host, task, [{ kind: 'text', text: 'yes' }]);

    expect(failed.status.state).toBe('failed');
    expect(messageText(failed.status.message)).toContain('The question "Go ahead?" expired');
    expect(cancelPause).toHaveBeenCalledWith('ctx', { reason: 'the question expired' });
  });
});

describe('plan and budget questions', () => {
  it('carry their kind and details, and show the plan before the question', () => {
    const plan = toTaskQuestion({
      id: 'p1#0',
      kind: 'plan',
      reason: 'plan_approval',
      message: 'Approve the plan so the agent can carry it out',
      responseSchema: {
        type: 'object',
        properties: { approved: { type: 'boolean' }, feedback: { type: 'string' } },
        required: ['approved'],
      },
      toolCallId: 'p1',
      toolName: 'exit_plan_mode',
      details: { plan: '1. Read\n2. Edit' },
    });
    expect(plan).toMatchObject({ kind: 'plan', details: { plan: '1. Read\n2. Edit' } });
    expect(questionPrompt(plan)).toBe(
      '1. Read\n2. Edit\n\nApprove the plan so the agent can carry it out (yes or no)'
    );

    const budget = toTaskQuestion({
      id: 'budget:session.cost',
      kind: 'budget',
      reason: 'budget_exceeded',
      message: 'The session reached its budget',
      responseSchema: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['continue', 'stop'] } },
        required: ['action'],
      },
      details: { scope: 'session', metric: 'cost', used: 1.2, limit: 1 },
    });
    expect(budget.details).toEqual({ scope: 'session', metric: 'cost', used: 1.2, limit: 1 });
    expect(questionPrompt(budget)).toBe('The session reached its budget (one of: continue, stop)');
    expect(
      answersFromMessage(
        { kind: 'message', messageId: 'm', role: 'user', parts: [{ kind: 'text', text: 'stop' }] },
        [budget]
      )
    ).toEqual({ responses: { 'budget:session.cost': { action: 'stop' } } });
  });
});
