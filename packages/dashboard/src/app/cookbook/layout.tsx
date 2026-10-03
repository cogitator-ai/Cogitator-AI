import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { CookbookShell } from './components/CookbookShell';

/** Shared by every cookbook route; each page sets its own title, description, canonical and cards. */
export const metadata: Metadata = {
  keywords: [
    'AI agent cookbook',
    'AI agent examples',
    'LLM recipes',
    'TypeScript AI agents',
    'agent patterns',
    'workflow examples',
    'multi-agent swarms',
    'RAG pipeline',
    'MCP server',
    'voice agents',
    'browser agents',
  ],
};

export default function CookbookLayout({ children }: { children: ReactNode }) {
  return <CookbookShell>{children}</CookbookShell>;
}
