import type { ReactNode } from 'react';

/** One capability in the feature explorer. */
export interface ExplorerFeature {
  id: string;
  /** npm package (or packages) that ship it, e.g. '@cogitator-ai/rag'. */
  pkg: string;
  title: string;
  /** One sentence, shown under the title. */
  summary: string;
  /** Docs page path, e.g. '/docs/rag'. */
  href: string;
  /** Server-highlighted snippet (highlightCode). */
  code: ReactNode;
  /** A client component element with no props that animates on mount and loops. */
  demo: ReactNode;
}
