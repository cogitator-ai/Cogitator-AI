/**
 * @cogitator-ai/worker - Distributed job queue for agent execution
 *
 * Provides BullMQ-based job processing with:
 * - Redis cluster support
 * - Auto-retry with exponential backoff
 * - Job priorities and delays
 * - Prometheus metrics for HPA
 * - Worker nodes for distributed swarms
 */

export { JobQueue } from './queue';
export { WorkerPool, type WorkerPoolEvents } from './worker';
export {
  DistributedSwarmWorker,
  type DistributedSwarmWorkerConfig,
  type DistributedSwarmWorkerEvents,
} from './distributed-swarm-worker';
export { formatPrometheusMetrics, DurationHistogram, MetricsCollector } from './metrics';
export { serializeAgent, serializeResponseFormat } from './serialize';
export { resolveRedisOptions, type RedisConnectionOptions } from './connection';

export {
  processAgentJob,
  processWorkflowJob,
  processSwarmJob,
  processSwarmAgentJob,
  executeSwarmAgentJob,
  buildSwarmConfig,
  validateWorkflow,
  type SwarmAgentJobOptions,
  type SwarmResultPublisher,
} from './processors/index';

export type {
  SerializedAgent,
  SerializedResponseFormat,
  AgentJobUsage,
  SerializedWorkflow,
  SerializedWorkflowNode,
  SerializedWorkflowEdge,
  AgentNodeConfig,
  TransformNodeConfig,
  TransformOperation,
  ConditionNodeConfig,
  ConditionOperator,
  SerializedSwarm,
  SwarmTopology,
  JobPayload,
  AgentJobPayload,
  WorkflowJobPayload,
  SwarmJobPayload,
  SwarmAgentJobPayload,
  JobResult,
  AgentJobResult,
  WorkflowJobResult,
  SwarmJobResult,
  SwarmAgentJobResult,
  QueueConfig,
  WorkerConfig,
  WorkerRuntime,
  JobExecutionOptions,
  QueueMetrics,
  JobState,
} from './types';
