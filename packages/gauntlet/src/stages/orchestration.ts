import type { StageDefinition } from '../runner/types.js';
import { swarmStages } from './orchestration/swarms.js';
import { workerStages } from './orchestration/worker.js';
import { workflowStages } from './orchestration/workflow.js';

/**
 * Multi-agent and durable execution. The newsroom story: editors on three vendors vote on a
 * topic and reporters bid for it (swarms), a durable workflow drafts, waits for an editor and
 * publishes the article (workflows), and wire jobs and a distributed desk run on Redis
 * workers (worker).
 */
export const orchestrationStages: StageDefinition[] = [
  ...swarmStages,
  ...workflowStages,
  ...workerStages,
];
