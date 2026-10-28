import {
  EventType,
  PROTOCOL_VERSION,
  type AGUIEvent,
  type Interrupt,
  type RunAgentInput,
  type RunFinishedOutcome,
  type TokenUsage,
} from '@ag-ui/core';
import type { DelegatedRunStart } from '@cogitator-ai/types';
import { createJsonPatch } from '../json-patch.js';
import type {
  FinishEvent,
  PendingApproval,
  PendingInterrupt,
  StreamEvent,
  Usage,
} from '../protocol.js';
import { STREAM_CANCELLED } from '../resumable-stream.js';

/**
 * A run delegated from a tool call of the streamed run (a subagent, an agent used as a tool),
 * named by `id` for as long as it streams: an AG-UI subagent invocation
 */
export interface DelegatedRunTag extends Pick<
  DelegatedRunStart,
  'agent' | 'parentToolCallId' | 'taskId' | 'background' | 'depth'
> {
  id: string;
}

/** An event of a delegated run, see `AgentStreamSessionOptions.delegated` */
export interface DelegatedStreamEvent {
  event: StreamEvent;
  run: DelegatedRunTag;
}

/** What `toAGUI()` reads: an event of the run, or of a run it delegated */
export type AGUISourceEvent = StreamEvent | DelegatedStreamEvent;

export interface AGUITranslatorOptions {
  /** The AG-UI thread of the run, the `threadId` of its `RunAgentInput` */
  threadId: string;
  /** The AG-UI run, the `runId` of its `RunAgentInput` */
  runId: string;
  parentRunId?: string;
  /** The request the run started from, echoed in `RUN_STARTED` */
  input?: RunAgentInput;
}

/** The key AG-UI metadata carries Cogitator's own fields under */
export const AGUI_METADATA_KEY = 'cogitator';

/** The `CUSTOM` events Cogitator sends for what AG-UI has no event of its own for */
export const AGUI_CUSTOM_EVENTS = {
  /** A transient data part: `{ id, name, data, toolCallId? }`, shown and never kept */
  data: 'cogitator.data',
  /** The arguments a tool call runs with, when they differ from the streamed ones */
  toolArguments: 'cogitator.tool-arguments',
  /** A streamed step started over: `{ partIds, toolCallIds }` */
  resetStep: 'cogitator.reset-step',
  /** An event of a workflow or a swarm run without an AG-UI event of its own, by name */
  workflow: 'cogitator.workflow',
  swarm: 'cogitator.swarm',
} as const;

/** The `activityType` of the progress a running tool reports (`tool-update`) */
export const TOOL_PROGRESS_ACTIVITY = 'tool-progress';

const APPROVAL_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    approved: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['approved'],
};

type Lane = string | undefined;

/**
 * Turns the events of our stream protocol into AG-UI 1.0 events, one at a time, for a stream
 * that is pushed (an `AgentStreamSession` emit). `toAGUI()` does the same over a list.
 *
 * | Stream event | AG-UI |
 * | --- | --- |
 * | `start` | `RUN_STARTED`, `SUBAGENT_STARTED` for a delegated run |
 * | `text-*` | `TEXT_MESSAGE_START`, `_CONTENT`, `_END` |
 * | `reasoning-*` | `REASONING_START` and `REASONING_MESSAGE_START`, `_CONTENT`, `REASONING_MESSAGE_END` and `REASONING_END` |
 * | `tool-call-*` | `TOOL_CALL_START`, `_ARGS`, `_END` |
 * | `tool-result` | `TOOL_CALL_RESULT` (a dropped call gets one too, marked `dropped` in its metadata) |
 * | `tool-update` | `ACTIVITY_SNAPSHOT`, then `ACTIVITY_DELTA` of `tool-progress`, new arguments as `CUSTOM` |
 * | `data` | `ACTIVITY_SNAPSHOT`, then `ACTIVITY_DELTA` by id (`<subagentRunId>:<id>` for a delegated run), a transient part as `CUSTOM` |
 * | `state-snapshot`, `state-delta` | `STATE_SNAPSHOT`, `STATE_DELTA` |
 * | `reset-step` | `CUSTOM`, the step's open tool calls closed |
 * | `finish` | `RUN_FINISHED` with outcome `success`, `interrupt`, or `cancelled` for a run a hook stopped, `SUBAGENT_FINISHED` for a delegated run |
 * | `error` | `RUN_ERROR`, outcome `cancelled` for a cancelled run, `SUBAGENT_ERROR` for a delegated run |
 * | `workflow` | `STEP_STARTED` and `STEP_FINISHED` for its nodes, `CUSTOM` for the rest |
 * | `swarm` | `CUSTOM` |
 *
 * A resumed run's results of the calls the paused run left open go out as `TOOL_CALL_RESULT`
 * of those calls. The approvals and questions of a paused run go out once, as the interrupts of the
 * `RUN_FINISHED` outcome, with the approval's tool call id as its interrupt id. The events
 * AG-UI orders strictly come out in its order: `RUN_STARTED` first, every message, tool call,
 * reasoning span, step and subagent closed before `RUN_FINISHED`, nothing after it.
 */
