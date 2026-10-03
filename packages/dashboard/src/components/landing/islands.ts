'use client';

import { island } from './island';
import { preloadDemo } from './sections/explorer/demos';

/** Below-the-fold sections: server-rendered, made live with their JS once they near the viewport. */

export const WorkflowRunIsland = island(() =>
  import('./sections/workflows/WorkflowRun').then((module) => module.WorkflowRun)
);

export const SwarmShowcaseIsland = island(() =>
  import('./sections/swarms/SwarmShowcase').then((module) => module.SwarmShowcase)
);

export const ExplorerIsland = island(
  () => import('./sections/explorer/Explorer').then((module) => module.Explorer),
  { prepare: ({ features }) => (features[0] ? preloadDemo(features[0].id) : Promise.resolve()) }
);

export const RuntimeSwitcherIsland = island(() =>
  import('./sections/anywhere/RuntimeSwitcher').then((module) => module.RuntimeSwitcher)
);

export const AgentTerminalIsland = island(() =>
  import('./sections/agent-friendly/AgentTerminal').then((module) => module.AgentTerminal)
);
