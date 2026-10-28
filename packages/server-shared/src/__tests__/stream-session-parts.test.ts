import { describe, expect, it } from 'vitest';
import type { DelegatedRunStart } from '@cogitator-ai/types';
import {
  AgentStreamSession,
  StreamEventSchema,
  applyJsonPatch,
  conformanceRunResult,
  type StreamEvent,
} from '../index';

function session(options: ConstructorParameters<typeof AgentStreamSession>[1] = {}) {
  const events: StreamEvent[] = [];
  const stream = new AgentStreamSession((event) => events.push(event), {
    threadId: 't',
    ...options,
  });
  return { stream, events, callbacks: stream.callbacks };
}

describe('AgentStreamSession data parts', () => {
  it('streams a data part and its updates by id, transient ones marked', () => {
    const { stream, events, callbacks } = session();
    stream.start();
    callbacks.onToken('Checking');
    callbacks.onData({ id: 'w1', name: 'weather', data: { temp: 20 }, toolCallId: 'c1' });
    callbacks.onData({ id: 'w1', name: 'weather', data: { temp: 21 }, toolCallId: 'c1' });
    callbacks.onData({ id: 's1', name: 'status', data: 'loading', transient: true });

    const types = events.map((event) => event.type);
    expect(types).toEqual([
      'start',
      'text-start',
      'text-delta',
      'text-end',
      'data',
      'data',
      'data',
    ]);
    expect(events.slice(4)).toEqual([
      { type: 'data', id: 'w1', name: 'weather', data: { temp: 20 }, toolCallId: 'c1' },
      { type: 'data', id: 'w1', name: 'weather', data: { temp: 21 }, toolCallId: 'c1' },
      { type: 'data', id: 's1', name: 'status', data: 'loading', transient: true },
    ]);
    for (const event of events) expect(StreamEventSchema.parse(event)).toEqual(event);
  });
});

describe('AgentStreamSession state', () => {
  it('sends a snapshot first, then JSON Patches a client applies to the same state', () => {
    const { events, callbacks } = session();
    callbacks.onState({ todos: [{ text: 'a', done: false }] });
    callbacks.onState({
      todos: [
        { text: 'a', done: true },
        { text: 'b', done: false },
      ],
    });
    callbacks.onState({
      todos: [
        { text: 'a', done: true },
        { text: 'b', done: false },
      ],
    });

    expect(events).toEqual([
      { type: 'state-snapshot', snapshot: { todos: [{ text: 'a', done: false }] } },
      {
        type: 'state-delta',
        delta: [
          { op: 'replace', path: '/todos/0/done', value: true },
          { op: 'add', path: '/todos/1', value: { text: 'b', done: false } },
        ],
      },
    ]);
    let client: unknown;
    for (const event of events) {
      if (event.type === 'state-snapshot') client = event.snapshot;
      if (event.type === 'state-delta') client = applyJsonPatch(client, event.delta);
    }
    expect(client).toEqual({
      todos: [
        { text: 'a', done: true },
        { text: 'b', done: false },
      ],
    });
    for (const event of events) expect(StreamEventSchema.parse(event)).toEqual(event);
  });

  it('patches the state the client already holds', () => {
    const { events, callbacks } = session({ state: { count: 1 } });
    callbacks.onState({ count: 2 });
    expect(events).toEqual([
      { type: 'state-delta', delta: [{ op: 'replace', path: '/count', value: 2 }] },
    ]);
  });
});

describe('AgentStreamSession reset-step', () => {
  it('takes back the parts and tool calls of the step that starts over', () => {
    const { stream, events, callbacks } = session();
    stream.start();
    callbacks.onReasoning('hmm');
    callbacks.onToken('Half an ans');
    callbacks.onToolInputStart({ toolCallId: 'c1', toolName: 'search' });
    callbacks.onToolInputDelta({ toolCallId: 'c1', toolName: 'search', delta: '{"q"' });
    callbacks.onStepReset?.({ reason: 'fallback', model: 'openai/gpt-4o' });
    callbacks.onToolInputAbandoned({ toolCallId: 'c1', toolName: 'search', reason: 'incomplete' });
    callbacks.onToken('Full answer');
    stream.complete({ ...conformanceRunResult('t'), reasoning: undefined, toolCalls: [] });

    const reset = events.find((event) => event.type === 'reset-step');
    const parts = events
      .filter((event) => event.type === 'reasoning-start' || event.type === 'text-start')
      .map((event) => ('id' in event ? event.id : ''));
    expect(reset).toEqual({ type: 'reset-step', partIds: parts.slice(0, 2), toolCallIds: ['c1'] });
    const after = events.slice(events.indexOf(reset as StreamEvent) + 1).map((event) => event.type);
    expect(after).toEqual(['text-start', 'text-delta', 'text-end', 'finish']);
    expect(events.filter((event) => event.type === 'tool-result')).toEqual([]);
    for (const event of events) expect(StreamEventSchema.parse(event)).toEqual(event);
  });

  it('keeps what earlier steps sent', () => {
    const { events, callbacks } = session();
    callbacks.onToken('First');
    callbacks.onToolCall({ id: 'c1', name: 'search', arguments: {} });
    callbacks.onToolResult({ callId: 'c1', name: 'search', result: 'r' });
    callbacks.onToken('Sec');
    callbacks.onStepReset?.({ reason: 'empty_answer', model: 'm' });
    const reset = events.find((event) => event.type === 'reset-step');
    const second = events.filter((event) => event.type === 'text-start')[1];
    expect(reset).toEqual({
      type: 'reset-step',
      partIds: [second && 'id' in second ? second.id : ''],
      toolCallIds: [],
    });
  });

  it('leaves onStepReset out when resetSteps is off, for itself and its delegated runs', () => {
    const start: DelegatedRunStart = {
      parentToolCallId: 'c1',
      parentRunId: 'r',
      agent: 'helper',
      background: false,
      depth: 1,
    };
    const off = session({ resetSteps: false, delegated: () => () => undefined });
    expect(off.callbacks.onStepReset).toBeUndefined();
    expect(off.callbacks.onDelegatedRun?.(start)?.onStepReset).toBeUndefined();
    const on = session({ delegated: () => () => undefined });
    expect(on.callbacks.onStepReset).toBeTypeOf('function');
    expect(on.callbacks.onDelegatedRun?.(start)?.onStepReset).toBeTypeOf('function');
  });
});
