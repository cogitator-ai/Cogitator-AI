import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { COOKBOOK_URL, SITE_NAME, SITE_URL } from '@/lib/site';
import {
  absoluteUrl,
  jsonLd,
  lastModified,
  OPEN_GRAPH_BASE,
  ORGANIZATION_ID,
  SOFTWARE_ID,
  WEBSITE_ID,
} from '@/lib/seo';
import { recipeCount, sections } from './recipes';
import { COOKBOOK_DESCRIPTION, COOKBOOK_TITLE } from './social-card';

const socialTitle = `${COOKBOOK_TITLE} | ${SITE_NAME}`;

export const metadata: Metadata = {
  title: COOKBOOK_TITLE,
  description: COOKBOOK_DESCRIPTION,
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
  alternates: {
    canonical: COOKBOOK_URL,
  },
  openGraph: {
    ...OPEN_GRAPH_BASE,
    type: 'website',
    url: COOKBOOK_URL,
    title: socialTitle,
    description: COOKBOOK_DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    title: socialTitle,
    description: COOKBOOK_DESCRIPTION,
  },
};

const cookbookUrl = absoluteUrl(COOKBOOK_URL);
const modified = lastModified('src/app/cookbook');

/** The cookbook as a collection page whose main entity is the ordered list of its recipes. */
const structuredData = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'CollectionPage',
      '@id': `${cookbookUrl}#page`,
      url: cookbookUrl,
      name: socialTitle,
      description: COOKBOOK_DESCRIPTION,
      inLanguage: 'en',
      image: absoluteUrl(`${COOKBOOK_URL}/opengraph-image`),
      ...(modified && { dateModified: modified.toISOString() }),
      isPartOf: { '@id': WEBSITE_ID },
      about: { '@id': SOFTWARE_ID },
      publisher: { '@id': ORGANIZATION_ID },
      breadcrumb: { '@id': `${cookbookUrl}#breadcrumb` },
      mainEntity: { '@id': `${cookbookUrl}#recipes` },
    },
    {
      '@type': 'BreadcrumbList',
      '@id': `${cookbookUrl}#breadcrumb`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: SITE_NAME, item: SITE_URL },
        { '@type': 'ListItem', position: 2, name: COOKBOOK_TITLE, item: cookbookUrl },
      ],
    },
    {
      '@type': 'ItemList',
      '@id': `${cookbookUrl}#recipes`,
      name: `${SITE_NAME} recipes`,
      numberOfItems: recipeCount,
      itemListOrder: 'https://schema.org/ItemListOrderAscending',
      itemListElement: sections
        .flatMap((section) => section.recipes)
        .map((recipe, index) => ({
          '@type': 'ListItem',
          position: index + 1,
          name: recipe.title,
          description: recipe.problem,
          url: `${cookbookUrl}#${recipe.id}`,
        })),
    },
  ],
};

export default function CookbookLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd(structuredData) }}
      />
      {children}
    </>
  );
}