export class AGUITranslator {
  private started = false;
  private ended = false;
  private readonly openText = new Map<string, Lane>();
  private readonly openReasoning = new Map<string, Lane>();
  private readonly openToolCalls = new Map<string, Lane>();
  /** Tool calls started, settled or not, and the lane each belongs to */
  private readonly toolCallLanes = new Map<string, Lane>();
  private readonly settledToolCalls = new Set<string>();
  private readonly openSteps = new Set<string>();
  private readonly openSubagents = new Set<string>();
  private readonly closedSubagents = new Set<string>();
  /** The text message a tool call of each lane follows, as its parent message */
  private readonly lastText = new Map<Lane, string>();
  /** A copy of the content each activity message was sent with, by its id, for the next delta */
  private readonly activities = new Map<string, Record<string, unknown>>();

  constructor(private readonly options: AGUITranslatorOptions) {}

  /** Whether the run ended: `RUN_FINISHED` or `RUN_ERROR` went out, nothing more will */
  get finished(): boolean {
    return this.ended;
  }

  /** The AG-UI events of `source`, none after the run ended */
  push(source: AGUISourceEvent): AGUIEvent[] {
    if (this.ended) return [];
    const out: AGUIEvent[] = [];
    if ('run' in source) this.delegated(source.event, source.run, out);
    else this.own(source, out);
    return out;
  }

  private ensureStarted(out: AGUIEvent[]): void {
    if (this.started) return;
    this.started = true;
    out.push({
      type: EventType.RUN_STARTED,
      threadId: this.options.threadId,
      runId: this.options.runId,
      protocolVersion: PROTOCOL_VERSION,
      ...(this.options.parentRunId !== undefined && { parentRunId: this.options.parentRunId }),
      ...(this.options.input && { input: this.options.input }),
    });
  }

  private own(event: StreamEvent, out: AGUIEvent[]): void {
    this.ensureStarted(out);
    switch (event.type) {
      case 'start':
        return;
      case 'finish':
        this.closeAll(out);
        out.push({
          type: EventType.RUN_FINISHED,
          threadId: this.options.threadId,
          runId: this.options.runId,
          outcome: runOutcome(event),
          ...(event.structured !== undefined && !event.stopped && { result: event.structured }),
          ...(event.usage && { usage: [tokenUsage(event.usage)] }),
          ...withMetadata(finishMetadata(event)),
        });
        this.ended = true;
        return;
      case 'error':
        this.closeAll(out);
        out.push(
          event.code === STREAM_CANCELLED
            ? {
                type: EventType.RUN_FINISHED,
                threadId: this.options.threadId,
                runId: this.options.runId,
                outcome: { type: 'cancelled' },
              }
            : {
                type: EventType.RUN_ERROR,
                message: event.message,
                ...(event.code !== undefined && { code: event.code }),
              }
        );
        this.ended = true;
        return;
      case 'workflow':
        this.workflow(event.event, event.data, out);
        return;
      case 'swarm':
        out.push({
          type: EventType.CUSTOM,
          name: AGUI_CUSTOM_EVENTS.swarm,
          value: { event: event.event, data: event.data ?? null },
        });
        return;
      default:
        this.part(event, undefined, out);
    }
  }

