/**
 * @cogitator/workflows
 *
 * DAG-based workflow engine for Cogitator agents
 */

// Builder
export { WorkflowBuilder } from './builder.js';

// Executor
export { WorkflowExecutor } from './executor.js';

// Scheduler
export { WorkflowScheduler } from './scheduler.js';

// Checkpoint stores
export {
  InMemoryCheckpointStore,
  FileCheckpointStore,
  createCheckpointId,
} from './checkpoint.js';

// Pre-built nodes
export {
  agentNode,
  toolNode,
  functionNode,
  customNode,
} from './nodes/index.js';

export type {
  AgentNodeOptions,
} from './nodes/agent.js';

export type {
  ToolNodeOptions,
} from './nodes/tool.js';

export type {
  SimpleNodeFn,
  FullNodeFn,
  FunctionNodeOptions,
} from './nodes/function.js';

export type {
  ExtendedNodeContext,
} from './nodes/base.js';

// Re-export types from @cogitator/types for convenience
export type {
  Workflow,
  WorkflowState,
  WorkflowNode,
  WorkflowResult,
  WorkflowEvent,
  WorkflowExecuteOptions,
  WorkflowCheckpoint,
  CheckpointStore,
  NodeContext,
  NodeResult,
  NodeConfig,
  NodeFn,
  Edge,
  SequentialEdge,
  ConditionalEdge,
  ParallelEdge,
  LoopEdge,
  AddNodeOptions,
  AddConditionalOptions,
  AddLoopOptions,
} from '@cogitator/types';
