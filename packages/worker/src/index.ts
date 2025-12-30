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

// Processors
export {
  processAgentJob,
  processWorkflowJob,
  processSwarmJob,
} from './processors/index.js';

// Types
export type {
  // Serialized configs
  SerializedAgent,
  SerializedWorkflow,
  SerializedWorkflowNode,
  SerializedWorkflowEdge,
  SerializedSwarm,
  // Job payloads
  JobPayload,
  AgentJobPayload,
  WorkflowJobPayload,
  SwarmJobPayload,
  // Job results
  JobResult,
  AgentJobResult,
  WorkflowJobResult,
  SwarmJobResult,
  // Config
  QueueConfig,
  WorkerConfig,
  QueueMetrics,
} from './types.js';
