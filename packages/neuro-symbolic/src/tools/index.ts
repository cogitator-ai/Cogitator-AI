import type { GraphAdapter } from '@cogitator-ai/types';
import { NeuroSymbolic, createNeuroSymbolic, type NeuroSymbolicOptions } from '../orchestrator';
import { createLogicTools } from './logic-tools';
import { createConstraintTools } from './constraint-tools';
import { createPlanningTools } from './planning-tools';
import { createGraphTools } from './graph-tools';

export interface NeuroSymbolicToolsOptions {
  instance?: NeuroSymbolic;

  graphAdapter?: GraphAdapter;

  config?: NeuroSymbolicOptions['config'];

  agentId?: string;
}

export function createNeuroSymbolicTools(options: NeuroSymbolicToolsOptions = {}) {
  const ns =
    options.instance ??
    createNeuroSymbolic({
      config: options.config,
      graphAdapter: options.graphAdapter,
      agentId: options.agentId,
    });

  const logicTools = createLogicTools(ns);
  const constraintTools = createConstraintTools(ns);
  const planningTools = createPlanningTools(ns);

  const graphTools = options.graphAdapter ? createGraphTools(options.graphAdapter) : undefined;

  const baseTools = [
    logicTools.queryLogic,
    logicTools.assertFact,
    logicTools.loadProgram,
    constraintTools.solveConstraints,
    planningTools.validatePlan,
    planningTools.repairPlan,
    planningTools.registerAction,
  ] as const;

  const graphToolsArray = graphTools
    ? ([
        graphTools.findPath,
        graphTools.queryGraph,
        graphTools.addGraphNode,
        graphTools.addGraphEdge,
      ] as const)
    : ([] as const);

  return {
    ...logicTools,
    ...constraintTools,
    ...planningTools,
    ...(graphTools ?? {}),
    all: [...baseTools, ...graphToolsArray],
    instance: ns,
  };
}

export type NeuroSymbolicTools = ReturnType<typeof createNeuroSymbolicTools>;

export { createLogicTools } from './logic-tools';
export { createConstraintTools } from './constraint-tools';
export { createPlanningTools } from './planning-tools';
export { createGraphTools } from './graph-tools';
