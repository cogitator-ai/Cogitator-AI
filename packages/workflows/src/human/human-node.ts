/**
 * Human-in-the-Loop Node
 *
 * Features:
 * - Async human approvals
 * - Multiple approval types (binary, multi-choice, free-form, rating)
 * - Approval chains (sequential approvers)
 * - Timeout handling with configurable actions
 * - Delegation support
 * - Priority-based routing
 */

import { nanoid } from 'nanoid';
import type {
  WorkflowState,
  HumanNodeConfig,
  ApprovalRequest,
  ApprovalResponse,
  ApprovalStore,
  ApprovalNotifier,
  ApprovalType,
  ApprovalChoice,
  ApprovalChainStep,
} from '@cogitator-ai/types';
import { isUnanswered, submitOrExisting, WITHDRAWN } from './approval-outcomes';
import { AbortError } from '../timers/timer-node';

/**
 * Context for human node execution
 */
export interface HumanNodeContext {
  workflowId: string;
  runId: string;
  nodeId: string;
  approvalStore: ApprovalStore;
  approvalNotifier?: ApprovalNotifier;
  /** Abort signal of the workflow run; aborts the wait and withdraws the request */
  signal?: AbortSignal;
  /** Called for every request created: the node's own, each chain step and escalations */
  onApprovalRequired?: (request: ApprovalRequest) => void;
}

interface AwaitedResponse {
  response: ApprovalResponse;
  /** The request timed out and was handed to its `escalateTo` assignee */
  escalated: boolean;
}

/**
 * Result of human node execution
 */
export interface HumanNodeResult<S extends WorkflowState> {
  approved: boolean;
  decision: unknown;
  response: ApprovalResponse;
  state: S;
  timedOut?: boolean;
  escalated?: boolean;
  /** The request was deleted, or expired, before anyone answered */
  withdrawn?: boolean;
}

/**
 * Execute a human approval node
 */
export async function executeHumanNode<S extends WorkflowState>(
  state: S,
  config: HumanNodeConfig<S>,
  context: HumanNodeContext
): Promise<HumanNodeResult<S>> {
  const approval = config.approval;

  const description =
    typeof approval.description === 'function' ? approval.description(state) : approval.description;

  const assignee =
    typeof approval.assignee === 'function' ? approval.assignee(state) : approval.assignee;

  const assigneeGroup =
    typeof approval.assigneeGroup === 'function'
      ? approval.assigneeGroup(state)
      : approval.assigneeGroup;

  if (approval.chain && approval.chain.length > 0) {
    return executeApprovalChain(state, config, context, approval.chain);
  }

  const request: ApprovalRequest = {
    id: nanoid(),
    workflowId: context.workflowId,
    runId: context.runId,
    nodeId: context.nodeId,
    type: approval.type,
    title: approval.title,
    description,
    choices: approval.choices,
    assignee,
    assigneeGroup,
    deadline: approval.timeout ? Date.now() + approval.timeout : undefined,
    timeout: approval.timeout,
    timeoutAction: approval.timeoutAction,
    escalateTo: approval.escalateTo,
    priority: approval.priority,
    metadata: { state },
    createdAt: Date.now(),
  };

  await openRequest(request, context);

  const { response, escalated } = await waitForResponse(request, context);

  const approved = !isUnanswered(response) && isApproved(request.type, response.decision);

  return {
    approved,
    decision: response.decision,
    response,
    state,
    timedOut: response.respondedBy === '__timeout__',
    escalated,
    withdrawn: response.respondedBy === WITHDRAWN,
  };
}

/**
 * Execute approval chain (sequential approvers)
 */
