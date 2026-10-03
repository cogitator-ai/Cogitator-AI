import type * as PageTree from 'fumadocs-core/page-tree';
import { getDocsSections, type DocsPage } from '@/lib/llms';
import { source } from '@/lib/source';
import { DOCS_HOME, SITE_NAME } from '@/lib/site';
import { absoluteUrl, lastModified, ORGANIZATION_ID, SOFTWARE_ID, WEBSITE_ID } from '@/lib/seo';

/** File name every docs card is served under, so crawlers see a `.png` URL. */
export const DOCS_OG_IMAGE_FILE = 'image.png';

/** Path of a docs page's social card, e.g. `/og/docs/core/agents/image.png`. */
export function docsOgImagePath(page: DocsPage): string {
  return ['/og/docs', ...page.slugs, DOCS_OG_IMAGE_FILE].join('/');
}

export function docsOgImageAlt(page: DocsPage): string {
  return `${page.data.title} - ${SITE_NAME} documentation`;
}

let sectionByUrl: Map<string, string> | undefined;

/** Sidebar section a docs page sits under, such as "Memory & RAG". */
export function docsSection(page: DocsPage): string {
  sectionByUrl ??= new Map(
    getDocsSections().flatMap((section) =>
      section.pages.map((sectionPage) => [sectionPage.url, section.title] as const)
    )
  );
  return sectionByUrl.get(page.url) ?? 'Docs';
}

/** When the page's MDX source last changed (see {@link lastModified}). */
export function docsLastModified(page: DocsPage): Date | undefined {
  return lastModified(page.data.info.fullPath);
}

interface Crumb {
  name: string;
  url: string;
}

/** The sidebar folder whose landing page (index or first child) is served at `url`. */
function folderLandingAt(
  url: string,
  node: PageTree.Root | PageTree.Folder
): PageTree.Folder | undefined {
  for (const child of node.children) {
    if (child.type !== 'folder') continue;
    const landsHere =
      child.index?.url === url ||
      child.children.some((grandchild) => grandchild.type === 'page' && grandchild.url === url);
    if (landsHere) return child;
    const nested = folderLandingAt(url, child);
    if (nested) return nested;
  }
  return undefined;
}

/**
 * Home → Docs → parent sections → page. A parent appears when a page is served at its path
 * (e.g. `/docs/memory`), named after its sidebar folder; parents without a page of their own
 * are left out, since every breadcrumb item but the last must link somewhere.
 */
export function docsBreadcrumbs(page: DocsPage): Crumb[] {
  const crumbs: Crumb[] = [
    { name: SITE_NAME, url: '/' },
    { name: 'Docs', url: DOCS_HOME },
  ];
  if (page.url === DOCS_HOME) return crumbs;

  for (let depth = 1; depth < page.slugs.length; depth++) {
    const parent = source.getPage(page.slugs.slice(0, depth));
    if (!parent) continue;
    const folder = folderLandingAt(parent.url, source.pageTree);
    const name = typeof folder?.name === 'string' ? folder.name : parent.data.title;
    crumbs.push({ name, url: parent.url });
  }
  crumbs.push({ name: page.data.title, url: page.url });
  return crumbs;
}

/** `BreadcrumbList` and `TechArticle` for one docs page. */
export function docsStructuredData(page: DocsPage): object {
  const url = absoluteUrl(page.url);
  const modified = docsLastModified(page);

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumb`,
        itemListElement: docsBreadcrumbs(page).map((crumb, index) => ({
          '@type': 'ListItem',
          position: index + 1,
          name: crumb.name,
          item: absoluteUrl(crumb.url),
        })),
      },
      {
        '@type': 'TechArticle',
        '@id': `${url}#article`,
        headline: page.data.title,
        description: page.data.description,
        url,
        mainEntityOfPage: url,
        image: absoluteUrl(docsOgImagePath(page)),
        inLanguage: 'en',
        articleSection: docsSection(page),
        ...(modified && { dateModified: modified.toISOString() }),
        isPartOf: { '@id': WEBSITE_ID },
        about: { '@id': SOFTWARE_ID },
        author: { '@id': ORGANIZATION_ID },
        publisher: { '@id': ORGANIZATION_ID },
        breadcrumb: { '@id': `${url}#breadcrumb` },
      },
    ],
  };
}
