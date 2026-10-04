import type { StageDefinition } from '../runner/types.js';
import { browserStages } from './edges/browser.js';
import { channelStages } from './edges/channels.js';
import { configStages } from './edges/config.js';
import { evalStages } from './edges/evals.js';
import { logicStages } from './edges/logic.js';
import { testingStages } from './edges/testing.js';
import { toolingStages } from './edges/tooling.js';
import { voiceStages } from './edges/voice.js';

/** Config, tooling, channels, voice, browser, evals, logic and testing utilities. */
export const edgeStages: StageDefinition[] = [
  ...configStages,
  ...toolingStages,
  ...channelStages,
  ...voiceStages,
  ...browserStages,
  ...evalStages,
  ...logicStages,
  ...testingStages,
];
