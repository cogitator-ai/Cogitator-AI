import type {
  ApprovalNotifier,
  ApprovalStore,
  ToolApprovalDecision,
  ToolApprovalRequest,
  WorkflowState,
} from '@cogitator-ai/types';
import type { ExtendedNodeContext } from './base';
import { executeHumanNode, type HumanNodeResult } from '../human/human-node';

/**
 * Where a node asks for the tool calls that need approval, and how. Each call becomes an
 * approve/reject request in the workflow's human-in-the-loop approval store, like an
 * `approvalNode`: an approved call runs, any other is declined with the approver's comment.
 */
export interface NodeApprovalOptions {
  /** Defaults to the run's `approvalStore` execute option */
  approvalStore?: ApprovalStore;
  /** Defaults to the run's `approvalNotifier` execute option */
  approvalNotifier?: ApprovalNotifier;
  assignee?: string;
  assigneeGroup?: string[];
  /** How long a request waits for an answer, in ms */
  timeout?: number;
  /** What a request that timed out decides: `'approve'`, else the call is declined */
  timeoutAction?: 'approve' | 'reject' | 'fail' | 'escalate';
  /** Who gets the request when it times out with `timeoutAction: 'escalate'` */
  escalateTo?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
}

function declineReason(result: HumanNodeResult<WorkflowState>): string {
  if (result.timedOut) return 'Nobody approved the call in time';
  if (result.withdrawn) return 'The approval request was withdrawn';
  return result.response.comment ?? 'Declined in the workflow';
}

/**
 * Asks the approval store whether `caller` may make the tool call in `request`, and waits for the
 * answer. The request is identified by the call's id, so two identical calls of one turn get a
 * request each, and a node that runs again after a restart finds the request of the same call.
 * Undefined when there is nobody to ask: `approvals` is `false`, or neither it nor the run has
 * an approval store.
 */
export async function askToolApproval<S extends WorkflowState>(
  request: ToolApprovalRequest,
  caller: string,
  approvals: NodeApprovalOptions | false | undefined,
  ctx: ExtendedNodeContext<S>
): Promise<ToolApprovalDecision | undefined> {
  if (approvals === false) return undefined;
  const approvalStore = approvals?.approvalStore ?? ctx.approvalStore;
  if (!approvalStore) return undefined;

  const result = await executeHumanNode<WorkflowState>(
    {
      caller,
      toolCallId: request.toolCallId,
      tool: request.toolName,
      arguments: request.arguments,
      ...(request.sideEffects && { sideEffects: request.sideEffects }),
    },
    {
      approval: {
        type: 'approve-reject',
        title: `Allow ${caller} to call ${request.toolName}?`,
        description: `${request.description}\n\nArguments: ${JSON.stringify(request.arguments)}`,
        assignee: approvals?.assignee,
        assigneeGroup: approvals?.assigneeGroup,
        timeout: approvals?.timeout,
        timeoutAction: approvals?.timeoutAction,
        escalateTo: approvals?.escalateTo,
        priority: approvals?.priority,
      },
    },
    {
      workflowId: ctx.workflowId,
      runId: ctx.workflowId,
      nodeId: `${ctx.nodeId}:approval`,
      approvalStore,
      approvalNotifier: approvals?.approvalNotifier ?? ctx.approvalNotifier,
      signal: ctx.signal,
      onApprovalRequired: ctx.onApprovalRequired,
    }
  );
  return result.approved ? { approved: true } : { approved: false, reason: declineReason(result) };
}