  private delegated(event: StreamEvent, run: DelegatedRunTag, out: AGUIEvent[]): void {
    this.ensureStarted(out);
    const lane = run.id;
    if (event.type === 'start') {
      if (this.openSubagents.has(lane) || this.closedSubagents.has(lane)) return;
      const parent = this.toolCallLanes.get(run.parentToolCallId);
      if (parent !== undefined && !this.openSubagents.has(parent)) return;
      this.openSubagents.add(lane);
      out.push({
        type: EventType.SUBAGENT_STARTED,
        subagentRunId: lane,
        name: run.agent,
        parentToolCallId: run.parentToolCallId,
        ...(parent !== undefined && { parentSubagentRunId: parent }),
        metadata: {
          [AGUI_METADATA_KEY]: {
            ...(run.taskId !== undefined && { taskId: run.taskId }),
            ...(event.threadId !== undefined && { threadId: event.threadId }),
            background: run.background,
            depth: run.depth,
          },
        },
      });
      return;
    }
    if (!this.openSubagents.has(lane)) return;
    switch (event.type) {
      case 'finish':
        this.closeLane(lane, out);
        this.closeSubagent(lane, out, {
          ...(event.structured !== undefined && { result: event.structured }),
          ...(event.status === 'paused' && { outcome: { type: 'suspended' as const } }),
        });
        return;
      case 'error':
        this.closeLane(lane, out);
        this.openSubagents.delete(lane);
        this.closedSubagents.add(lane);
        out.push({
          type: EventType.SUBAGENT_ERROR,
          subagentRunId: lane,
          message: event.message,
          ...(event.code !== undefined && { code: event.code }),
        });
        return;
      case 'workflow':
      case 'swarm':
        return;
      default:
        this.part(event, lane, out);
    }
  }

