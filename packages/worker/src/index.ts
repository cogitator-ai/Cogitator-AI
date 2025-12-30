/**
 * @cogitator/worker - Distributed job queue for agent execution
 *
 * Provides BullMQ-based job processing with:
 * - Redis cluster support
 * - Auto-retry with exponential backoff
 * - Job priorities and delays
 * - Prometheus metrics for HPA
 */

export { JobQueue } from './queue.js';
export { WorkerPool, type WorkerPoolEvents } from './worker.js';
export {
  formatPrometheusMetrics,
  DurationHistogram,
  MetricsCollector,
} from './metrics.js';

export {
  processAgentJob,
  processWorkflowJob,
  processSwarmJob,
} from './processors/index.js';

export type {
  SerializedAgent,
  SerializedWorkflow,
  SerializedWorkflowNode,
  SerializedWorkflowEdge,
  SerializedSwarm,
  JobPayload,
  AgentJobPayload,
  WorkflowJobPayload,
  SwarmJobPayload,
  JobResult,
  AgentJobResult,
  WorkflowJobResult,
  SwarmJobResult,
  QueueConfig,
  WorkerConfig,
  QueueMetrics,
} from './types.js';
