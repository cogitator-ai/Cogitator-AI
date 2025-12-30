/**
 * @cogitator/workflows - Human-in-the-Loop module
 *
 * Enables human approvals in workflow execution.
 *
 * Features:
 * - Async approvals (can take days)
 * - Multiple types: approve/reject, multi-choice, free-form, rating
 * - Timeout with configurable actions (approve/reject/escalate/fail)
 * - Approval chains (manager → director → CEO)
 * - Delegation support
 * - Audit trail via checkpoint store
 */

export {
  InMemoryApprovalStore,
  FileApprovalStore,
  withDelegation,
} from './approval-store';

export {
  ConsoleNotifier,
  WebhookNotifier,
  CompositeNotifier,
  slackNotifier,
  filteredNotifier,
  priorityRouter,
  nullNotifier,
} from './notifiers';

export {
  type HumanNodeContext,
  type HumanNodeResult,
  executeHumanNode,
  humanNode,
  approvalNode,
  choiceNode,
  inputNode,
  ratingNode,
  chainNode,
  managementChain,
} from './human-node';