  /** The events of the parts of a run, the same for the run and a run it delegated */
  private part(event: StreamEvent, lane: Lane, out: AGUIEvent[]): void {
    const by = lane === undefined ? {} : { subagentRunId: lane };
    switch (event.type) {
      case 'text-start':
        if (this.openText.has(event.id)) return;
        this.openText.set(event.id, lane);
        this.lastText.set(lane, event.id);
        out.push({
          type: EventType.TEXT_MESSAGE_START,
          messageId: event.id,
          role: 'assistant',
          ...by,
        });
        return;
      case 'text-delta':
        if (!this.openText.has(event.id)) return;
        out.push({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: event.id,
          delta: event.delta,
          ...by,
        });
        return;
      case 'text-end':
        if (!this.openText.delete(event.id)) return;
        out.push({ type: EventType.TEXT_MESSAGE_END, messageId: event.id, ...by });
        return;
      case 'reasoning-start':
        if (this.openReasoning.has(event.id)) return;
        this.openReasoning.set(event.id, lane);
        out.push(
          { type: EventType.REASONING_START, messageId: event.id, ...by },
          {
            type: EventType.REASONING_MESSAGE_START,
            messageId: event.id,
            role: 'reasoning',
            ...by,
          }
        );
        return;
      case 'reasoning-delta':
        if (!this.openReasoning.has(event.id)) return;
        out.push({
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: event.id,
          delta: event.delta,
          ...by,
        });
        return;
      case 'reasoning-end':
        if (!this.openReasoning.has(event.id)) return;
        this.endReasoning(event.id, lane, out);
        return;
      case 'tool-call-start': {
        if (this.toolCallLanes.has(event.id)) return;
        const parentMessageId = this.lastText.get(lane);
        this.toolCallLanes.set(event.id, lane);
        this.openToolCalls.set(event.id, lane);
        out.push({
          type: EventType.TOOL_CALL_START,
          toolCallId: event.id,
          toolCallName: event.toolName,
          ...(parentMessageId !== undefined && { parentMessageId }),
          ...by,
        });
        return;
      }
      case 'tool-call-delta':
        if (!this.openToolCalls.has(event.id)) return;
        out.push({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: event.id,
          delta: event.argsTextDelta,
          ...by,
        });
        return;
      case 'tool-call-end':
        if (!this.openToolCalls.delete(event.id)) return;
        out.push({ type: EventType.TOOL_CALL_END, toolCallId: event.id, ...by });
        return;
      case 'tool-result':
        if (event.dropped) {
          this.dropToolCall(event.toolCallId, event.id, event.reason ?? 'discarded', out);
          return;
        }
        this.closeToolCall(event.toolCallId, out);
        if (this.settledToolCalls.has(event.toolCallId)) return;
        this.settledToolCalls.add(event.toolCallId);
        this.lastText.delete(lane);
        out.push({
          type: EventType.TOOL_CALL_RESULT,
          messageId: event.id,
          toolCallId: event.toolCallId,
          content: resultContent(event.result),
          role: 'tool',
          ...by,
          ...withMetadata({
            ...(event.details !== undefined && { details: event.details }),
            ...(event.presentation && { presentation: event.presentation }),
          }),
        });
        return;
      case 'tool-update': {
        const progress = {
          ...(event.content !== undefined && { content: event.content }),
          ...(event.details !== undefined && { details: event.details }),
          ...(event.presentation && { presentation: event.presentation }),
        };
        if (Object.keys(progress).length > 0) {
          this.activity(
            `progress_${event.toolCallId}`,
            TOOL_PROGRESS_ACTIVITY,
            { toolCallId: event.toolCallId, ...progress },
            lane,
            out
          );
        }
        if (event.arguments) {
          out.push({
            type: EventType.CUSTOM,
            name: AGUI_CUSTOM_EVENTS.toolArguments,
            value: { toolCallId: event.toolCallId, arguments: event.arguments },
            ...by,
          });
        }
        return;
      }
      case 'data':
        if (event.transient) {
          out.push({
            type: EventType.CUSTOM,
            name: AGUI_CUSTOM_EVENTS.data,
            value: {
              id: event.id,
              name: event.name,
              data: event.data ?? null,
              ...(event.toolCallId !== undefined && { toolCallId: event.toolCallId }),
            },
            ...by,
          });
          return;
        }
        this.activity(event.id, event.name, activityContent(event.data), lane, out);
        return;
      case 'state-snapshot':
        out.push({ type: EventType.STATE_SNAPSHOT, snapshot: event.snapshot ?? null, ...by });
        return;
      case 'state-delta':
        out.push({ type: EventType.STATE_DELTA, delta: event.delta, ...by });
        return;
      case 'reset-step':
        for (const id of event.toolCallIds) this.dropToolCall(id, `reset_${id}`, 'reset', out);
        out.push({
          type: EventType.CUSTOM,
          name: AGUI_CUSTOM_EVENTS.resetStep,
          value: { partIds: event.partIds, toolCallIds: event.toolCallIds },
          ...by,
        });
        return;
      case 'approval-required':
      case 'interrupt-required':
        return;
      default:
        return;
    }
  }

  private workflow(name: string, data: unknown, out: AGUIEvent[]): void {
    const node = nodeNameOf(data);
    if (node !== undefined && name === 'node_started' && !this.openSteps.has(node)) {
      this.openSteps.add(node);
      out.push({ type: EventType.STEP_STARTED, stepName: node });
      return;
    }
    if (
      node !== undefined &&
      (name === 'node_completed' || name === 'node_error') &&
      this.openSteps.delete(node)
    ) {
      out.push({ type: EventType.STEP_FINISHED, stepName: node });
      if (name === 'node_completed') return;
    }
    out.push({
      type: EventType.CUSTOM,
      name: AGUI_CUSTOM_EVENTS.workflow,
      value: { event: name, data: data ?? null },
    });
  }

