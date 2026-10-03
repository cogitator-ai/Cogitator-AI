import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';
import { COOKBOOK_URL, LLMS_FULL_TXT_URL, LLMS_TXT_URL, SITE_URL } from '@/lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  const docs: MetadataRoute.Sitemap = source.getPages().map((page) => ({
    url: `${SITE_URL}${page.url}`,
    lastModified,
    changeFrequency: 'weekly',
    priority: page.slugs.length === 0 ? 0.9 : 0.8,
  }));

  return [
    {
      url: SITE_URL,
      lastModified,
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: `${SITE_URL}${COOKBOOK_URL}`,
      lastModified,
      changeFrequency: 'weekly',
      priority: 0.9,
    },
    ...docs,
    {
      url: `${SITE_URL}${LLMS_TXT_URL}`,
      lastModified,
      changeFrequency: 'weekly',
      priority: 0.5,
    },
    {
      url: `${SITE_URL}${LLMS_FULL_TXT_URL}`,
      lastModified,
      changeFrequency: 'weekly',
      priority: 0.5,
    },
  ];
}
