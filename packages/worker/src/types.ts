/**
 * Worker types for distributed job processing
 */

import type { Cogitator } from '@cogitator-ai/core';
import type {
  AgentWireConfig,
  AgentWireResponseFormat,
  AgentWireRunResult,
  AgentWireUsage,
  RunCheckpoint,
  Tool,
  ToolApprovalDecision,
} from '@cogitator-ai/types';
import type {
  SwarmAgentJobPayload as SwarmAgentJobContract,
  SwarmAgentJobResult as SwarmAgentJobResultContract,
} from '@cogitator-ai/swarms';

/**
 * An agent's response format in a form that travels through the queue: a Zod schema becomes
 * JSON Schema (see `serializeAgent`), and the worker turns it back into a schema to validate the
 * run's structured output.
 */
export type SerializedResponseFormat = AgentWireResponseFormat;

/**
 * An agent as a job carries it: the agent wire format of `@cogitator-ai/core`, shared by agent,
 * workflow and swarm jobs and by distributed swarm turns. Build it with `serializeAgent`, or
 * write it by hand. Tools travel as schemas and are resolved by name from the worker's tool
 * registry. A config with a key the worker does not know is refused, so a newer producer never
 * runs an agent without a setting it asked for.
 */
export type SerializedAgent = AgentWireConfig;

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
  /**
   * State key that receives the agent's answer (default: node id): its validated structured
   * answer when the agent has a JSON schema response format and the answer fits, its text
   * otherwise
   */
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
 * How a swarm job's agents work together:
 * - `sequential`: a pipeline, each agent working on the previous agent's output
 * - `hierarchical`: the coordinator supervises the agents and delegates to them
 * - `collaborative`: in each of `maxRounds` rounds every agent contributes in turn, seeing the
 *   task and all contributions so far; the coordinator, if any, combines them into the answer,
 *   otherwise the last contribution is the answer
 * - `debate`: the agents debate for `maxRounds` rounds, the coordinator moderates
 * - `voting`: the agents vote until `consensusThreshold` is reached, the coordinator breaks ties
 */
export type SwarmTopology = 'sequential' | 'hierarchical' | 'collaborative' | 'debate' | 'voting';

/**
 * Serialized swarm configuration
 */
export interface SerializedSwarm {
  topology: SwarmTopology;
  agents: SerializedAgent[];
  coordinator?: SerializedAgent;
  maxRounds?: number;
  consensusThreshold?: number;
}

/**
 * How an agent job continues a run that paused for tool approvals, see `JobQueue.resumeAgentJob`.
 */
export interface AgentJobResume {
  /**
   * The paused run's checkpoint, as the paused job's result carries it. Without it the worker
   * looks the run up by the job's `threadId` in its Cogitator's `runCheckpoints` store, which
   * then has to be shared by the workers (a memory adapter or your own store)
   */
  checkpoint?: RunCheckpoint;
  /** Decisions for the waiting calls, by tool call id; calls left out pause the run again */
  decisions?: Record<string, ToolApprovalDecision>;
  /** Decision for every waiting call `decisions` leaves out, e.g. one "approve all" answer */
  defaultDecision?: ToolApprovalDecision;
}

export interface AgentJobPayload {
  type: 'agent';
  jobId: string;
  agentConfig: SerializedAgent;
  /** The task; unused when the job resumes a paused run */
  input: string;
  threadId: string;
  /** User the run acts for: owns the thread, see `RunOptions.userId` */
  userId?: string;
  /** Continue a paused run with these decisions instead of starting a new one */
  resume?: AgentJobResume;
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

/** What an agent run used and cost, as `RunResult.usage` reports it. */
export type AgentJobUsage = AgentWireUsage;

/**
 * The outcome of an agent job, in the run result wire format: the answer, the structured output,
 * usage with cost, tool calls with their outputs, and the flags that say the answer was cut off
 * (`truncated`), withheld (`blocked`) or given at the iteration limit. A run that paused for tool
 * approvals completes the job with `status: 'paused'`, the calls in `pendingApprovals` and the
 * `checkpoint`: its `output` is not the answer, and `JobQueue.resumeAgentJob` continues it once
 * the calls are decided.
 */
export interface AgentJobResult extends AgentWireRunResult {
  type: 'agent';
  /** @deprecated Use `usage`, which also carries the cost */
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
  /**
   * Redis connection config. `url` (`redis://user:password@host:port/db`, or `rediss://` for
   * TLS) is read first, and the explicit fields override what it says
   */
  redis: {
    url?: string;
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    db?: number;
    /** Connect over TLS; implied by a `rediss://` url */
    tls?: boolean;
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
 * How one job runs on this worker.
 */
export interface JobExecutionOptions {
  /**
   * Cancels the job: agent runs, workflow nodes and swarm turns in flight are aborted and no
   * further one starts. `WorkerPool` passes the signal BullMQ gives each job, so
   * `WorkerPool.cancelJob()` and a shutdown that runs out of time stop the work
   */
  signal?: AbortSignal;
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

/**
 * State of a queued job, as `JobQueue.getJobState()` reports it:
 * - `waiting`: ready to run, in arrival order
 * - `prioritized`: ready to run, added with a `priority` (lower runs first, jobs without
 *   a priority run before prioritized ones)
 * - `delayed`: added with a `delay`, or waiting for its next retry
 * - `active`: being processed by a worker
 * - `completed` / `failed`: finished (`failed` after its last attempt)
 * - `waiting-children`: a parent job of a BullMQ flow waiting for its children
 * - `unknown`: not in the queue (never added, or removed after finishing)
 */
export type JobState =
  | 'waiting'
  | 'prioritized'
  | 'delayed'
  | 'active'
  | 'completed'
  | 'failed'
  | 'waiting-children'
  | 'unknown';

export interface QueueMetrics {
  /** Jobs ready to be processed, prioritized jobs included */
  waiting: number;
  /** Jobs currently being processed */
  active: number;
  /** Jobs completed successfully */
  completed: number;
  /** Jobs that failed */
  failed: number;
  /** Jobs scheduled for later */
  delayed: number;
  /** Total queue depth (waiting + delayed), the metric to scale workers on */
  depth: number;
  /** Number of active workers */
  workerCount: number;
}
