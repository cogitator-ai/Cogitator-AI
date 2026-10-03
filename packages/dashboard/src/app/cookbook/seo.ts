import type { Metadata } from 'next';
import { COOKBOOK_URL, GITHUB_URL, SITE_NAME, SITE_URL } from '@/lib/site';
import {
  absoluteUrl,
  lastModified,
  OPEN_GRAPH_BASE,
  ORGANIZATION_ID,
  SOFTWARE_ID,
  socialImage,
  WEBSITE_ID,
} from '@/lib/seo';
import { recipeCount, type Difficulty, type Recipe, type Section } from './recipes';
import { recipeEntries, recipePath, sectionPath } from './routes';
import { COOKBOOK_DESCRIPTION, COOKBOOK_TITLE } from './social-card';

/** File name every cookbook card is served under, so crawlers see a `.png` URL. */
export const COOKBOOK_OG_IMAGE_FILE = 'image.png';

const OG_IMAGE_ROOT = '/og/cookbook';

const COOKBOOK_PAGE_ID = `${absoluteUrl(COOKBOOK_URL)}#page`;

/** Path of a section's social card, e.g. `/og/cookbook/agents/image.png`. */
export function sectionOgImagePath(section: Pick<Section, 'id'>): string {
  return `${OG_IMAGE_ROOT}/${section.id}/${COOKBOOK_OG_IMAGE_FILE}`;
}

/** Path of a recipe's social card, e.g. `/og/cookbook/agents/approvals/image.png`. */
export function recipeOgImagePath(
  section: Pick<Section, 'id'>,
  recipe: Pick<Recipe, 'id'>
): string {
  return `${OG_IMAGE_ROOT}/${section.id}/${recipe.id}/${COOKBOOK_OG_IMAGE_FILE}`;
}

/** Recipe text without the backticks that mark inline code on the page. */
export function plainText(text: string): string {
  return text.replace(/`/g, '');
}

/** When the cookbook's sources last changed (see {@link lastModified}). */
export function cookbookLastModified(): Date | undefined {
  return lastModified('src/app/cookbook');
}

/**
 * When a section's recipe data last changed. Each section lives in `recipes/<section id>.ts`;
 * the whole recipes directory stands in if a section is ever stored elsewhere.
 */
export function sectionLastModified(section: Pick<Section, 'id'>): Date | undefined {
  return (
    lastModified(`src/app/cookbook/recipes/${section.id}.ts`) ??
    lastModified('src/app/cookbook/recipes')
  );
}

interface Crumb {
  name: string;
  path: string;
}

function cookbookCrumbs(section?: Section, recipe?: Recipe): Crumb[] {
  const crumbs: Crumb[] = [
    { name: SITE_NAME, path: '/' },
    { name: COOKBOOK_TITLE, path: COOKBOOK_URL },
  ];
  if (section) crumbs.push({ name: section.title, path: sectionPath(section) });
  if (section && recipe) crumbs.push({ name: recipe.title, path: recipePath(section, recipe) });
  return crumbs;
}

function breadcrumbList(url: string, crumbs: Crumb[]) {
  return {
    '@type': 'BreadcrumbList',
    '@id': `${url}#breadcrumb`,
    itemListElement: crumbs.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.name,
      item: crumb.path === '/' ? SITE_URL : absoluteUrl(crumb.path),
    })),
  };
}

function recipeList(id: string, name: string, entries: { section: Section; recipe: Recipe }[]) {
  return {
    '@type': 'ItemList',
    '@id': id,
    name,
    numberOfItems: entries.length,
    itemListOrder: 'https://schema.org/ItemListOrderAscending',
    itemListElement: entries.map(({ section, recipe }, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: recipe.title,
      description: plainText(recipe.problem),
      url: absoluteUrl(recipePath(section, recipe)),
    })),
  };
}

const socialTitleOverview = `${COOKBOOK_TITLE} | ${SITE_NAME}`;

export const overviewMetadata: Metadata = {
  title: COOKBOOK_TITLE,
  description: COOKBOOK_DESCRIPTION,
  alternates: { canonical: COOKBOOK_URL },
  openGraph: {
    ...OPEN_GRAPH_BASE,
    type: 'website',
    url: COOKBOOK_URL,
    title: socialTitleOverview,
    description: COOKBOOK_DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    title: socialTitleOverview,
    description: COOKBOOK_DESCRIPTION,
  },
};

/** The cookbook as a collection page whose main entity is the ordered list of its recipes. */
export function overviewStructuredData(): object {
  const url = absoluteUrl(COOKBOOK_URL);
  const modified = cookbookLastModified();
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        '@id': COOKBOOK_PAGE_ID,
        url,
        name: socialTitleOverview,
        description: COOKBOOK_DESCRIPTION,
        inLanguage: 'en',
        image: absoluteUrl(`${COOKBOOK_URL}/opengraph-image`),
        ...(modified && { dateModified: modified.toISOString() }),
        isPartOf: { '@id': WEBSITE_ID },
        about: { '@id': SOFTWARE_ID },
        publisher: { '@id': ORGANIZATION_ID },
        breadcrumb: { '@id': `${url}#breadcrumb` },
        mainEntity: { '@id': `${url}#recipes` },
      },
      breadcrumbList(url, cookbookCrumbs()),
      recipeList(`${url}#recipes`, `${SITE_NAME} recipes (${recipeCount})`, recipeEntries),
    ],
  };
}

