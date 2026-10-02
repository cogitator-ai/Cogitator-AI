/**
 * Worker types for distributed job processing
 */

import type { Cogitator } from '@cogitator-ai/core';
import type { LLMProvider, Tool, ToolSchema } from '@cogitator-ai/types';
import type {
  SwarmAgentJobPayload as SwarmAgentJobContract,
  SwarmAgentJobResult as SwarmAgentJobResultContract,
} from '@cogitator-ai/swarms';

/**
 * Serialized agent configuration for queue transport
 * Tools are stored as schemas, recreated on worker side
 */
export interface SerializedAgent {
  name: string;
  instructions: string;
  /** Model name; may already carry a provider prefix (e.g. 'openai/gpt-6.1-sol') */
  model: string;
  /** Provider used when `model` has no provider prefix */
  provider: LLMProvider;
  temperature?: number;
  maxTokens?: number;
  maxIterations?: number;
  /** Tool schemas; tools are resolved by name from the worker's tool registry */
  tools: ToolSchema[];
}

/**
 * Serialized workflow configuration
 *
 * Workflows run as a DAG over a shared state object (initialised from the job input).
 * Node configs by type:
 * - `agent`: {@link AgentNodeConfig}
 * - `transform`: {@link TransformNodeConfig}
 * - `condition`: {@link ConditionNodeConfig}; outgoing edges use `condition: 'true' | 'false'`
 * - `parallel`: no config; a fan-out marker whose successors run concurrently
 */
export interface SerializedWorkflow {
  id: string;
  name: string;
  nodes: SerializedWorkflowNode[];
  edges: SerializedWorkflowEdge[];
}

export interface SerializedWorkflowNode {
  id: string;
  type: 'agent' | 'transform' | 'condition' | 'parallel';
  config: Record<string, unknown>;
}

export interface SerializedWorkflowEdge {
  from: string;
  to: string;
  /** Branch taken from a condition node: 'true' or 'false' */
  condition?: string;
}

export interface AgentNodeConfig {
  agentConfig: SerializedAgent;
  /** Prompt template; `{{path}}` placeholders read from workflow state. Defaults to the state as JSON */
  prompt?: string;
  /** State key that receives the agent output (default: node id) */
  outputKey?: string;
}

export type TransformOperation =
  'uppercase' | 'lowercase' | 'trim' | 'json-parse' | 'json-stringify' | 'template';

export interface TransformNodeConfig {
  transform: TransformOperation;
  /** State path to read (default: the previous node's output key) */
  inputKey?: string;
  /** State key to write (default: node id) */
  outputKey?: string;
  /** Template used by the 'template' operation */
  template?: string;
}

export type ConditionOperator = 'equals' | 'not-equals' | 'contains' | 'exists' | 'gt' | 'lt';

export interface ConditionNodeConfig {
  /** State path to test */
  key: string;
  operator: ConditionOperator;
  value?: string | number | boolean | null;
}

/**
 * Serialized swarm configuration
 */
export interface SerializedSwarm {
  topology: 'sequential' | 'hierarchical' | 'collaborative' | 'debate' | 'voting';
  agents: SerializedAgent[];
  coordinator?: SerializedAgent;
  maxRounds?: number;
  consensusThreshold?: number;
}

export interface AgentJobPayload {
  type: 'agent';
  jobId: string;
  agentConfig: SerializedAgent;
  input: string;
  threadId: string;
  metadata?: Record<string, unknown>;
}

export interface WorkflowJobPayload {
  type: 'workflow';
  jobId: string;
  workflowConfig: SerializedWorkflow;
  input: Record<string, unknown>;
  runId: string;
  metadata?: Record<string, unknown>;
}

export interface SwarmJobPayload {
  type: 'swarm';
  jobId: string;
  swarmConfig: SerializedSwarm;
  input: string;
  metadata?: Record<string, unknown>;
}

/**
 * Single agent turn of a distributed swarm (contract shared with `@cogitator-ai/swarms`)
 */
export type SwarmAgentJobPayload = SwarmAgentJobContract;

export type JobPayload =
  AgentJobPayload | WorkflowJobPayload | SwarmJobPayload | SwarmAgentJobPayload;

export interface AgentJobResult {
  type: 'agent';
  output: string;
  toolCalls: {
    name: string;
    input: unknown;
    output: unknown;
  }[];
  tokenUsage?: {
    prompt: number;
    completion: number;
    total: number;
  };
}

export interface WorkflowJobResult {
  type: 'workflow';
  output: Record<string, unknown>;
  nodeResults: Record<string, unknown>;
  duration: number;
}

export interface SwarmJobResult {
  type: 'swarm';
  output: string;
  rounds: number;
  agentOutputs: {
    agent: string;
    output: string;
  }[];
}

export interface SwarmAgentJobResult extends SwarmAgentJobResultContract {
  type: 'swarm-agent';
}

export type JobResult = AgentJobResult | WorkflowJobResult | SwarmJobResult | SwarmAgentJobResult;

export interface QueueConfig {
  /** Queue name (default: 'cogitator-jobs') */
  name?: string;
  /** Redis connection config */
  redis: {
    host?: string;
    port?: number;
    password?: string;
    /** For cluster mode */
    cluster?: {
      nodes: { host: string; port: number }[];
    };
  };
  /** Default job options */
  defaultJobOptions?: {
    /** Max attempts before failing */
    attempts?: number;
    /** Backoff strategy */
    backoff?: {
      type: 'exponential' | 'fixed';
      delay: number;
    };
    /** Remove job after completion */
    removeOnComplete?: boolean | number;
    /** Remove job after failure */
    removeOnFail?: boolean | number;
  };
}

/**
 * Runtime dependencies used to execute jobs on a worker
 */
export interface WorkerRuntime {
  /** Cogitator used to run agents (provider keys, memory, etc). Default: `new Cogitator()` */
  cogitator?: Cogitator;
  /**
   * Tool implementations available on this worker. Serialized agents reference tools by
   * name; a job that needs a tool missing from this list fails.
   */
  tools?: Tool[];
}

export interface WorkerConfig extends QueueConfig, WorkerRuntime {
  /** Number of worker instances */
  workerCount?: number;
  /** Concurrent jobs per worker */
  concurrency?: number;
  /** Lock duration in ms */
  lockDuration?: number;
  /** Stalled job check interval */
  stalledInterval?: number;
}

export interface QueueMetrics {
  /** Jobs waiting to be processed */
  waiting: number;
  /** Jobs currently being processed */
  active: number;
  /** Jobs completed successfully */
  completed: number;
  /** Jobs that failed */
  failed: number;
  /** Jobs scheduled for later */
  delayed: number;
  /** Total queue depth (waiting + delayed) */
  depth: number;
  /** Number of active workers */
  workerCount: number;
}
