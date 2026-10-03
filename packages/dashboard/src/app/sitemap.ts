import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';
import { docsLastModified } from '@/lib/docs-seo';
import { lastModified } from '@/lib/seo';
import { sections } from '@/app/cookbook/recipes';
import { recipePath, sectionPath } from '@/app/cookbook/routes';
import { cookbookLastModified, sectionLastModified } from '@/app/cookbook/seo';
import { COOKBOOK_URL, DOCS_HOME, LLMS_FULL_TXT_URL, LLMS_TXT_URL, SITE_URL } from '@/lib/site';

type Entry = MetadataRoute.Sitemap[number];

const DOCS_CONTENT = 'content/docs';

/** Sitemap entry; `lastModified` is left out when neither git nor the file system knows it. */
function entry(
  pathname: string,
  modified: Date | undefined,
  changeFrequency: Entry['changeFrequency'],
  priority: number
): Entry {
  return {
    url: pathname === '/' ? SITE_URL : `${SITE_URL}${pathname}`,
    ...(modified && { lastModified: modified }),
    changeFrequency,
    priority,
  };
}

/**
 * Every public page plus the agent-facing text files. Dates come from the last commit that
 * touched each page's sources (file modification time when git history is unavailable).
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const docsModified = lastModified(DOCS_CONTENT);

  const docs = source
    .getPages()
    .map((page) =>
      entry(
        page.url,
        docsLastModified(page),
        'weekly',
        page.url === DOCS_HOME ? 0.9 : page.slugs.length === 1 ? 0.8 : 0.7
      )
    );

  const cookbook = sections.flatMap((section) => {
    const modified = sectionLastModified(section);
    return [
      entry(sectionPath(section), modified, 'monthly', 0.7),
      ...section.recipes.map((recipe) =>
        entry(recipePath(section, recipe), modified, 'monthly', 0.6)
      ),
    ];
  });

  return [
    entry(
      '/',
      lastModified('src/app/page.tsx', 'src/components/landing', 'src/lib/stats.ts'),
      'weekly',
      1
    ),
    entry(COOKBOOK_URL, cookbookLastModified(), 'weekly', 0.9),
    ...cookbook,
    ...docs,
    entry(LLMS_TXT_URL, docsModified, 'weekly', 0.4),
    entry(LLMS_FULL_TXT_URL, docsModified, 'weekly', 0.4),
  ];
}
