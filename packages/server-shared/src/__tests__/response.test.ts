import { describe, it, expect, vi } from 'vitest';
import {
  AgentStreamSession,
  conformancePausedResult,
  conformanceRunResult,
  swarmAgentNames,
  toAgentRunResponse,
  withSwarm,
  type StreamEvent,
} from '../index';

describe('toAgentRunResponse', () => {
  it('keeps what a client needs and every flag of how the run ended', () => {
    expect(toAgentRunResponse(conformanceRunResult('thread-1'))).toEqual({
      output: 'Hello again',
      threadId: 'thread-1',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      toolCalls: [{ id: 'call_1', name: 'lookup', arguments: { query: 'order 42' } }],
      reasoning: 'thinking',
      status: 'completed',
      structured: { answer: 42 },
      truncated: true,
      iterationLimitReached: true,
      traceId: 'trace_1',
    });
  });

  it('never carries the system prompt, the history, trace spans or provider state', () => {
    const text = JSON.stringify(toAgentRunResponse(conformanceRunResult('thread-1')));
    expect(text).not.toContain('SECRET OPERATOR INSTRUCTIONS');
    expect(text).not.toContain('postgres://');
    expect(text).not.toContain('opaque-provider-signature');
  });

  it('answers a paused run with its approvals and without its checkpoint', () => {
    const response = toAgentRunResponse(conformancePausedResult('thread-1'));
    expect(response).toMatchObject({
      status: 'paused',
      pendingApprovals: [
        {
          toolCallId: 'call_2',
          toolName: 'refund',
          arguments: { amount: 10 },
          description: 'Refund an order',
          sideEffects: ['payments'],
        },
      ],
    });
    expect(response).not.toHaveProperty('checkpoint');
    expect(response).not.toHaveProperty('truncated');
  });

  it('reports a blocked answer and a structured error', () => {
    const response = toAgentRunResponse({
      ...conformanceRunResult('t'),
      structured: undefined,
      structuredError: 'missing field "answer"',
      blocked: 'content_filter',
    });
    expect(response).toMatchObject({
      blocked: 'content_filter',
      structuredError: 'missing field "answer"',
    });
    expect(response).not.toHaveProperty('structured');
  });
});

describe('AgentStreamSession', () => {
  const session = (threadId?: string) => {
    const events: StreamEvent[] = [];
    return { events, session: new AgentStreamSession((event) => events.push(event), { threadId }) };
  };

  it('announces a new thread in start and finish', () => {
    const { events, session: s } = session();
    s.start();
    s.complete(conformanceRunResult(s.threadId));

    expect(s.threadId).toMatch(/^thread_[0-9a-f-]{36}$/);
    expect(events[0]).toEqual({ type: 'start', messageId: s.messageId, threadId: s.threadId });
    expect(events.at(-1)).toMatchObject({
      type: 'finish',
      threadId: s.threadId,
      status: 'completed',
      truncated: true,
      iterationLimitReached: true,
    });
  });

  it('closes the open text part before a tool call', () => {
    const { events, session: s } = session('t');
    s.callbacks.onToken('before');
    s.callbacks.onToolCall({ id: 'c1', name: 'lookup', arguments: {} });
    s.callbacks.onToken('after');
    s.complete(conformanceRunResult('t'));

    expect(events.map((event) => event.type)).toEqual([
      'text-start',
      'text-delta',
      'text-end',
      'tool-call-start',
      'tool-call-delta',
      'tool-call-end',
      'text-start',
      'text-delta',
      'text-end',
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'finish',
    ]);
  });

  it('sends an answer the model gave in one piece, then the approvals of a paused run', () => {
    const { events, session: s } = session('t');
    s.complete({ ...conformancePausedResult('t'), output: 'Need approval', reasoning: undefined });

    expect(events.map((event) => event.type)).toEqual([
      'text-start',
      'text-delta',
      'text-end',
      'approval-required',
      'finish',
    ]);
    expect(events.at(-1)).toMatchObject({ status: 'paused', threadId: 't' });
  });

  it('closes the open part before an error', () => {
    const { events, session: s } = session('t');
    s.callbacks.onReasoning('hmm');
    s.fail('boom', 'INTERNAL_ERROR');
    expect(events.map((event) => event.type)).toEqual([
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'error',
    ]);
  });
});

describe('withSwarm', () => {
  const swarm = () => ({ close: vi.fn().mockResolvedValue(undefined) });

  it('closes the swarm after a run that succeeds', async () => {
    const s = swarm();
    await expect(withSwarm(s, async () => 'done')).resolves.toBe('done');
    expect(s.close).toHaveBeenCalledOnce();
  });

  it('closes the swarm after a run that fails, and keeps the run error', async () => {
    const s = swarm();
    await expect(
      withSwarm(s, async () => {
        throw new Error('aborted');
      })
    ).rejects.toThrow('aborted');
    expect(s.close).toHaveBeenCalledOnce();
  });

  it('does not let a failed close replace the result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = { close: vi.fn().mockRejectedValue(new Error('redis down')) };
    await expect(withSwarm(s, async () => 'done')).resolves.toBe('done');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('swarmAgentNames', () => {
  it('lists the router and the pipeline stages with the other slots, each name once', () => {
    expect(
      swarmAgentNames({
        supervisor: { name: 'lead' },
        workers: [{ name: 'a' }, { name: 'b' }],
        moderator: { name: 'mod' },
        router: { name: 'router' },
        stages: [{ agent: { name: 'draft' } }, { agent: { name: 'a' } }],
        pipeline: { stages: [{ agent: { name: 'review' } }] },
      })
    ).toEqual(['lead', 'a', 'b', 'mod', 'router', 'draft', 'review']);
  });
});
