import { notFound } from 'next/navigation';
import { DOCS_OG_IMAGE_FILE, docsSection } from '@/lib/docs-seo';
import { renderOgCard } from '@/lib/og-image';
import { source } from '@/lib/source';

export const dynamic = 'force-static';

export const dynamicParams = false;

interface RouteProps {
  params: Promise<{ slug: string[] }>;
}

/** Social card of one docs page, prerendered at build time for every page. */
export async function GET(_request: Request, { params }: RouteProps) {
  const { slug } = await params;
  if (slug.at(-1) !== DOCS_OG_IMAGE_FILE) notFound();

  const pageSlugs = slug.slice(0, -1);
  const page = source.getPage(pageSlugs);
  if (!page) notFound();

  return renderOgCard({
    plaque: 'documentation',
    status: `Docs · ${docsSection(page)}`,
    title: page.data.title,
    description: page.data.description,
    prompt: ['docs', ...pageSlugs].join(' / '),
  });
}

export function generateStaticParams(): { slug: string[] }[] {
  return source.getPages().map((page) => ({ slug: [...page.slugs, DOCS_OG_IMAGE_FILE] }));
}
