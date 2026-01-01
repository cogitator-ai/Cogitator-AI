import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Cookbook - Cogitator',
  description:
    'Practical recipes for building AI agents, workflows, and swarms with Cogitator. Copy-paste examples for every feature.',
  keywords: [
    'AI agent cookbook',
    'LLM recipes',
    'Cogitator examples',
    'agent patterns',
    'workflow examples',
    'swarm patterns',
    'TypeScript AI',
    'self-modifying agents',
    'causal reasoning',
    'neuro-symbolic AI',
  ],
  openGraph: {
    title: 'Cogitator Cookbook',
    description: '44 practical recipes for building production AI agents.',
    type: 'website',
  },
};

export default function CookbookLayout({ children }: { children: React.ReactNode }) {
  return children;
}
