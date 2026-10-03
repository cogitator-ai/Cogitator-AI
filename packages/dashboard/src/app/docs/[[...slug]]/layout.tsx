import type { ReactNode } from 'react';
import { docsStructuredData } from '@/lib/docs-seo';
import { jsonLd } from '@/lib/seo';
import { source } from '@/lib/source';

interface LayoutProps {
  children: ReactNode;
  params: Promise<{ slug?: string[] }>;
}

/** Adds each docs page's breadcrumb and article structured data; renders no markup of its own. */
export default async function DocsPageLayout({ children, params }: LayoutProps) {
  const { slug } = await params;
  const page = source.getPage(slug);

  return (
    <>
      {page && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLd(docsStructuredData(page)) }}
        />
      )}
      {children}
    </>
  );
}
