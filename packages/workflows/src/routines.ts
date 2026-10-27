/**
 * Routines as workflows: a routine of the trigger manager that runs a workflow, with its human
 * approvals, saga retries and compensation, and its approvals and failures in the inbox
 */

import type {
  ApprovalNotifier,
  ApprovalRequest,
  ApprovalStore,
  CheckpointStore,
  DeadLetterEntry,
  DeadLetterQueue,
  InboxItemInput,
  InboxWriter,
  RetryConfig,
  RoutineWorkflow,
  RoutineWorkflowContext,
  Workflow,
  WorkflowResult,
  WorkflowState,
} from '@cogitator-ai/types';
import type { Cogitator } from '@cogitator-ai/core';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { WorkflowExecutor } from './executor';
import { ApprovalAlreadyAnsweredError } from './human/approval-outcomes';
import { InMemoryApprovalStore } from './human/approval-store';
import { CompositeNotifier } from './human/notifiers';
import { InMemoryDLQ } from './saga/dead-letter';

/** What the inbox items of a workflow's approvals and failures carry about where they came from */
export type InboxOrigin = Pick<
  InboxItemInput,
  'routineId' | 'triggerId' | 'triggerEventId' | 'source' | 'runId' | 'userId' | 'metadata'
>;

/** The id of the inbox item of an approval request: one item per request, whatever happens to it */
export function experimental_approvalItemId(requestId: string): string {
  return `inbox_approval_${requestId}`;
}

/**
 * Experimental. An approval notifier that keeps one inbox item per request of a human node, so a
 * request is never answerable from two items:
 * - a request is an `approval` item (its `approvalId` is the request)
 * - a timeout closes it, as a `failure` item nobody can answer any more
 * - an escalation closes the request that timed out the same way, the escalated request (a new
 *   one, for its new assignee) comes as its own `approval` item
 * - a delegation is the delegated request's `approval` item, and closes the request it came from
 */
export function experimental_inboxNotifier(
  inbox: InboxWriter,
  origin: InboxOrigin = {}
): ApprovalNotifier {
  const add = (
    request: ApprovalRequest,
    item: Pick<InboxItemInput, 'kind' | 'title' | 'summary'>,
    approvalId = request.id,
    assignee = request.assignee
  ) =>
    inbox.add({
      ...origin,
      ...item,
      id: experimental_approvalItemId(approvalId),
      approvalId,
      workflowRunId: request.workflowId,
      ...(assignee !== undefined && origin.userId === undefined && { userId: assignee }),
      metadata: {
        ...origin.metadata,
        nodeId: request.nodeId,
        approvalType: request.type,
        ...(request.choices !== undefined && { choices: request.choices }),
        ...(request.deadline !== undefined && { deadline: request.deadline }),
      },
    });
  return {
    async notify(request) {
      await add(request, {
        kind: 'approval',
        title: request.title,
        summary: request.description ?? `The workflow waits for a ${request.type} answer`,
      });
    },
    async notifyEscalation(request, reason) {
      await add(request, {
        kind: 'failure',
        title: `Escalated: ${request.title}`,
        summary: `${reason}: the request went to whoever it escalates to`,
      });
    },
    async notifyTimeout(request) {
      await add(request, {
        kind: 'failure',
        title: `Timed out: ${request.title}`,
        summary: `Nobody answered in time, the request went ${request.timeoutAction ?? 'on'}`,
      });
    },
    async notifyDelegation(request, from, to) {
      const original = request.metadata?.originalRequestId;
      if (typeof original === 'string') {
        await add(
          request,
          {
            kind: 'result',
            title: `Delegated: ${request.title}`,
            summary: `${from} handed it to ${to}`,
          },
          original,
          from
        );
      }
      await add(request, {
        kind: 'approval',
        title: `Delegated: ${request.title}`,
        summary: `${from} handed it to ${to}`,
      });
    },
  };
}

/**
 * Experimental. A dead letter queue that also puts each node that finally failed (its retries
 * spent) in the inbox as a `failure` item, the entries kept in `inner`
 */
export function experimental_inboxDeadLetterQueue(
  inbox: InboxWriter,
  inner: DeadLetterQueue = new InMemoryDLQ(),
  origin: InboxOrigin = {}
): DeadLetterQueue {
  return {
    async add(entry: DeadLetterEntry) {
      const id = await inner.add(entry);
      await inbox.add({
        ...origin,
        kind: 'failure',
        title: `${entry.workflowName}: node ${entry.nodeId} failed`,
        summary: `${entry.error.message} (after ${entry.attempts} of ${entry.maxAttempts} attempts)`,
        workflowRunId: entry.workflowId,
        metadata: { ...origin.metadata, deadLetterId: id, nodeId: entry.nodeId },
      });
      return id;
    },
    get: (id) => inner.get(id),
    list: (filters) => inner.list(filters),
    retry: (id) => inner.retry(id),
    remove: (id) => inner.remove(id),
    count: (filters) => inner.count(filters),
    clear: () => inner.clear(),
  };
}