async function executeApprovalChain<S extends WorkflowState>(
  state: S,
  config: HumanNodeConfig<S>,
  context: HumanNodeContext,
  chain: ApprovalChainStep[]
): Promise<HumanNodeResult<S>> {
  const approval = config.approval;
  const responses: ApprovalResponse[] = [];
  let lastResponse: ApprovalResponse | undefined;

  for (let i = 0; i < chain.length; i++) {
    const step = chain[i];

    const effectiveTimeoutAction =
      step.timeoutAction === 'skip' ? 'fail' : (step.timeoutAction ?? 'fail');

    const request: ApprovalRequest = {
      id: nanoid(),
      workflowId: context.workflowId,
      runId: context.runId,
      nodeId: `${context.nodeId}:chain:${i}`,
      type: approval.type,
      title: `${approval.title} (Step ${i + 1}/${chain.length})`,
      description:
        typeof approval.description === 'function'
          ? approval.description(state)
          : approval.description,
      choices: approval.choices,
      assignee: step.assignee,
      deadline: step.timeout ? Date.now() + step.timeout : undefined,
      timeout: step.timeout,
      timeoutAction: effectiveTimeoutAction,
      priority: approval.priority,
      metadata: {
        state,
        chainStep: i,
        chainTotal: chain.length,
        role: step.role,
        previousResponses: responses,
      },
      createdAt: Date.now(),
    };

    await openRequest(request, context);

    const { response, escalated } = await waitForResponse(request, context);

    responses.push(response);
    lastResponse = response;

    const timedOut = response.respondedBy === '__timeout__';

    if (timedOut && step.timeoutAction === 'skip') {
      continue;
    }

    if (
      step.required &&
      (isUnanswered(response) || !isApproved(approval.type, response.decision))
    ) {
      return {
        approved: false,
        decision: response.decision,
        response,
        state,
        timedOut,
        escalated,
        withdrawn: response.respondedBy === WITHDRAWN,
      };
    }
  }

  return {
    approved: true,
    decision: lastResponse?.decision,
    response: lastResponse!,
    state,
  };
}

/**
 * Store a request and notify about it
 */
async function openRequest(request: ApprovalRequest, context: HumanNodeContext): Promise<void> {
  await context.approvalStore.createRequest(request);
  await context.approvalNotifier?.notify(request);
}

/**
 * Report a request to `onApprovalRequired` once its answer is being waited for, so an
 * observer that answers or withdraws it right away is not missed
 */
function reportRequest(request: ApprovalRequest, context: HumanNodeContext): void {
  try {
    context.onApprovalRequired?.(request);
  } catch (error) {
    console.warn(`[HumanNode] onApprovalRequired failed for request '${request.id}':`, error);
  }
}

/**
 * Wait for response or handle timeout
 */
async function waitForResponse(
  request: ApprovalRequest,
  context: HumanNodeContext
): Promise<AwaitedResponse> {
  const store = context.approvalStore;
  const signal = context.signal;
  return new Promise<AwaitedResponse>((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let unsubscribeFn: (() => void) | undefined;
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      unsubscribeFn?.();
      void withdrawRequest(request, store).then(() =>
        reject(new AbortError(`Human approval request '${request.id}' aborted`))
      );
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    unsubscribeFn = store.onResponse(request.id, (response) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
      resolve({ response, escalated: false });
    });

    if (request.timeout) {
      timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        unsubscribeFn?.();
        handleTimeout(request, context).then(resolve, reject);
      }, request.timeout);
    }

    signal?.addEventListener('abort', onAbort, { once: true });
    reportRequest(request, context);
  });
}

/**
 * Remove a request from the store so approvers no longer see it. Failures are
 * tolerated: the wait already unwound, and a missing request is not an error.
 */
/** Withdraws an open request. A request that is already gone needs no withdrawing. */
async function withdrawRequest(request: ApprovalRequest, store: ApprovalStore): Promise<void> {
  await store.deleteRequest(request.id).catch(() => undefined);
}

/**
 * Create a fail response for timeout
 */
async function createFailResponse(
  request: ApprovalRequest,
  store: ApprovalStore
): Promise<ApprovalResponse> {
  const response: ApprovalResponse = {
    requestId: request.id,
    decision: { error: 'Timeout exceeded, no response received' },
    respondedBy: '__timeout__',
    respondedAt: Date.now(),
    comment: 'Request timed out without response',
  };
  return submitOrExisting(store, response);
}

