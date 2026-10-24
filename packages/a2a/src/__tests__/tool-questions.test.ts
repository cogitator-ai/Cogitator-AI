import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  ToolCall,
  ToolContext,
} from '@cogitator-ai/types';
import { A2AServer } from '../server';
import { A2AClient } from '../client';
import type { A2AMessage, A2ATask, Part } from '../types';
import { readToolApprovalRequest, toolApprovalResponsePart } from '../approvals';
import { interruptResponsePart, readInterruptRequest, readInterruptResponse } from '../questions';
import { expectResponse } from './helpers';
import { messageText, toMessage } from '../protocol';

const confirmImpl = vi.fn(async ({ plan }: { plan: string }, context: ToolContext) => {
  const reply = await context.interrupt!({
    reason: 'confirm_plan',
    message: `Go ahead with ${plan}?`,
    responseSchema: z.object({ ok: z.boolean() }),
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
    expect(messageText(task.status.message)).toBe('Go ahead with the move?');
    expect(readInterruptRequest(task)).toEqual([
      {
        id: 'q1#0',
        reason: 'confirm_plan',
        message: 'Go ahead with the move?',
        responseSchema: expect.objectContaining({ required: ['ok'] }),
        toolName: 'confirm_plan',
      },
    ]);
    expect(readToolApprovalRequest(task)).toBeUndefined();
    expect(task.metadata?.['cogitator:pendingQuestions']).toBeUndefined();
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

  it('ask again with why when the answer does not match the schema, then take a good one', async () => {
    const paused = await send(ask([{ kind: 'text', text: 'Plan the move' }]));

    const again = await send(ask([{ kind: 'text', text: 'sure' }], paused.id), 2);

    expect(again.status.state).toBe('input-required');
    expect(messageText(again.status.message)).toContain('does not match its schema');
    expect(messageText(again.status.message)).toContain('Go ahead with the move?');
    expect(readInterruptRequest(again)?.map((question) => question.id)).toEqual(['q1#0']);

    const done = await send(ask([interruptResponsePart({ 'q1#0': { ok: true } })], again.id), 3);
    expect(done.status.state).toBe('completed');
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
    expect(messageText(asked.status.message)).toBe('Go ahead with the move?');
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