/** Options of {@link experimental_routineWorkflow} */
export interface RoutineWorkflowOptions<S extends WorkflowState> {
  workflow: Workflow<S>;
  /** The runtime its agent nodes run on, or an executor */
  runtime: Cogitator | WorkflowExecutor;
  checkpointStore?: CheckpointStore;
  /**
   * The state a firing starts from. Default: `{ input, trigger }`, the prompt with the event
   * wrapped as untrusted data and what the trigger manager vouches for about the event (its id,
   * source, trigger, times and how its sender was checked). The event's own fields (payload,
   * text, sender) are not in the state as they came: a custom `input` reads them from
   * `context.event`, and should keep them apart from instructions
   */
  input?: (context: RoutineWorkflowContext) => Partial<S>;
  /** What the inbox shows as the result. Default: `state.output` when it is text, else the state as JSON */
  output?: (result: WorkflowResult<S>) => string;
  /** Where the approvals of human nodes wait. Default: in memory */
  approvalStore?: ApprovalStore;
  /** Told of approvals besides the inbox */
  approvalNotifier?: ApprovalNotifier;
  /** Where nodes that finally failed are kept, besides the inbox. Default: in memory */
  deadLetterQueue?: DeadLetterQueue;
  /** Retries of nodes without their own */
  defaultRetry?: RetryConfig;
  maxIterations?: number;
  maxConcurrency?: number;
}

function defaultOutput(result: WorkflowResult<WorkflowState>): string {
  const output = (result.state as { output?: unknown }).output;
  return typeof output === 'string' ? output : JSON.stringify(result.state);
}

/**
 * Experimental. A workflow as the target of a routine (`experimental_triggers.workflows`). Each
 * firing runs it under the firing's run id with the routine's prompt and the event in its state;
 * its human nodes wait for approvals that go to the inbox (answered with the manager's
 * `respond()`), nodes that finally fail go to the inbox and to the dead letter queue, and its
 * outcome reaches the inbox as the routine's result or failure
 */
export function experimental_routineWorkflow<S extends WorkflowState>(
  options: RoutineWorkflowOptions<S>
): RoutineWorkflow {
  const executor =
    options.runtime instanceof WorkflowExecutor
      ? options.runtime
      : new WorkflowExecutor(options.runtime, options.checkpointStore);
  const approvalStore = options.approvalStore ?? new InMemoryApprovalStore();
  const deadLetters = options.deadLetterQueue ?? new InMemoryDLQ();
  const output = (options.output ?? defaultOutput) as (result: WorkflowResult<S>) => string;
  return {
    name: options.workflow.name,
    async run(context) {
      const origin: InboxOrigin = {
        routineId: context.routine.id,
        triggerId: context.event.triggerId,
        triggerEventId: context.event.id,
        source: context.event.source,
        runId: context.runId,
        ...(context.routine.userId !== undefined && { userId: context.routine.userId }),
        ...(context.routine.owner !== undefined && {
          metadata: { owner: { ...context.routine.owner } },
        }),
      };
      const inboxNotifier = experimental_inboxNotifier(context.inbox, origin);
      const input =
        options.input?.(context) ??
        ({ input: context.input, trigger: triggerOf(context) } as unknown as Partial<S>);
      const result = await executor.execute(options.workflow, input, {
        workflowId: context.runId,
        signal: context.signal,
        approvalStore,
        approvalNotifier: options.approvalNotifier
          ? new CompositeNotifier([inboxNotifier, options.approvalNotifier])
          : inboxNotifier,
        deadLetterQueue: experimental_inboxDeadLetterQueue(context.inbox, deadLetters, origin),
        ...(options.defaultRetry && { defaultRetry: options.defaultRetry }),
        ...(options.maxIterations !== undefined && { maxIterations: options.maxIterations }),
        ...(options.maxConcurrency !== undefined && { maxConcurrency: options.maxConcurrency }),
      });
      if (result.error) {
        return { status: 'failed', error: result.error.message, workflowRunId: result.workflowId };
      }
      return { status: 'completed', output: output(result), workflowRunId: result.workflowId };
    },
    async respond(approvalId, decision, respondedBy) {
      try {
        await approvalStore.submitResponse({
          requestId: approvalId,
          decision,
          respondedBy: respondedBy ?? 'inbox',
          respondedAt: Date.now(),
        });
      } catch (error) {
        if (!(error instanceof ApprovalAlreadyAnsweredError)) throw error;
        throw new CogitatorError({
          message: `The approval ${approvalId} was answered already, or timed out`,
          code: ErrorCode.INBOX_ITEM_ANSWERED,
          cause: error,
        });
      }
    },
  };
}

/** What the trigger manager vouches for about a firing's event, without what came from outside */
function triggerOf(context: RoutineWorkflowContext) {
  const { event } = context;
  return {
    id: event.id,
    source: event.source,
    triggerId: event.triggerId,
    routineId: context.routine.id,
    occurredAt: event.occurredAt,
    ...(event.scheduledFor !== undefined && { scheduledFor: event.scheduledFor }),
    verified: { method: event.verified.method, ok: event.verified.ok },
  };
}