function sectionDescription(section: Section): string {
  return `${section.recipes.length} runnable ${SITE_NAME} ${section.recipes.length === 1 ? 'recipe' : 'recipes'}: ${section.description}`;
}

export function sectionMetadata(section: Section): Metadata {
  const path = sectionPath(section);
  const title = `${section.title} recipes`;
  const socialTitle = `${title} | ${SITE_NAME} Cookbook`;
  const description = sectionDescription(section);
  const image = socialImage(
    sectionOgImagePath(section),
    `${section.title} - ${SITE_NAME} Cookbook`
  );
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      ...OPEN_GRAPH_BASE,
      type: 'website',
      url: path,
      title: socialTitle,
      description,
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

/** `CollectionPage` with the section's recipes, and its `BreadcrumbList`. */
export function sectionStructuredData(section: Section): object {
  const url = absoluteUrl(sectionPath(section));
  const modified = sectionLastModified(section);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        '@id': `${url}#page`,
        url,
        name: `${section.title} recipes | ${SITE_NAME} Cookbook`,
        description: sectionDescription(section),
        inLanguage: 'en',
        image: absoluteUrl(sectionOgImagePath(section)),
        ...(modified && { dateModified: modified.toISOString() }),
        isPartOf: { '@id': COOKBOOK_PAGE_ID },
        about: { '@id': SOFTWARE_ID },
        publisher: { '@id': ORGANIZATION_ID },
        breadcrumb: { '@id': `${url}#breadcrumb` },
        mainEntity: { '@id': `${url}#recipes` },
      },
      breadcrumbList(url, cookbookCrumbs(section)),
      recipeList(
        `${url}#recipes`,
        `${section.title} recipes`,
        section.recipes.map((recipe) => ({ section, recipe }))
      ),
    ],
  };
}

export function recipeMetadata(section: Section, recipe: Recipe): Metadata {
  const path = recipePath(section, recipe);
  const socialTitle = `${recipe.title} | ${SITE_NAME} Cookbook`;
  const description = plainText(recipe.problem);
  const modified = sectionLastModified(section);
  const image = socialImage(
    recipeOgImagePath(section, recipe),
    `${recipe.title} - ${SITE_NAME} Cookbook recipe`
  );
  return {
    title: `${recipe.title} - ${COOKBOOK_TITLE}`,
    description,
    alternates: { canonical: path },
    openGraph: {
      ...OPEN_GRAPH_BASE,
      type: 'article',
      url: path,
      title: socialTitle,
      description,
      section: section.title,
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

const proficiency: Partial<Record<Difficulty, string>> = {
  easy: 'Beginner',
  advanced: 'Expert',
};

/** `"10 min"` as an ISO 8601 duration (`PT10M`); `undefined` for any other shape. */
function isoDuration(time: string): string | undefined {
  const minutes = /^(\d+)\s*min$/.exec(time.trim())?.[1];
  return minutes ? `PT${minutes}M` : undefined;
}

/** `TechArticle` for one recipe, with its source as a `SoftwareSourceCode` part, and its breadcrumbs. */
export function recipeStructuredData(section: Section, recipe: Recipe): object {
  const url = absoluteUrl(recipePath(section, recipe));
  const modified = sectionLastModified(section);
  const level = proficiency[recipe.difficulty];
  const duration = isoDuration(recipe.time);

  return {
    '@context': 'https://schema.org',
    '@graph': [
      breadcrumbList(url, cookbookCrumbs(section, recipe)),
      {
        '@type': 'TechArticle',
        '@id': `${url}#article`,
        headline: recipe.title,
        description: plainText(recipe.problem),
        url,
        mainEntityOfPage: url,
        image: absoluteUrl(recipeOgImagePath(section, recipe)),
        inLanguage: 'en',
        articleSection: section.title,
        ...(level && { proficiencyLevel: level }),
        ...(duration && { timeRequired: duration }),
        ...(modified && { dateModified: modified.toISOString() }),
        isPartOf: { '@id': `${absoluteUrl(sectionPath(section))}#page` },
        about: { '@id': SOFTWARE_ID },
        author: { '@id': ORGANIZATION_ID },
        publisher: { '@id': ORGANIZATION_ID },
        breadcrumb: { '@id': `${url}#breadcrumb` },
        hasPart: {
          '@type': 'SoftwareSourceCode',
          name: recipe.file,
          programmingLanguage: 'TypeScript',
          codeSampleType: 'full solution',
          ...(recipe.example && {
            codeRepository: GITHUB_URL,
            url: `${GITHUB_URL}/blob/main/examples/${recipe.example}`,
          }),
        },
      },
    ],
  };
}
