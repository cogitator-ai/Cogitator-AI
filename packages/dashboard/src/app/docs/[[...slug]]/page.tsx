import { source } from '@/lib/source';
import { markdownPath } from '@/lib/llms';
import { DOCS_SOURCE_URL, SITE_NAME, SITE_URL } from '@/lib/site';
import { OPEN_GRAPH_BASE, socialImage } from '@/lib/seo';
import { docsLastModified, docsOgImageAlt, docsOgImagePath, docsSection } from '@/lib/docs-seo';
import { DocsPage, DocsBody, DocsDescription, DocsTitle } from 'fumadocs-ui/page';
import { MarkdownCopyButton, ViewOptionsPopover } from 'fumadocs-ui/layouts/docs/page';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '../../../../mdx-components';
import type { Metadata } from 'next';

interface PageProps {
  params: Promise<{ slug?: string[] }>;
}

export default async function Page({ params }: PageProps) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const markdownUrl = markdownPath(page);

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      <div className="flex flex-row flex-wrap items-center gap-2 border-b border-fd-border pb-6">
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover
          markdownUrl={markdownUrl}
          githubUrl={`${DOCS_SOURCE_URL}/${page.path}`}
          pageUrl={`${SITE_URL}${page.url}`}
        />
      </div>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const { title, description } = page.data;
  const socialTitle = `${title} | ${SITE_NAME} Docs`;
  const image = socialImage(docsOgImagePath(page), docsOgImageAlt(page));
  const modified = docsLastModified(page);

  return {
    title,
    description,
    alternates: {
      canonical: page.url,
      types: {
        'text/markdown': markdownPath(page),
      },
    },
    openGraph: {
      ...OPEN_GRAPH_BASE,
      type: 'article',
      url: page.url,
      title: socialTitle,
      description,
      section: docsSection(page),
      ...(modified && { modifiedTime: modified.toISOString() }),
      images: [image],
    },
    twitter: {
      card: 'summary_large_image',
      title: socialTitle,
      description,
      images: [image],
    },
  };
}
