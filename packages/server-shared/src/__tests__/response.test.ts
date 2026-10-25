import { describe, it, expect, vi } from 'vitest';
import {
  AgentStreamSession,
  conformancePausedResult,
  conformanceRunResult,
  swarmAgentNames,
  toAgentRunResponse,
  toWorkflowCompletedData,
  toWorkflowFailedData,
  withResumedCheckpoint,
  withSwarm,
  StreamEventSchema,
  PendingInterruptSchema,
  toPendingInterrupts,
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

  it('says when a hook or middleware stopped the run', () => {
    const result = {
      ...conformanceRunResult('thread-1'),
      stopped: { reason: 'tests are red', middleware: 'cogitator:hooks' },
    };
    expect(toAgentRunResponse(result).stopped).toEqual({
      reason: 'tests are red',
      middleware: 'cogitator:hooks',
    });
    expect(toAgentRunResponse(conformanceRunResult('thread-1'))).not.toHaveProperty('stopped');
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

  it('says why an approval asks and which rule an "always allow" saves, without the rule file', () => {
    const response = toAgentRunResponse(conformancePausedResult('thread-1'));
    expect(response.pendingApprovals?.[0]).toEqual({
      toolCallId: 'call_2',
      toolName: 'refund',
      arguments: { amount: 10 },
      description: 'Refund an order',
      sideEffects: ['payments'],
      reason: 'The ask rule refund(*) of the project settings asks before the call',
      rule: 'refund(*)',
      suggestedRule: 'refund(amount:10)',
      mode: 'default',
    });
    expect(JSON.stringify(response)).not.toContain('/srv/app');
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
  it('streams the arguments of a call as the model writes them, and sends them once only', () => {
    const { events, session: s } = session('t');
    s.callbacks.onToken('Let me write.');
    s.callbacks.onToolInputStart({ toolCallId: 'w1', toolName: 'write' });
    s.callbacks.onToolInputDelta({ toolCallId: 'w1', toolName: 'write', delta: '{"path":' });
    s.callbacks.onToolInputDelta({ toolCallId: 'w1', toolName: 'write', delta: '"a"}' });
    s.callbacks.onToolInputAvailable({ toolCallId: 'w1', toolName: 'write', input: { path: 'a' } });
    s.callbacks.onToolCall({ id: 'w1', name: 'write', arguments: { path: 'a' } });
    s.callbacks.onToolUpdate({ callId: 'w1', name: 'write', content: 'half' });
    s.callbacks.onToolResult({
      callId: 'w1',
      name: 'write',
      result: { ok: true },
      details: { bytes: 3 },
      presentation: { label: 'Write file', detail: 'a' },
    });

    const tools = events.filter((event) => event.type.startsWith('tool'));
    expect(tools).toEqual([
      { type: 'tool-call-start', id: 'w1', toolName: 'write' },
      { type: 'tool-call-delta', id: 'w1', argsTextDelta: '{"path":' },
      { type: 'tool-call-delta', id: 'w1', argsTextDelta: '"a"}' },
      { type: 'tool-call-end', id: 'w1' },
      { type: 'tool-update', toolCallId: 'w1', content: 'half' },
      {
        type: 'tool-result',
        id: expect.any(String),
        toolCallId: 'w1',
        result: { ok: true },
        details: { bytes: 3 },
        presentation: { label: 'Write file', detail: 'a' },
      },
    ]);
    expect(events.indexOf(tools[0]!)).toBeGreaterThan(
      events.findIndex((event) => event.type === 'text-end')
    );
    for (const event of events) expect(StreamEventSchema.parse(event)).toEqual(event);
  });

  it('drops a call the model began and never finished before the stream ends', () => {
    const { events, session: s } = session('t');
    s.callbacks.onToolInputStart({ toolCallId: 'cut', toolName: 'write' });
    s.callbacks.onToolInputDelta({ toolCallId: 'cut', toolName: 'write', delta: '{"pa' });
    s.fail('cut off');
    expect(events).toEqual([
      { type: 'tool-call-start', id: 'cut', toolName: 'write' },
      { type: 'tool-call-delta', id: 'cut', argsTextDelta: '{"pa' },
      { type: 'tool-call-end', id: 'cut', dropped: true },
      {
        type: 'tool-result',
        id: expect.any(String),
        toolCallId: 'cut',
        dropped: true,
        reason: 'incomplete',
      },
      { type: 'error', message: 'cut off' },
    ]);
    for (const event of events) StreamEventSchema.parse(event);
  });

  it('corrects the arguments of a streamed call that runs with other ones', () => {
    const { events, session: s } = session('t');
    s.callbacks.onToolInputStart({ toolCallId: 'w', toolName: 'write' });
    s.callbacks.onToolInputDelta({ toolCallId: 'w', toolName: 'write', delta: '{"path":"a"}' });
    s.callbacks.onToolInputAvailable({ toolCallId: 'w', toolName: 'write', input: { path: 'a' } });
    s.callbacks.onToolCall({ id: 'w', name: 'write', arguments: { path: 'safe/a' } });
    s.callbacks.onToolInputStart({ toolCallId: 'same', toolName: 'write' });
    s.callbacks.onToolInputDelta({
      toolCallId: 'same',
      toolName: 'write',
      delta: '{"b":1,"a":2}',
    });
    s.callbacks.onToolInputAvailable({ toolCallId: 'same', toolName: 'write', input: {} });
    s.callbacks.onToolCall({ id: 'same', name: 'write', arguments: { a: 2, b: 1 } });

    expect(events.filter((event) => event.type === 'tool-update')).toEqual([
      { type: 'tool-update', toolCallId: 'w', arguments: { path: 'safe/a' } },
    ]);
    for (const event of events) StreamEventSchema.parse(event);
  });

  it('announces again a dropped call a middleware gave another tool under the same id', () => {
    const { events, session: s } = session('t');
    s.callbacks.onToolInputStart({ toolCallId: 'x', toolName: 'read' });
    s.callbacks.onToolInputAvailable({ toolCallId: 'x', toolName: 'read', input: {} });
    s.callbacks.onToolInputAbandoned({ toolCallId: 'x', toolName: 'read', reason: 'discarded' });
    s.callbacks.onToolCall({ id: 'x', name: 'write', arguments: { path: 'a' } });
    s.callbacks.onToolResult({ callId: 'x', name: 'write', result: 'ok' });

    expect(events.filter((event) => event.type.startsWith('tool'))).toEqual([
      { type: 'tool-call-start', id: 'x', toolName: 'read' },
      { type: 'tool-call-end', id: 'x' },
      expect.objectContaining({ type: 'tool-result', toolCallId: 'x', dropped: true }),
      { type: 'tool-call-start', id: 'x', toolName: 'write' },
      { type: 'tool-call-delta', id: 'x', argsTextDelta: '{"path":"a"}' },
      { type: 'tool-call-end', id: 'x' },
      expect.objectContaining({ type: 'tool-result', toolCallId: 'x', result: 'ok' }),
    ]);
  });

  it('drops a finished call the run did not keep, and keeps the calls that run or wait', () => {
    const { events, session: s } = session('t');
    s.callbacks.onToolInputStart({ toolCallId: 'a', toolName: 'write' });
    s.callbacks.onToolInputAvailable({ toolCallId: 'a', toolName: 'write', input: {} });
    s.callbacks.onToolInputStart({ toolCallId: 'b', toolName: 'write' });
    s.callbacks.onToolInputAvailable({ toolCallId: 'b', toolName: 'write', input: {} });
    s.callbacks.onToolInputStart({ toolCallId: 'c', toolName: 'write' });
    s.callbacks.onToolInputAvailable({ toolCallId: 'c', toolName: 'write', input: {} });
    s.callbacks.onToolInputAbandoned({ toolCallId: 'a', toolName: 'write', reason: 'discarded' });
    s.callbacks.onToolCall({ id: 'b', name: 'write', arguments: {} });
    s.complete(conformancePausedResult('t'));

    const tools = events.filter((event) => event.type.startsWith('tool'));
    expect(
      tools.map((event) => [
        event.type,
        'id' in event ? event.id : '',
        'toolCallId' in event ? event.toolCallId : '',
      ])
    ).toEqual([
      ['tool-call-start', 'a', ''],
      ['tool-call-end', 'a', ''],
      ['tool-call-start', 'b', ''],
      ['tool-call-end', 'b', ''],
      ['tool-call-start', 'c', ''],
      ['tool-call-end', 'c', ''],
      ['tool-result', expect.any(String), 'a'],
      ['tool-result', expect.any(String), 'c'],
    ]);
    expect(tools.filter((event) => event.type === 'tool-result')).toEqual([
      expect.objectContaining({ toolCallId: 'a', dropped: true, reason: 'discarded' }),
      expect.objectContaining({ toolCallId: 'c', dropped: true, reason: 'discarded' }),
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

describe('toWorkflowCompletedData', () => {
  it('names the checkpoint of a run that saved one', () => {
    expect(
      toWorkflowCompletedData({ workflowId: 'wf_1', duration: 5, checkpointId: 'cp_1' })
    ).toEqual({ workflowId: 'wf_1', duration: 5, checkpointId: 'cp_1' });
  });

  it('leaves the checkpoint out of a run without one', () => {
    expect(toWorkflowCompletedData({ workflowId: 'wf_1', duration: 5 })).toEqual({
      workflowId: 'wf_1',
      duration: 5,
    });
  });
});

describe('toWorkflowFailedData', () => {
  it('names the checkpoint a failed run saved, and nothing for one that saved none', () => {
    expect(toWorkflowFailedData({ checkpointId: 'cp_1' })).toEqual({ checkpointId: 'cp_1' });
    expect(toWorkflowFailedData({})).toEqual({});
  });
});

describe('withResumedCheckpoint', () => {
  it('names the checkpoint a resume started from when the resumed run saved none', () => {
    const result: { workflowId: string; checkpointId?: string } = { workflowId: 'wf_1' };
    expect(withResumedCheckpoint(result, 'cp_1')).toEqual({
      workflowId: 'wf_1',
      checkpointId: 'cp_1',
    });
    expect(withResumedCheckpoint({ checkpointId: 'cp_2' }, 'cp_1')).toEqual({
      checkpointId: 'cp_2',
    });
  });
});

describe('paused runs that wait on questions of their tools', () => {
  const asked = (threadId: string) => ({
    ...conformancePausedResult(threadId),
    reasoning: undefined,
    pendingApprovals: [],
    interrupts: [
      {
        id: 'call_3#0',
        kind: 'input' as const,
        reason: 'pick_region',
        message: 'Where to?',
        responseSchema: { type: 'object' },
        toolCallId: 'call_3',
        toolName: 'deploy',
      },
    ],
  });

  it('carry the questions in the outcome, and approval pauses do not', () => {
    expect(toAgentRunResponse(asked('t')).interrupts).toEqual([
      {
        id: 'call_3#0',
        kind: 'input',
        reason: 'pick_region',
        message: 'Where to?',
        responseSchema: { type: 'object' },
        toolCallId: 'call_3',
        toolName: 'deploy',
      },
    ]);
    expect(toAgentRunResponse(conformancePausedResult('t'))).not.toHaveProperty('interrupts');
  });

  it('stream interrupt-required instead of approval-required', () => {
    const events: StreamEvent[] = [];
    const session = new AgentStreamSession((event) => events.push(event), { threadId: 't' });
    session.complete(asked('t'));
    expect(events.map((event) => event.type)).toEqual(['interrupt-required', 'finish']);
    expect(events[0]).toMatchObject({ threadId: 't', interrupts: [{ id: 'call_3#0' }] });
    expect(StreamEventSchema.parse(events[0])).toEqual(events[0]);
  });

  it('carry the plan of a plan, the usage of a budget and the rule texts of an approval', () => {
    const interrupts = toPendingInterrupts([
      {
        id: 'call_4#0',
        kind: 'plan',
        reason: 'plan_approval',
        message: 'Approve the plan so the agent can carry it out',
        responseSchema: { type: 'object' },
        toolCallId: 'call_4',
        toolName: 'exit_plan_mode',
        details: { plan: '1. Read\n2. Edit' },
      },
      {
        id: 'budget:session.cost',
        kind: 'budget',
        reason: 'budget_exceeded',
        message: 'The session reached its budget',
        details: { scope: 'session', metric: 'cost', used: 1.2, limit: 1 },
      },
      {
        id: 'call_5',
        kind: 'approval',
        reason: 'tool_approval',
        message: 'Approve the call of refund',
        toolCallId: 'call_5',
        details: { reason: 'asks', rule: 'refund(*)', suggestedRule: 'refund(amount:5)', extra: 1 },
      },
      {
        id: 'call_6',
        kind: 'approval',
        reason: 'tool_approval',
        message: 'Approve the call of refund',
        details: { origin: '/srv/app/.claude/settings.json' },
      },
    ]);
    expect(interrupts.map((entry) => entry.details)).toEqual([
      { plan: '1. Read\n2. Edit' },
      { scope: 'session', metric: 'cost', used: 1.2, limit: 1 },
      { reason: 'asks', rule: 'refund(*)', suggestedRule: 'refund(amount:5)' },
      undefined,
    ]);
    expect(interrupts[3]).not.toHaveProperty('details');
    for (const entry of interrupts) expect(PendingInterruptSchema.parse(entry)).toEqual(entry);
  });

  it('carry nothing while only approvals wait, whatever their details', () => {
    expect(
      toPendingInterrupts([
        {
          id: 'call_5',
          kind: 'approval',
          reason: 'tool_approval',
          message: 'Approve the call of refund',
          details: { reason: 'asks' },
        },
      ])
    ).toEqual([]);
  });
});
