import type { Metadata } from 'next';
import { recipeCount } from './recipes';

export const metadata: Metadata = {
  title: 'Cookbook',
  description: `${recipeCount} runnable, type-checked recipes for building AI agents with Cogitator: tools, memory and RAG, workflows, swarms, MCP and A2A, servers, voice, browser agents and more.`,
  keywords: [
    'AI agent cookbook',
    'LLM recipes',
    'Cogitator examples',
    'agent patterns',
    'workflow examples',
    'swarm patterns',
    'TypeScript AI',
    'MCP server',
    'RAG pipeline',
    'voice agents',
  ],
};

export default function CookbookLayout({ children }: { children: React.ReactNode }) {
  return children;
}
