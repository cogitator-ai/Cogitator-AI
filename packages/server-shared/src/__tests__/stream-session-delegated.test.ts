import { describe, it, expect } from 'vitest';
import { CogitatorError, ErrorCode, type DelegatedRunStart } from '@cogitator-ai/types';
import { AgentStreamSession, conformanceRunResult, type StreamEvent } from '../index';

const child: DelegatedRunStart = {
  parentToolCallId: 'call_parent',
  parentRunId: 'run_parent',
  agent: 'researcher',
  taskId: 'task_1',
  threadId: 'subagent_task_1',
  background: false,
  depth: 1,
};

function delegatedSession() {
  const parent: StreamEvent[] = [];
  const children = new Map<string, StreamEvent[]>();
  const starts: DelegatedRunStart[] = [];
  const session = new AgentStreamSession((event) => parent.push(event), {
    threadId: 't',
    delegated: (start) => {
      starts.push(start);
      if (start.agent === 'silent') return undefined;
      const events: StreamEvent[] = [];
      children.set(start.parentToolCallId, events);
      return (event) => events.push(event);
    },
  });
  return { session, parent, children, starts };
}

describe('AgentStreamSession delegated', () => {
  it('has no onDelegatedRun without the option', () => {
    const session = new AgentStreamSession(() => undefined, { threadId: 't' });
    expect(session.callbacks.onDelegatedRun).toBeUndefined();
  });

  it('streams a delegated run through a session of its own', () => {
    const { session, parent, children } = delegatedSession();
    const stream = session.callbacks.onDelegatedRun?.(child);
    expect(stream).toBeDefined();
    stream?.onRunStart?.({
      runId: 'run_child',
      agentId: 'agent_child',
      input: 'find it',
      threadId: 'subagent_task_1',
    });
    stream?.onToken?.('Found');
    stream?.onToolCall?.({ id: 'c1', name: 'search', arguments: { q: 'x' } });
    stream?.onToolResult?.({ callId: 'c1', name: 'search', result: 'ok' });
    stream?.onRunComplete?.(conformanceRunResult('subagent_task_1'));

    expect(parent).toEqual([]);
    const events = children.get('call_parent') ?? [];
    const types = events.map((event) => event.type);
    expect(types[0]).toBe('start');
    expect(events[0]).toMatchObject({ threadId: 'subagent_task_1' });
    expect(types).toContain('text-delta');
    expect(types).toContain('tool-call-start');
    expect(types).toContain('tool-result');
    expect(types.at(-1)).toBe('finish');
    expect(events.at(-1)).toMatchObject({ threadId: 'subagent_task_1' });
  });

  it('opens the session with the first event of a resumed run, which has no start', () => {
    const { session, children } = delegatedSession();
    const stream = session.callbacks.onDelegatedRun?.(child);
    stream?.onToken?.('again');
    const events = children.get('call_parent') ?? [];
    expect(events[0]).toMatchObject({ type: 'start', threadId: 'subagent_task_1' });
    expect(events[1]).toMatchObject({ type: 'text-start' });
  });

  it('fails the delegated session with the error a client may see', () => {
    const { session, children } = delegatedSession();
    const stream = session.callbacks.onDelegatedRun?.(child);
    stream?.onRunStart?.({ runId: 'r', agentId: 'a', input: 'x', threadId: 'th' });
    stream?.onRunError?.(
      new CogitatorError({ message: 'Too slow', code: ErrorCode.RUN_TIMEOUT }),
      'r'
    );
    stream?.onRunError?.(new Error('db password leaked'), 'r');
    const errors = (children.get('call_parent') ?? []).filter((event) => event.type === 'error');
    expect(errors[0]).toMatchObject({ message: 'Too slow', code: ErrorCode.RUN_TIMEOUT });
    expect(JSON.stringify(errors)).not.toContain('password');
  });

  it('leaves out a run the option returns nothing for', () => {
    const { session } = delegatedSession();
    expect(session.callbacks.onDelegatedRun?.({ ...child, agent: 'silent' })).toBeUndefined();
  });

  it('hands the runs a delegated run delegates to the same option', () => {
    const { session, children, starts } = delegatedSession();
    const stream = session.callbacks.onDelegatedRun?.(child);
    const grandchild = stream?.onDelegatedRun?.({
      ...child,
      parentToolCallId: 'call_child',
      parentRunId: 'run_child',
      agent: 'reader',
      depth: 2,
    });
    grandchild?.onRunStart?.({ runId: 'g', agentId: 'a', input: 'x', threadId: 'thread_g' });
    grandchild?.onToken?.('deep');
    expect(starts.map((start) => start.depth)).toEqual([1, 2]);
    expect(children.get('call_child')?.[0]).toMatchObject({ type: 'start', threadId: 'thread_g' });
    expect(children.get('call_parent')).toEqual([]);
  });
});
