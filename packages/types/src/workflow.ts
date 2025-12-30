/**
 * Workflow types for DAG-based multi-step pipelines
 */

// Base workflow state - can be extended with generics
export interface WorkflowState {
  [key: string]: unknown;
}

// Node configuration
export interface NodeConfig {
  timeout?: number;
  retries?: number;
  retryDelay?: number;
}

// Context passed to each node during execution
export interface NodeContext<S = WorkflowState> {
  state: S;
  input?: unknown;
  nodeId: string;
  workflowId: string;
  step: number;
}

// Result returned from a node
export interface NodeResult<S = WorkflowState> {
  state?: Partial<S>;
  output?: unknown;
  next?: string | string[];
}

// Node function type
export type NodeFn<S = WorkflowState> = (
  ctx: NodeContext<S>
) => Promise<NodeResult<S>>;

// Workflow node definition
export interface WorkflowNode<S = WorkflowState> {
  name: string;
  fn: NodeFn<S>;
  config?: NodeConfig;
}

// Edge types for DAG connections
export type Edge =
  | SequentialEdge
  | ConditionalEdge
  | ParallelEdge
  | LoopEdge;

export interface SequentialEdge {
  type: 'sequential';
  from: string;
  to: string;
}

export interface ConditionalEdge {
  type: 'conditional';
  from: string;
  condition: (state: unknown) => string | string[];
  targets: string[];
}

export interface ParallelEdge {
  type: 'parallel';
  from: string;
  to: string[];
}

export interface LoopEdge {
  type: 'loop';
  from: string;
  condition: (state: unknown) => boolean;
  back: string;
  exit: string;
}

// Workflow definition
export interface Workflow<S = WorkflowState> {
  name: string;
  initialState: S;
  nodes: Map<string, WorkflowNode<S>>;
  edges: Edge[];
  entryPoint: string;
}

// Execution options
export interface WorkflowExecuteOptions {
  maxConcurrency?: number;
  maxIterations?: number;
  checkpoint?: boolean;
  onNodeStart?: (node: string) => void;
  onNodeComplete?: (node: string, result: unknown, duration: number) => void;
  onNodeError?: (node: string, error: Error) => void;
}

// Execution result
export interface WorkflowResult<S = WorkflowState> {
  workflowId: string;
  workflowName: string;
  state: S;
  nodeResults: Map<string, { output: unknown; duration: number }>;
  duration: number;
  checkpointId?: string;
  error?: Error;
}

// Workflow events for streaming
export type WorkflowEvent =
  | { type: 'node:start'; node: string; timestamp: number }
  | { type: 'node:complete'; node: string; output: unknown; duration: number }
  | { type: 'node:error'; node: string; error: Error }
  | { type: 'workflow:complete'; state: unknown; duration: number };

// Checkpoint for resume support
export interface WorkflowCheckpoint {
  id: string;
  workflowId: string;
  workflowName: string;
  state: WorkflowState;
  completedNodes: string[];
  nodeResults: Record<string, unknown>;
  timestamp: number;
}

// Checkpoint storage interface
export interface CheckpointStore {
  save(checkpoint: WorkflowCheckpoint): Promise<void>;
  load(id: string): Promise<WorkflowCheckpoint | null>;
  list(workflowName: string): Promise<WorkflowCheckpoint[]>;
  delete(id: string): Promise<void>;
}

// Node options for builder
export interface AddNodeOptions {
  after?: string[];
  config?: NodeConfig;
}

// Conditional options for builder
export interface AddConditionalOptions {
  after?: string[];
}

// Loop options for builder
export interface AddLoopOptions {
  condition: (state: unknown) => boolean;
  back: string;
  exit: string;
  after?: string[];
}
