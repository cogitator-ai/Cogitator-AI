import { notFound } from 'next/navigation';
import { source } from '@/lib/source';
import { MARKDOWN_HEADERS, renderPageMarkdown } from '@/lib/llms';

export const revalidate = false;

interface RouteProps {
  params: Promise<{ slug?: string[] }>;
}

export async function GET(_request: Request, { params }: RouteProps) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  return new Response(await renderPageMarkdown(page), { headers: MARKDOWN_HEADERS });
}

export function generateStaticParams() {
  return source.generateParams();
}
