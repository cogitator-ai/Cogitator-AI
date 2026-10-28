import { describe, expect, it } from 'vitest';
import { lastValueFrom, from, toArray } from 'rxjs';
import { verifyEvents, type BaseEvent } from '@ag-ui/client';
import { EventSchema } from '@ag-ui/core/schemas';
import { EventType, type AGUIEvent } from '@ag-ui/core';
import type { DelegatedRunStart } from '@cogitator-ai/types';
import {
  AgentStreamSession,
  STREAM_CANCELLED,
  conformancePausedResult,
  conformanceRunResult,
  createErrorEvent,
  createDataEvent,
  createFinishEvent,
  createStartEvent,
  createToolUpdateEvent,
  createTextDeltaEvent,
  createTextStartEvent,
  createWorkflowEvent,
  type StreamEvent,
} from '../index';
import {
  AGUITranslator,
  AGUI_CUSTOM_EVENTS,
  toAGUI,
  type AGUISourceEvent,
  type DelegatedRunTag,
} from '../agui/index';

const ids = { threadId: 'thread_1', runId: 'run_1' };

/** What an AG-UI client accepts: the events pass its own verifier and its schema */
async function verified(events: AGUIEvent[]): Promise<AGUIEvent[]> {
  for (const event of events) EventSchema.parse(event);
  const passed = await lastValueFrom(from<BaseEvent[]>(events).pipe(verifyEvents(), toArray()));
  expect(passed).toHaveLength(events.length);
  return events;
}

function recorded(build: (session: AgentStreamSession, sources: AGUISourceEvent[]) => void) {
  const sources: AGUISourceEvent[] = [];
  const session = new AgentStreamSession((event) => sources.push(event), {
    threadId: ids.threadId,
    resetSteps: true,
    delegated: (start: DelegatedRunStart) => {
      const run: DelegatedRunTag = {
        id: `sub_${start.parentToolCallId}`,
        agent: start.agent,
        parentToolCallId: start.parentToolCallId,
        background: start.background,
        depth: start.depth,
      };
      return (event: StreamEvent) => sources.push({ event, run });
    },
  });
  build(session, sources);
  return sources;
}

