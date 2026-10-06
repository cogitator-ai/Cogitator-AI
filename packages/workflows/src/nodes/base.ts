import type {
  WorkflowNode,
  WorkflowState,
  NodeConfig,
  NodeContext,
  NodeResult,
  ApprovalStore,
  ApprovalNotifier,
  ApprovalRequest,
  TimerEntry,
  TimerStore,
} from '@cogitator-ai/types';
import type { Cogitator } from '@cogitator-ai/core';

export type { WorkflowNode, NodeConfig, NodeContext, NodeResult };

export interface ExtendedNodeContext<S = WorkflowState> extends NodeContext<S> {
  cogitator: Cogitator;
  /** Abort signal of the workflow run, when the run can be cancelled */
  signal?: AbortSignal;
  /** Subworkflow nesting depth (0 for top-level runs) */
  depth?: number;
  /**
   * How many times the node has run in this workflow run, this time included. A resumed run
   * counts on from its checkpoint, so it names the same visit as before the restart
   */
  visit?: number;
  /** Run-level defaults for human-in-the-loop and timer nodes */
  approvalStore?: ApprovalStore;
  approvalNotifier?: ApprovalNotifier;
  timerStore?: TimerStore;
  /** Run-level observers, reported by human and timer nodes */
  onApprovalRequired?: (request: ApprovalRequest) => void;
  onTimerScheduled?: (entry: TimerEntry) => void;
}
