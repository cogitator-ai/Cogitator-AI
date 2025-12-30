/**
 * Worker types for distributed job processing
 */

import type { ToolSchema } from '@cogitator/types';


/**
 * Serialized agent configuration for queue transport
 * Tools are stored as schemas, recreated on worker side
 */
export interface SerializedAgent {
  name: string;
  instructions: string;
  model: string;
  provider: 'ollama' | 'openai' | 'anthropic';
  temperature?: number;
  maxTokens?: number;
  tools: ToolSchema[];
}

/**
 * Serialized workflow configuration
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
  condition?: string;
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

export type JobPayload = AgentJobPayload | WorkflowJobPayload | SwarmJobPayload;


export interface AgentJobResult {
  type: 'agent';
  output: string;
  toolCalls: Array<{
    name: string;
    input: unknown;
    output: unknown;
  }>;
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
  agentOutputs: Array<{
    agent: string;
    output: string;
  }>;
}

export type JobResult = AgentJobResult | WorkflowJobResult | SwarmJobResult;


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
      nodes: Array<{ host: string; port: number }>;
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

export interface WorkerConfig extends QueueConfig {
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
