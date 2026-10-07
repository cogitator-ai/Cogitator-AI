import { appChannelsFeature } from './app-channels.js';
import { appScriptFeature } from './app-script.js';
import { appServerFeature } from './app-server.js';
import { baseFeature } from './base.js';
import { evalsFeature } from './evals.js';
import { harnessFeature } from './harness.js';
import { mcpFeature } from './mcp.js';
import { memoryFeature } from './memory.js';
import { durableFeature, swarmsFeature, workflowsFeature } from './orchestration.js';
import { providerFeature } from './provider.js';
import { ragFeature } from './rag.js';
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
  workflowsFeature,
  durableFeature,
  swarmsFeature,
  appScriptFeature,
  appServerFeature,
  appChannelsFeature,
];
