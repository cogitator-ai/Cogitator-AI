/**
 * Workflow job processor
 *
 * Workflow execution in a distributed worker requires a serialization protocol
 * for the workflow graph (nodes, edges, conditions). This is planned but not
 * yet implemented. The processor throws so BullMQ properly marks the job as failed.
 */

import type { WorkflowJobPayload, WorkflowJobResult } from '../types';

export async function processWorkflowJob(_payload: WorkflowJobPayload): Promise<WorkflowJobResult> {
  throw new Error(
    'Workflow job processing is not yet implemented. ' +
      'Workflows require a graph deserialization protocol that is currently in development. ' +
      'Use direct WorkflowExecutor instead.'
  );
}
