import type {
  WorkflowNode,
  WorkflowState,
  NodeConfig,
  NodeContext,
  NodeResult,
} from '@cogitator-ai/types';
import type { Cogitator } from '@cogitator-ai/core';

export type { WorkflowNode, NodeConfig, NodeContext, NodeResult };

export interface ExtendedNodeContext<S = WorkflowState> extends NodeContext<S> {
  cogitator: Cogitator;
}
