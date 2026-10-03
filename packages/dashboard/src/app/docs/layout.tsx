import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { ChefHat, MessagesSquare } from 'lucide-react';
import { source } from '@/lib/source';
import { COMMUNITY, COOKBOOK_URL, GITHUB_URL } from '@/lib/site';
import type { ReactNode } from 'react';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: {
    default: 'Documentation',
    template: '%s | Cogitator Docs',
  },
  description:
    'Complete documentation for Cogitator — the self-hosted AI agent orchestration platform.',
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{
        title: 'Cogitator',
        url: '/',
      }}
      githubUrl={GITHUB_URL}
      links={[
        {
          text: 'Cookbook',
          url: COOKBOOK_URL,
          icon: <ChefHat />,
          active: 'nested-url',
        },
        {
          text: COMMUNITY.name,
          url: COMMUNITY.url,
          icon: <MessagesSquare />,
          external: true,
        },
      ]}
      sidebar={{
        defaultOpenLevel: 1,
      }}
    >
      {children}
    </DocsLayout>
  );
}
