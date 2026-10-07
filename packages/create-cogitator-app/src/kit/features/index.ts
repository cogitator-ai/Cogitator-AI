import { a2aFeature } from './a2a.js';
import { appChannelsFeature } from './app-channels.js';
import { appNextFeature } from './app-next.js';
import { appScriptFeature } from './app-script.js';
import { appServerFeature } from './app-server.js';
import { appWorkerFeature } from './app-worker.js';
import { deployFeature } from './deploy.js';
import { baseFeature } from './base.js';
import { evalsFeature } from './evals.js';
import { harnessFeature } from './harness.js';
import { mcpFeature } from './mcp.js';
import { observabilityFeature } from './observability.js';
import { memoryFeature } from './memory.js';
import { durableFeature, swarmsFeature, workflowsFeature } from './orchestration.js';
import { providerFeature } from './provider.js';
import { ragFeature } from './rag.js';
import { sandboxFeature } from './sandbox.js';
import { voiceFeature } from './voice.js';
import type { FeatureModule } from './types.js';

/**
 * Every feature module in the order they run. Later modules can rely on what
 * earlier ones added: the app modules see the memory and the provider, and the
 * add-ons see the app.
 */
export const FEATURE_MODULES: readonly FeatureModule[] = [
  baseFeature,
  providerFeature,
  memoryFeature,
  harnessFeature,
  evalsFeature,
  ragFeature,
  mcpFeature,
  a2aFeature,
  voiceFeature,
  observabilityFeature,
  sandboxFeature,
  deployFeature,
  workflowsFeature,
  durableFeature,
  swarmsFeature,
  appScriptFeature,
  appServerFeature,
  appChannelsFeature,
  appNextFeature,
  appWorkerFeature,
];
