import type { MetadataRoute } from 'next';
import { LLMS_FULL_TXT_URL, LLMS_TXT_URL, SITE_URL } from '@/lib/site';

/**
 * Everything is crawlable except the search API. Social cards (`/og/`, `opengraph-image`) and the
 * agent-facing text files stay allowed: link-preview bots honour robots.txt too.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: ['/', LLMS_TXT_URL, LLMS_FULL_TXT_URL],
      disallow: '/api/',
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