  /**
   * An activity message: its first content as `ACTIVITY_SNAPSHOT`, each later one as an
   * `ACTIVITY_DELTA` on the content sent before. The id of a delegated run's activity is put in its
   * lane (`<subagentRunId>:<id>`), so a run and the runs it delegates never share an activity, and
   * the translator keeps a copy of what it sent, so content changed in place still shows as a delta
   */
  private activity(
    id: string,
    activityType: string,
    content: Record<string, unknown>,
    lane: Lane,
    out: AGUIEvent[]
  ): void {
    const by = lane === undefined ? {} : { subagentRunId: lane };
    const messageId = lane === undefined ? id : `${lane}:${id}`;
    const previous = this.activities.get(messageId);
    const sent = structuredClone(content);
    this.activities.set(messageId, sent);
    if (previous === undefined) {
      out.push({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId,
        activityType,
        content: structuredClone(sent),
        ...by,
      });
      return;
    }
    const patch = createJsonPatch(previous, sent);
    if (patch.length > 0) {
      out.push({ type: EventType.ACTIVITY_DELTA, messageId, activityType, patch, ...by });
    }
  }

  private endReasoning(id: string, lane: Lane, out: AGUIEvent[]): void {
    const by = lane === undefined ? {} : { subagentRunId: lane };
    this.openReasoning.delete(id);
    out.push(
      { type: EventType.REASONING_MESSAGE_END, messageId: id, ...by },
      { type: EventType.REASONING_END, messageId: id, ...by }
    );
  }

  private closeToolCall(id: string, out: AGUIEvent[]): void {
    if (!this.openToolCalls.has(id)) return;
    const lane = this.openToolCalls.get(id);
    this.openToolCalls.delete(id);
    out.push({
      type: EventType.TOOL_CALL_END,
      toolCallId: id,
      ...(lane !== undefined && { subagentRunId: lane }),
    });
  }

  /**
   * Closes a call that never runs with a result of its own, so AG-UI does not take it for a
   * call left for the application to answer
   */
  private dropToolCall(id: string, messageId: string, reason: string, out: AGUIEvent[]): void {
    if (!this.toolCallLanes.has(id) || this.settledToolCalls.has(id)) return;
    const lane = this.toolCallLanes.get(id);
    this.closeToolCall(id, out);
    this.settledToolCalls.add(id);
    out.push({
      type: EventType.TOOL_CALL_RESULT,
      messageId,
      toolCallId: id,
      content: `The tool call never ran (${reason})`,
      role: 'tool',
      ...(lane !== undefined && { subagentRunId: lane }),
      metadata: { [AGUI_METADATA_KEY]: { dropped: true, reason } },
    });
  }

  /** Closes what `lane` left open */
  private closeLane(lane: Lane, out: AGUIEvent[]): void {
    const by = lane === undefined ? {} : { subagentRunId: lane };
    for (const [id, owner] of [...this.openText]) {
      if (owner !== lane) continue;
      this.openText.delete(id);
      out.push({ type: EventType.TEXT_MESSAGE_END, messageId: id, ...by });
    }
    for (const [id, owner] of [...this.openReasoning]) {
      if (owner === lane) this.endReasoning(id, lane, out);
    }
    for (const [id, owner] of [...this.openToolCalls]) {
      if (owner === lane) this.closeToolCall(id, out);
    }
    this.lastText.delete(lane);
  }

  private closeSubagent(
    lane: string,
    out: AGUIEvent[],
    finished: { result?: unknown; outcome?: { type: 'suspended' } } = {}
  ): void {
    this.openSubagents.delete(lane);
    this.closedSubagents.add(lane);
    out.push({ type: EventType.SUBAGENT_FINISHED, subagentRunId: lane, ...finished });
  }

  /** Closes everything still open, the deepest subagents first, before the run ends */
  private closeAll(out: AGUIEvent[]): void {
    for (const lane of [...this.openSubagents].reverse()) {
      this.closeLane(lane, out);
      this.closeSubagent(lane, out);
    }
    this.closeLane(undefined, out);
    for (const step of [...this.openSteps].reverse()) {
      out.push({ type: EventType.STEP_FINISHED, stepName: step });
    }
    this.openSteps.clear();
  }
}

/**
 * The AG-UI events of a run's stream events, in order: what an `AGUITranslator` turns them into.
 * A pure function of the events, so the same stream always reads the same in AG-UI
 */
export function toAGUI(
  events: Iterable<AGUISourceEvent>,
  options: AGUITranslatorOptions
): AGUIEvent[] {
  const translator = new AGUITranslator(options);
  const out: AGUIEvent[] = [];
  for (const event of events) out.push(...translator.push(event));
  return out;
}

