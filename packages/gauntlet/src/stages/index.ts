import type { StageDefinition } from '../runner/types.js';
import { coreStages } from './core.js';
import { coverageStage } from './coverage.js';
import { dataStages } from './data.js';
import { edgeStages } from './edges.js';
import { orchestrationStages } from './orchestration.js';
import { protocolStages } from './protocols.js';
import { serverStages } from './servers.js';

const areaStages: StageDefinition[] = [
  ...coreStages,
  ...dataStages,
  ...protocolStages,
  ...orchestrationStages,
  ...serverStages,
  ...edgeStages,
];

/** Every gauntlet stage, in display order; the coverage check comes last. */
export const stages: StageDefinition[] = [...areaStages, coverageStage(areaStages)];
