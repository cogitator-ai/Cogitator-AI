/**
 * Base node interfaces and types
 */

import type {
  WorkflowNode,
  WorkflowState,
  NodeConfig,
  NodeContext,
  NodeResult,
} from '@cogitator/types';

export type { WorkflowNode, NodeConfig, NodeContext, NodeResult };

/**
 * Extended context with Cogitator for agent nodes
 */
export interface ExtendedNodeContext<S = WorkflowState> extends NodeContext<S> {
  cogitator: import('@cogitator/core').Cogitator;
}