/** The interrupt AG-UI shows for an approval a paused run waits on */
export function approvalInterrupt(approval: PendingApproval): Interrupt {
  return {
    id: approval.toolCallId,
    reason: 'tool_approval',
    message: approval.description,
    toolCallId: approval.toolCallId,
    responseSchema: APPROVAL_RESPONSE_SCHEMA,
    metadata: {
      [AGUI_METADATA_KEY]: {
        kind: 'approval',
        toolName: approval.toolName,
        arguments: approval.arguments,
        ...(approval.sideEffects !== undefined && { sideEffects: approval.sideEffects }),
        ...(approval.reason !== undefined && { reason: approval.reason }),
        ...(approval.rule !== undefined && { rule: approval.rule }),
        ...(approval.suggestedRule !== undefined && { suggestedRule: approval.suggestedRule }),
        ...(approval.mode !== undefined && { mode: approval.mode }),
      },
    },
  };
}

/** The interrupt AG-UI shows for a question a paused run waits on */
export function questionInterrupt(interrupt: PendingInterrupt): Interrupt {
  return {
    id: interrupt.id,
    reason: interrupt.reason,
    message: interrupt.message,
    ...(interrupt.toolCallId !== undefined && { toolCallId: interrupt.toolCallId }),
    ...(interrupt.kind === 'approval'
      ? { responseSchema: APPROVAL_RESPONSE_SCHEMA }
      : interrupt.responseSchema !== undefined && { responseSchema: interrupt.responseSchema }),
    ...(interrupt.expiresAt !== undefined && { expiresAt: interrupt.expiresAt }),
    metadata: {
      [AGUI_METADATA_KEY]: {
        kind: interrupt.kind,
        ...(interrupt.toolName !== undefined && { toolName: interrupt.toolName }),
        ...(interrupt.details !== undefined && { details: interrupt.details }),
      },
    },
  };
}

/**
 * How a run ended, for AG-UI: `interrupt` with what a paused run waits on, `cancelled` for a run a
 * hook or middleware stopped before it was done (`stopped`), else `success`
 */
function runOutcome(event: FinishEvent): RunFinishedOutcome {
  if (event.status !== 'paused') return event.stopped ? { type: 'cancelled' } : { type: 'success' };
  const interrupts =
    event.interrupts && event.interrupts.length > 0
      ? event.interrupts.map(questionInterrupt)
      : (event.pendingApprovals ?? []).map(approvalInterrupt);
  return interrupts.length > 0 ? { type: 'interrupt', interrupts } : { type: 'success' };
}

function finishMetadata(event: FinishEvent): Record<string, unknown> {
  return {
    ...(event.structuredError !== undefined && { structuredError: event.structuredError }),
    ...(event.truncated && { truncated: true }),
    ...(event.blocked !== undefined && { blocked: event.blocked }),
    ...(event.iterationLimitReached && { iterationLimitReached: true }),
    ...(event.stopped && { stopped: event.stopped }),
  };
}

function withMetadata(fields: Record<string, unknown>): { metadata?: Record<string, unknown> } {
  return Object.keys(fields).length > 0 ? { metadata: { [AGUI_METADATA_KEY]: fields } } : {};
}

function tokenUsage(usage: Usage): TokenUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(usage.reasoningTokens !== undefined && { reasoningTokens: usage.reasoningTokens }),
    ...(usage.cachedInputTokens !== undefined && { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage.cacheWriteTokens !== undefined && { cacheWriteInputTokens: usage.cacheWriteTokens }),
  };
}

/** A tool result as the text of its AG-UI tool message: a string as it is, anything else as JSON */
function resultContent(result: unknown): string {
  if (typeof result === 'string') return result;
  return result === undefined ? '' : JSON.stringify(result);
}

/** The content of an activity: an object as it is, any other value under `value` */
function activityContent(data: unknown): Record<string, unknown> {
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? { ...data }
    : { value: data ?? null };
}

function nodeNameOf(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null || !('nodeName' in data)) return undefined;
  return typeof data.nodeName === 'string' ? data.nodeName : undefined;
}
