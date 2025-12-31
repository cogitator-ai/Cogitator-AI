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

/**
 * Context for human node execution
 */
export interface HumanNodeContext {
  workflowId: string;
  runId: string;
  nodeId: string;
  approvalStore: ApprovalStore;
  approvalNotifier?: ApprovalNotifier;
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
    typeof approval.description === 'function'
      ? approval.description(state)
      : approval.description;

  const assignee =
    typeof approval.assignee === 'function'
      ? approval.assignee(state)
      : approval.assignee;

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

  await context.approvalStore.createRequest(request);

  await context.approvalNotifier?.notify(request);

  const response = await waitForResponse(
    request,
    context.approvalStore,
    context.approvalNotifier
  );

  const approved = isApproved(request.type, response.decision);

  return {
    approved,
    decision: response.decision,
    response,
    state,
    timedOut: response.respondedBy === '__timeout__',
    escalated: response.respondedBy === '__escalation__',
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

    const effectiveTimeoutAction = step.timeoutAction === 'skip' ? 'fail' : (step.timeoutAction ?? 'fail');

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

    await context.approvalStore.createRequest(request);
    await context.approvalNotifier?.notify(request);

    const response = await waitForResponse(
      request,
      context.approvalStore,
      context.approvalNotifier
    );

    responses.push(response);
    lastResponse = response;

    if (step.required && !isApproved(approval.type, response.decision)) {
      return {
        approved: false,
        decision: response.decision,
        response,
        state,
        timedOut: response.respondedBy === '__timeout__',
        escalated: response.respondedBy === '__escalation__',
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
 * Wait for response or handle timeout
 */
async function waitForResponse(
  request: ApprovalRequest,
  store: ApprovalStore,
  notifier?: ApprovalNotifier
): Promise<ApprovalResponse> {
  return new Promise<ApprovalResponse>((resolve) => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let unsubscribeFn: (() => void) | undefined;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      unsubscribeFn?.();
    };

    unsubscribeFn = store.onResponse(request.id, (response) => {
      cleanup();
      resolve(response);
    });

    if (request.timeout) {
      timeoutId = setTimeout(async () => {
        cleanup();

        const timeoutResponse = await handleTimeout(request, store, notifier);
        resolve(timeoutResponse);
      }, request.timeout);
    }
  });
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
  await store.submitResponse(response);
  return response;
}

/**
 * Handle timeout based on configured action
 */
async function handleTimeout(
  request: ApprovalRequest,
  store: ApprovalStore,
  notifier?: ApprovalNotifier
): Promise<ApprovalResponse> {
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
      await store.submitResponse(response);
      return response;
    }

    case 'reject': {
      const response: ApprovalResponse = {
        requestId: request.id,
        decision: false,
        respondedBy: '__timeout__',
        respondedAt: Date.now(),
        comment: 'Auto-rejected due to timeout',
      };
      await store.submitResponse(response);
      return response;
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

        await store.createRequest(escalatedRequest);
        await notifier?.notify(escalatedRequest);

        return new Promise((resolve) => {
          store.onResponse(escalatedRequest.id, resolve);
        });
      }
      return createFailResponse(request, store);
    }

    case 'fail':
    default:
      return createFailResponse(request, store);
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

/**
 * Create a human approval node factory
 */
export function humanNode<S extends WorkflowState>(
  name: string,
  approval: HumanNodeConfig<S>['approval']
): HumanNodeConfig<S> {
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
): HumanNodeConfig<S> {
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
): HumanNodeConfig<S> {
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
): HumanNodeConfig<S> {
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
): HumanNodeConfig<S> {
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
): HumanNodeConfig<S> {
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
): HumanNodeConfig<S> {
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