/**
 * Handle timeout based on configured action
 */
async function handleTimeout(
  request: ApprovalRequest,
  context: HumanNodeContext
): Promise<AwaitedResponse> {
  const store = context.approvalStore;
  const notifier = context.approvalNotifier;
  await notifier?.notifyTimeout(request);

  const action = request.timeoutAction ?? 'fail';

  switch (action) {
    case 'approve': {
      const response: ApprovalResponse = {
        requestId: request.id,
        decision: true,
        respondedBy: '__timeout__',
        respondedAt: Date.now(),
        comment: 'Auto-approved due to timeout',
      };
      return { response: await submitOrExisting(store, response), escalated: false };
    }

    case 'reject': {
      const response: ApprovalResponse = {
        requestId: request.id,
        decision: false,
        respondedBy: '__timeout__',
        respondedAt: Date.now(),
        comment: 'Auto-rejected due to timeout',
      };
      return { response: await submitOrExisting(store, response), escalated: false };
    }

    case 'escalate': {
      if (request.escalateTo) {
        await notifier?.notifyEscalation(request, 'Timeout exceeded');

        const escalatedRequest: ApprovalRequest = {
          ...request,
          id: nanoid(),
          assignee: request.escalateTo,
          assigneeGroup: undefined,
          metadata: {
            ...request.metadata,
            escalatedFrom: request.assignee,
            escalationReason: 'Timeout exceeded',
          },
          createdAt: Date.now(),
        };

        await openRequest(escalatedRequest, context);

        const escalationTimeout = Math.max(request.timeout ?? 0, 30 * 60 * 1000);

        const response = await new Promise<ApprovalResponse>((resolve, reject) => {
          let settled = false;
          let escalationTimer: ReturnType<typeof setTimeout> | undefined;
          let unsubscribe: (() => void) | undefined;

          const onAbort = () => {
            if (settled) return;
            settled = true;
            if (escalationTimer) clearTimeout(escalationTimer);
            unsubscribe?.();
            void withdrawRequest(escalatedRequest, store).then(() =>
              reject(new AbortError(`Human approval request '${escalatedRequest.id}' aborted`))
            );
          };

          if (context.signal?.aborted) {
            onAbort();
            return;
          }

          escalationTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            context.signal?.removeEventListener('abort', onAbort);
            unsubscribe?.();
            void createFailResponse(escalatedRequest, store).then(resolve);
          }, escalationTimeout);

          unsubscribe = store.onResponse(escalatedRequest.id, (resp) => {
            if (settled) return;
            settled = true;
            clearTimeout(escalationTimer);
            context.signal?.removeEventListener('abort', onAbort);
            resolve(resp);
          });

          context.signal?.addEventListener('abort', onAbort, { once: true });
          reportRequest(escalatedRequest, context);
        });
        return { response, escalated: true };
      }
      return { response: await createFailResponse(request, store), escalated: false };
    }

    case 'fail':
    default:
      return { response: await createFailResponse(request, store), escalated: false };
  }
}

/**
 * Check if decision counts as approved based on type
 */
function isApproved(type: ApprovalType, decision: unknown): boolean {
  switch (type) {
    case 'approve-reject':
      return decision === true || decision === 'approve';

    case 'multi-choice':
      return decision !== null && decision !== undefined;

    case 'free-form':
      return typeof decision === 'string' && decision.trim().length > 0;

    case 'numeric-rating':
      return typeof decision === 'number' && !isNaN(decision);

    default:
      return Boolean(decision);
  }
}

/** A human node config with its name set, as the node factories return it. */
export type NamedHumanNodeConfig<S extends WorkflowState> = HumanNodeConfig<S> & { name: string };

/**
 * Create a human approval node factory
 */
export function humanNode<S extends WorkflowState>(
  name: string,
  approval: HumanNodeConfig<S>['approval']
): NamedHumanNodeConfig<S> {
  return {
    name,
    approval,
  };
}