describe('toAGUI', () => {
  it('maps a run with text, reasoning, a tool call, data and state', async () => {
    const sources = recorded((session) => {
      const { callbacks } = session;
      session.start();
      callbacks.onReasoning('Let me look');
      callbacks.onToken('Looking it up');
      callbacks.onToolInputStart({ toolCallId: 'c1', toolName: 'search' });
      callbacks.onToolInputDelta({ toolCallId: 'c1', toolName: 'search', delta: '{"q":"x"}' });
      callbacks.onToolInputAvailable({ toolCallId: 'c1', toolName: 'search', input: { q: 'x' } });
      callbacks.onToolCall({ id: 'c1', name: 'search', arguments: { q: 'x' } });
      callbacks.onToolUpdate({ callId: 'c1', name: 'search', content: { rows: 1 } });
      callbacks.onToolUpdate({ callId: 'c1', name: 'search', content: { rows: 2 } });
      callbacks.onData({ id: 'chart', name: 'chart', data: { points: [1] }, toolCallId: 'c1' });
      callbacks.onData({ id: 'chart', name: 'chart', data: { points: [1, 2] }, toolCallId: 'c1' });
      callbacks.onData({ id: 'tick', name: 'status', data: 'busy', transient: true });
      callbacks.onState({ step: 1 });
      callbacks.onState({ step: 2 });
      callbacks.onToolResult({ callId: 'c1', name: 'search', result: { hits: 2 } });
      callbacks.onToken('Found it');
      session.complete({ ...conformanceRunResult(ids.threadId), reasoning: undefined });
    });

    const events = await verified(toAGUI(sources, ids));
    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.REASONING_START,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.REASONING_END,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.ACTIVITY_DELTA,
      EventType.ACTIVITY_SNAPSHOT,
      EventType.ACTIVITY_DELTA,
      EventType.CUSTOM,
      EventType.STATE_SNAPSHOT,
      EventType.STATE_DELTA,
      EventType.TOOL_CALL_RESULT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);

    const text = events.find((event) => event.type === EventType.TEXT_MESSAGE_START);
    const call = events.find((event) => event.type === EventType.TOOL_CALL_START);
    expect(call).toMatchObject({ toolCallId: 'c1', toolCallName: 'search' });
    expect(call && 'parentMessageId' in call && call.parentMessageId).toBe(
      text && 'messageId' in text && text.messageId
    );
    expect(events.find((event) => event.type === EventType.TOOL_CALL_RESULT)).toMatchObject({
      toolCallId: 'c1',
      content: '{"hits":2}',
      role: 'tool',
    });
    expect(events.filter((event) => event.type === EventType.ACTIVITY_DELTA)).toEqual([
      expect.objectContaining({
        messageId: 'progress_c1',
        activityType: 'tool-progress',
        patch: [{ op: 'replace', path: '/content/rows', value: 2 }],
      }),
      expect.objectContaining({
        messageId: 'chart',
        activityType: 'chart',
        patch: [{ op: 'add', path: '/points/1', value: 2 }],
      }),
    ]);
    expect(events.find((event) => event.type === EventType.CUSTOM)).toMatchObject({
      name: AGUI_CUSTOM_EVENTS.data,
      value: { id: 'tick', name: 'status', data: 'busy' },
    });
    expect(events.find((event) => event.type === EventType.STATE_DELTA)).toMatchObject({
      delta: [{ op: 'replace', path: '/step', value: 2 }],
    });
    expect(events.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      threadId: 'thread_1',
      runId: 'run_1',
      outcome: { type: 'success' },
      result: { answer: 42 },
      usage: [{ inputTokens: 10, outputTokens: 20, totalTokens: 30 }],
      metadata: { cogitator: { truncated: true, iterationLimitReached: true } },
    });
  });

  it('ends a paused run with its approvals as interrupts', async () => {
    const sources = recorded((session) => {
      session.start();
      session.callbacks.onToolCall({ id: 'call_2', name: 'refund', arguments: { amount: 10 } });
      session.complete(conformancePausedResult(ids.threadId));
    });
    const events = await verified(toAGUI(sources, ids));
    const finished = events.at(-1);
    expect(finished).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: {
        type: 'interrupt',
        interrupts: [
          {
            id: 'call_2',
            reason: 'tool_approval',
            message: 'Refund an order',
            toolCallId: 'call_2',
            responseSchema: { required: ['approved'] },
            metadata: {
              cogitator: { kind: 'approval', toolName: 'refund', rule: 'refund(*)' },
            },
          },
        ],
      },
    });
  });

  it('ends a run paused on questions with every interrupt, approvals included', async () => {
    const paused = conformancePausedResult(ids.threadId);
    const sources = recorded((session) => {
      session.start();
      session.complete({
        ...paused,
        interrupts: [
          {
            id: 'q1',
            kind: 'input',
            reason: 'confirm',
            message: 'Which order?',
            toolCallId: 'c9',
            toolName: 'ask',
            responseSchema: { type: 'string' },
            expiresAt: '2030-01-01T00:00:00.000Z',
          },
          {
            id: 'call_2',
            kind: 'approval',
            reason: 'tool_approval',
            message: 'Refund an order',
            toolCallId: 'call_2',
          },
        ],
      });
    });
    const events = await verified(toAGUI(sources, ids));
    expect(events.at(-1)).toMatchObject({
      outcome: {
        type: 'interrupt',
        interrupts: [
          {
            id: 'q1',
            reason: 'confirm',
            responseSchema: { type: 'string' },
            expiresAt: '2030-01-01T00:00:00.000Z',
            metadata: { cogitator: { kind: 'input', toolName: 'ask' } },
          },
          { id: 'call_2', responseSchema: { required: ['approved'] } },
        ],
      },
    });
  });

  it('streams delegated runs as subagents, nested by the tool call that started them', async () => {
    const sources = recorded((session) => {
      const { callbacks } = session;
      session.start();
      callbacks.onToolCall({ id: 'c1', name: 'delegate', arguments: {} });
      const child = callbacks.onDelegatedRun?.({
        parentToolCallId: 'c1',
        parentRunId: 'run',
        agent: 'researcher',
        background: false,
        depth: 1,
      });
      child?.onRunStart?.({ runId: 'r2', agentId: 'a2', input: 'go', threadId: 'sub_thread' });
      child?.onToken?.('Child says');
      child?.onToolCall?.({ id: 'c2', name: 'delegate', arguments: {} });
      const grandchild = child?.onDelegatedRun?.({
        parentToolCallId: 'c2',
        parentRunId: 'r2',
        agent: 'checker',
        background: false,
        depth: 2,
      });
      grandchild?.onToken?.('Deep');
      grandchild?.onRunError?.(new Error('boom'), 'r3');
      child?.onToolResult?.({ callId: 'c2', name: 'delegate', result: 'failed' });
      child?.onRunComplete?.({ ...conformanceRunResult('sub_thread'), reasoning: undefined });
      callbacks.onToolResult({ callId: 'c1', name: 'delegate', result: 'done' });
      session.complete({ ...conformanceRunResult(ids.threadId), reasoning: undefined });
    });

    const events = await verified(toAGUI(sources, ids));
    const subagentEvents = events.filter((event) => event.type.startsWith('SUBAGENT_'));
    expect(subagentEvents).toEqual([
      expect.objectContaining({
        type: EventType.SUBAGENT_STARTED,
        subagentRunId: 'sub_c1',
        name: 'researcher',
        parentToolCallId: 'c1',
        metadata: { cogitator: { threadId: 'sub_thread', background: false, depth: 1 } },
      }),
      expect.objectContaining({
        type: EventType.SUBAGENT_STARTED,
        subagentRunId: 'sub_c2',
        name: 'checker',
        parentToolCallId: 'c2',
        parentSubagentRunId: 'sub_c1',
      }),
      expect.objectContaining({ type: EventType.SUBAGENT_ERROR, subagentRunId: 'sub_c2' }),
      expect.objectContaining({
        type: EventType.SUBAGENT_FINISHED,
        subagentRunId: 'sub_c1',
        result: { answer: 42 },
      }),
    ]);
    const childText = events.find(
      (event) => event.type === EventType.TEXT_MESSAGE_START && event.subagentRunId === 'sub_c1'
    );
    expect(childText).toBeDefined();
  });

  it('keeps the activities of a run and of a run it delegated apart, ids alike', async () => {
    const tag: DelegatedRunTag = {
      id: 'sub_1',
      agent: 'helper',
      parentToolCallId: 'c1',
      background: false,
      depth: 1,
    };
    const status = (data: unknown) => createDataEvent({ id: 'status', name: 'status', data });
    const events = await verified(
      toAGUI(
        [
          createStartEvent('m', ids.threadId),
          status({ step: 'parent' }),
          { event: createStartEvent('m2'), run: tag },
          { event: status({ step: 'child' }), run: tag },
          { event: status({ step: 'child 2' }), run: tag },
          status({ step: 'parent 2' }),
          { event: createFinishEvent('m2'), run: tag },
          createFinishEvent('m'),
        ],
        ids
      )
    );
    const activities = events.filter((event) => event.type.startsWith('ACTIVITY_'));
    expect(activities).toEqual([
      expect.objectContaining({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: 'status',
        content: { step: 'parent' },
      }),
      expect.objectContaining({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: 'sub_1:status',
        subagentRunId: 'sub_1',
        content: { step: 'child' },
      }),
      expect.objectContaining({
        type: EventType.ACTIVITY_DELTA,
        messageId: 'sub_1:status',
        patch: [{ op: 'replace', path: '/step', value: 'child 2' }],
      }),
      expect.objectContaining({
        type: EventType.ACTIVITY_DELTA,
        messageId: 'status',
        patch: [{ op: 'replace', path: '/step', value: 'parent 2' }],
      }),
    ]);
  });

  it('sends a delta for content changed in place, data parts and tool progress alike', () => {
    const translator = new AGUITranslator(ids);
    translator.push(createStartEvent('m'));
    const chart = { points: [1] };
    translator.push(createDataEvent({ id: 'chart', name: 'chart', data: { chart } }));
    chart.points.push(2);
    const chartDelta = translator.push(
      createDataEvent({ id: 'chart', name: 'chart', data: { chart } })
    );
    expect(chartDelta).toEqual([
      expect.objectContaining({
        type: EventType.ACTIVITY_DELTA,
        patch: [{ op: 'add', path: '/chart/points/1', value: 2 }],
      }),
    ]);

    const rows = { found: 1 };
    translator.push(createToolUpdateEvent('c1', { content: { rows } }));
    rows.found = 2;
    const progressDelta = translator.push(createToolUpdateEvent('c1', { content: { rows } }));
    expect(progressDelta).toEqual([
      expect.objectContaining({
        type: EventType.ACTIVITY_DELTA,
        messageId: 'progress_c1',
        patch: [{ op: 'replace', path: '/content/rows/found', value: 2 }],
      }),
    ]);
  });

  it('closes subagents still open when the run ends, and drops what comes after', async () => {
    const tag: DelegatedRunTag = {
      id: 'sub_1',
      agent: 'bg',
      parentToolCallId: 'c1',
      background: true,
      depth: 1,
    };
    const sources: AGUISourceEvent[] = [
      createStartEvent('m', ids.threadId),
      { event: createStartEvent('m2'), run: tag },
      { event: createTextStartEvent('t1'), run: tag },
      createFinishEvent('m'),
      { event: createTextDeltaEvent('t1', 'late'), run: tag },
    ];
    const events = await verified(toAGUI(sources, ids));
    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.SUBAGENT_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_END,
      EventType.SUBAGENT_FINISHED,
      EventType.RUN_FINISHED,
    ]);
  });

  it('ends a failed run with RUN_ERROR and a cancelled one with outcome cancelled', async () => {
    const failed = await verified(
      toAGUI(
        [createStartEvent('m'), createTextStartEvent('t'), createErrorEvent('no', 'LLM_ERROR')],
        ids
      )
    );
    expect(failed.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_ERROR,
    ]);
    expect(failed.at(-1)).toMatchObject({ message: 'no', code: 'LLM_ERROR' });

    const cancelled = await verified(
      toAGUI([createStartEvent('m'), createErrorEvent('stop', STREAM_CANCELLED)], ids)
    );
    expect(cancelled.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: 'cancelled' },
    });
  });

  it('ends a run a hook stopped with outcome cancelled, its stop reason kept', async () => {
    const events = await verified(
      toAGUI(
        [
          createStartEvent('m'),
          createFinishEvent('m', undefined, {
            status: 'completed',
            structured: { partial: true },
            stopped: { reason: 'budget spent', middleware: 'guard' },
          }),
        ],
        ids
      )
    );
    const finished = events.at(-1);
    expect(finished).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: 'cancelled' },
      metadata: { cogitator: { stopped: { reason: 'budget spent', middleware: 'guard' } } },
    });
    expect(finished && 'result' in finished).toBe(false);
  });

  it('opens the run even when its stream fails before start', async () => {
    const events = await verified(toAGUI([createErrorEvent('denied', 'FORBIDDEN')], ids));
    expect(events.map((event) => event.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_ERROR]);
  });

  it('closes the tool calls of a step that starts over, so none is left pending', async () => {
    const sources = recorded((session) => {
      const { callbacks } = session;
      session.start();
      callbacks.onToken('Par');
      callbacks.onToolInputStart({ toolCallId: 'c1', toolName: 'search' });
      callbacks.onStepReset?.({ reason: 'fallback', model: 'b' });
      callbacks.onToken('Whole');
      session.complete({ ...conformanceRunResult(ids.threadId), reasoning: undefined });
    });
    const events = await verified(toAGUI(sources, ids));
    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.CUSTOM,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
    expect(events.find((event) => event.type === EventType.TOOL_CALL_RESULT)).toMatchObject({
      metadata: { cogitator: { dropped: true, reason: 'reset' } },
    });
    expect(events.find((event) => event.type === EventType.CUSTOM)).toMatchObject({
      name: AGUI_CUSTOM_EVENTS.resetStep,
      value: { toolCallIds: ['c1'] },
    });
  });

  it('turns workflow nodes into steps and the rest into custom events', async () => {
    const events = await verified(
      toAGUI(
        [
          createStartEvent('m'),
          createWorkflowEvent('node_started', { nodeName: 'fetch' }),
          createWorkflowEvent('node_progress', { nodeName: 'fetch', progress: 0.5 }),
          createWorkflowEvent('node_completed', { nodeName: 'fetch', output: 1 }),
          createWorkflowEvent('node_started', { nodeName: 'save' }),
          createWorkflowEvent('workflow_completed', { workflowId: 'w' }),
          createFinishEvent('m'),
        ],
        ids
      )
    );
    expect(events.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.STEP_STARTED,
      EventType.CUSTOM,
      EventType.STEP_FINISHED,
      EventType.STEP_STARTED,
      EventType.CUSTOM,
      EventType.STEP_FINISHED,
      EventType.RUN_FINISHED,
    ]);
  });

  it('pushes one event at a time and knows when the run ended', () => {
    const translator = new AGUITranslator(ids);
    expect(translator.push(createStartEvent('m'))).toHaveLength(1);
    expect(translator.finished).toBe(false);
    translator.push(createFinishEvent('m'));
    expect(translator.finished).toBe(true);
    expect(translator.push(createTextStartEvent('t'))).toEqual([]);
  });
});
