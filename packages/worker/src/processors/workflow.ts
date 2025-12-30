/**
 * Workflow job processor
 *
 * Recreates a Workflow from serialized config and executes it.
 */

import type { WorkflowJobPayload, WorkflowJobResult } from '../types.js';

/**
 * Process a workflow job
 *
 * Note: Full workflow execution requires deserializing the workflow graph
 * and recreating node instances. This is a placeholder implementation.
 */
export async function processWorkflowJob(
  payload: WorkflowJobPayload
): Promise<WorkflowJobResult> {
  const { workflowConfig, input, runId } = payload;
  const startTime = Date.now();


  console.warn(
    `[worker] Workflow "${workflowConfig.name}" (${runId}) execution not fully implemented`
  );

  const nodeResults: Record<string, unknown> = {};
  for (const node of workflowConfig.nodes) {
    nodeResults[node.id] = {
      status: 'skipped',
      reason: 'Worker workflow execution not fully implemented',
    };
  }

  const duration = Date.now() - startTime;

  return {
    type: 'workflow',
    output: {
      input,
      warning: 'Workflow execution in worker is not fully implemented',
      workflowId: workflowConfig.id,
      workflowName: workflowConfig.name,
    },
    nodeResults,
    duration,
  };
}