/**
 * Create a simple approve/reject node
 */
export function approvalNode<S extends WorkflowState>(
  name: string,
  options: {
    title: string;
    description?: string | ((state: S) => string);
    assignee?: string | ((state: S) => string);
    timeout?: number;
    timeoutAction?: 'approve' | 'reject' | 'fail';
    priority?: 'low' | 'normal' | 'high' | 'urgent';
  }
): NamedHumanNodeConfig<S> {
  return humanNode(name, {
    type: 'approve-reject',
    title: options.title,
    description: options.description,
    assignee: options.assignee,
    timeout: options.timeout,
    timeoutAction: options.timeoutAction,
    priority: options.priority,
  });
}

/**
 * Create a multi-choice selection node
 */
export function choiceNode<S extends WorkflowState>(
  name: string,
  options: {
    title: string;
    description?: string | ((state: S) => string);
    choices: ApprovalChoice[];
    assignee?: string | ((state: S) => string);
    timeout?: number;
    priority?: 'low' | 'normal' | 'high' | 'urgent';
  }
): NamedHumanNodeConfig<S> {
  return humanNode(name, {
    type: 'multi-choice',
    title: options.title,
    description: options.description,
    choices: options.choices,
    assignee: options.assignee,
    timeout: options.timeout,
    priority: options.priority,
  });
}

/**
 * Create a free-form input node
 */
export function inputNode<S extends WorkflowState>(
  name: string,
  options: {
    title: string;
    description?: string | ((state: S) => string);
    assignee?: string | ((state: S) => string);
    timeout?: number;
    priority?: 'low' | 'normal' | 'high' | 'urgent';
  }
): NamedHumanNodeConfig<S> {
  return humanNode(name, {
    type: 'free-form',
    title: options.title,
    description: options.description,
    assignee: options.assignee,
    timeout: options.timeout,
    priority: options.priority,
  });
}

/**
 * Create a rating node
 */
export function ratingNode<S extends WorkflowState>(
  name: string,
  options: {
    title: string;
    description?: string | ((state: S) => string);
    assignee?: string | ((state: S) => string);
    timeout?: number;
    priority?: 'low' | 'normal' | 'high' | 'urgent';
  }
): NamedHumanNodeConfig<S> {
  return humanNode(name, {
    type: 'numeric-rating',
    title: options.title,
    description: options.description,
    assignee: options.assignee,
    timeout: options.timeout,
    priority: options.priority,
  });
}

/**
 * Create an approval chain node
 */
export function chainNode<S extends WorkflowState>(
  name: string,
  options: {
    title: string;
    description?: string | ((state: S) => string);
    chain: ApprovalChainStep[];
    priority?: 'low' | 'normal' | 'high' | 'urgent';
  }
): NamedHumanNodeConfig<S> {
  return humanNode(name, {
    type: 'approve-reject',
    title: options.title,
    description: options.description,
    chain: options.chain,
    priority: options.priority,
  });
}

/**
 * Create a manager → director → VP chain
 */
export function managementChain<S extends WorkflowState>(
  name: string,
  options: {
    title: string;
    description?: string | ((state: S) => string);
    manager: string;
    director?: string;
    vp?: string;
    timeoutPerStep?: number;
  }
): NamedHumanNodeConfig<S> {
  const chain: ApprovalChainStep[] = [
    {
      assignee: options.manager,
      role: 'Manager',
      required: true,
      timeout: options.timeoutPerStep,
    },
  ];

  if (options.director) {
    chain.push({
      assignee: options.director,
      role: 'Director',
      required: true,
      timeout: options.timeoutPerStep,
    });
  }

  if (options.vp) {
    chain.push({
      assignee: options.vp,
      role: 'VP',
      required: true,
      timeout: options.timeoutPerStep,
    });
  }

  return chainNode(name, {
    title: options.title,
    description: options.description,
    chain,
  });
}
