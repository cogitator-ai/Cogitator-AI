import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  ToolCall,
} from '@cogitator-ai/types';
import { A2AServer } from '../server';
import type { A2AMessage, A2ATask, Part } from '../types';
import {
  readToolApprovalRequest,
  readToolApprovalResponse,
  toolApprovalResponsePart,
} from '../approvals';
import { expectResponse } from './helpers';
import { messageText, toMessage } from '../protocol';

const refundImpl = vi.fn(async ({ order }: { order: string }) => ({ refunded: order }));
const refund = tool({
  name: 'refund',
  description: 'Refund an order',
  parameters: z.object({ order: z.string() }),
  requiresApproval: true,
  execute: refundImpl,
});
const refundCall: ToolCall = { id: 'c1', name: 'refund', arguments: { order: 'A-1' } };

function refundingBackend(): LLMBackend {
  const respond = (request: ChatRequest): ChatResponse => {
    const results = request.messages.filter((m) => m.role === 'tool');
    if (results.length === 0) {
      return {
        id: 'r1',
        content: 'Let me refund that.',
        toolCalls: [refundCall],
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

const clerk = new Agent({
  name: 'clerk',
  model: 'mock/m',
  instructions: 'Refund orders.',
  tools: [refund],
});

let cogitator: Cogitator;
let server: A2AServer;

beforeEach(() => {
  refundImpl.mockClear();
  cogitator = new Cogitator({ llm: { backends: { mock: refundingBackend() } } });
  server = new A2AServer({ agents: { clerk }, cogitator });
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

describe('A2A tasks whose run pauses for tool approvals', () => {
  it('wait in input-required with the calls in a data part, never completed', async () => {
    const task = await send(ask([{ kind: 'text', text: 'Refund A-1' }]));

    expect(task.status.state).toBe('input-required');
    expect(messageText(task.status.message)).toBe('Waiting for approval of refund');
    expect(readToolApprovalRequest(task)).toEqual([
      expect.objectContaining({
        toolCallId: 'c1',
        toolName: 'refund',
        arguments: { order: 'A-1' },
      }),
    ]);
    expect(task.metadata?.['cogitator:pendingApprovals']).toBeUndefined();
    expect(task.artifacts).toEqual([]);
    expect(refundImpl).not.toHaveBeenCalled();
  });

  it('resume with the decisions the client sends back, then complete', async () => {
    const paused = await send(ask([{ kind: 'text', text: 'Refund A-1' }]));

    const done = await send(
      ask([toolApprovalResponsePart({ decisions: { c1: { approved: true } } })], paused.id),
      2
    );

    expect(done.status.state).toBe('completed');
    expect(refundImpl).toHaveBeenCalledTimes(1);
    const answer = done.history!.at(-1)?.parts[0];
    expect(answer).toEqual({ kind: 'text', text: expect.stringContaining('"refunded":"A-1"') });
  });

  it('decline with the reason the client gives', async () => {
    const paused = await send(ask([{ kind: 'text', text: 'Refund A-1' }]));

    const done = await send(
      ask(
        [toolApprovalResponsePart({ defaultDecision: { approved: false, reason: 'fraud' } })],
        paused.id
      ),
      2
    );

    expect(done.status.state).toBe('completed');
    expect(refundImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(done.history!.at(-1))).toContain('fraud');
  });

  it('treat a text reply as moving on: the waiting calls are declined, a new run answers', async () => {
    const paused = await send(ask([{ kind: 'text', text: 'Refund A-1' }]));

    const next = await send(ask([{ kind: 'text', text: 'Never mind' }], paused.id), 2);

    expect(refundImpl).not.toHaveBeenCalled();
    expect(next.status.state).toBe('input-required');
  });

  it('fail clearly when the server Cogitator cannot resume', async () => {
    const runOnly = new A2AServer({
      agents: { clerk },
      cogitator: { run: (agent, options) => cogitator.run(agent as Agent, options) },
    });
    const first = expectResponse(
      await runOnly.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'message/send',
        params: { message: ask([{ kind: 'text', text: 'Refund A-1' }]) },
        id: 1,
      })
    ).result as A2ATask;

    const second = expectResponse(
      await runOnly.handleJsonRpc({
        jsonrpc: '2.0',
        method: 'message/send',
        params: {
          message: ask(
            [toolApprovalResponsePart({ defaultDecision: { approved: true } })],
            first.id
          ),
        },
        id: 2,
      })
    ).result as A2ATask;

    expect(second.status.state).toBe('failed');
    expect(messageText(second.status.message)).toContain('Unsupported operation');
    expect(refundImpl).not.toHaveBeenCalled();
  });
});

describe('tool approval data parts', () => {
  it('read only well-formed decisions', () => {
    expect(
      readToolApprovalResponse(
        ask([toolApprovalResponsePart({ decisions: { c1: { approved: false, reason: 'no' } } })])
      )
    ).toEqual({ decisions: { c1: { approved: false, reason: 'no' } } });
    expect(
      readToolApprovalResponse(
        ask([
          {
            kind: 'data',
            data: { kind: 'tool-approval-response', decisions: { c1: { approved: 'yes' } } },
          },
        ])
      )
    ).toBeUndefined();
    expect(readToolApprovalResponse(ask([{ kind: 'text', text: 'approve' }]))).toBeUndefined();
  });
});

describe('A2AClient.answerApprovals', () => {
  it('continues the task with a tool approval response', async () => {
    const { A2AClient } = await import('../client');
    const client = new A2AClient('http://remote.invalid');
    const sendMessage = vi.spyOn(client, 'sendMessage').mockResolvedValue({} as A2ATask);

    await client.answerApprovals('task_1', { decisions: { c1: { approved: true } } });

    const [message] = sendMessage.mock.calls[0];
    expect(message.taskId).toBe('task_1');
    expect(readToolApprovalResponse(toMessage(message))).toEqual({
      decisions: { c1: { approved: true } },
    });
  });
});
