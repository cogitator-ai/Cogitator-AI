import type { ReactNode } from 'react';

/** Every capability in the explorer; each id has a live demo in `demos.tsx`. */
export type FeatureId =
  | 'memory'
  | 'rag'
  | 'mcp'
  | 'a2a'
  | 'channels'
  | 'voice'
  | 'browser'
  | 'evals'
  | 'sandbox'
  | 'safety'
  | 'observability'
  | 'handoffs'
  | 'reasoning'
  | 'time-travel'
  | 'prompt-versions'
  | 'neuro-symbolic'
  | 'ship';

/** One capability in the feature explorer. */
export interface ExplorerFeature {
  /** Also picks the live demo, which loads only when its feature is shown. */
  id: FeatureId;
  /** npm package (or packages) that ship it, e.g. '@cogitator-ai/rag'. */
  pkg: string;
  title: string;
  /** One sentence, shown under the title. */
  summary: string;
  /** Docs page path, e.g. '/docs/rag'. */
  href: string;
  /** Server-highlighted snippet (highlightCode). */
  code: ReactNode;
}
