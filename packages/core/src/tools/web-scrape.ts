import { z } from 'zod';
import { tool } from '../tool';
import { createLinkedAbortController, getAbortErrorMessage } from '../utils/abort';

const webScrapeParams = z.object({
  url: z.string().url().describe('URL to scrape'),
  selector: z
    .string()
    .optional()
    .describe('CSS selector to extract specific content (e.g., "article", "main", ".content")'),
  format: z.enum(['text', 'markdown', 'html']).optional().describe('Output format (default: text)'),
  maxLength: z
    .number()
    .int()
    .min(100)
    .max(100000)
    .optional()
    .describe('Maximum content length (default: 50000)'),
  timeout: z
    .number()
    .int()
    .min(1000)
    .max(60000)
    .optional()
    .describe('Request timeout in ms (default: 30000)'),
  includeLinks: z.boolean().optional().describe('Extract and include links (default: false)'),
  includeImages: z.boolean().optional().describe('Extract and include image URLs (default: false)'),
});

export interface ExtractedLink {
  text: string;
  href: string;
}

export interface ExtractedImage {
  src: string;
  alt: string;
}

export interface ScrapeResult {
  url: string;
  title: string;
  content: string;
  format: string;
  length: number;
  truncated: boolean;
  links?: ExtractedLink[];
  images?: ExtractedImage[];
}

const HTML_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

const UNSAFE_LINK_PROTOCOLS = new Set(['javascript:', 'data:', 'vbscript:']);

function decodeEntities(text: string): string {
  return text.replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, (entity) => HTML_ENTITIES[entity]);
}

function removeUntilStable(html: string, pattern: RegExp, replacement = ''): string {
  let previous: string;
  let current = html;
  do {
    previous = current;
    current = current.replace(pattern, replacement);
  } while (current !== previous);
  return current;
}

function removeElements(html: string, tags: readonly string[], replacement = ''): string {
  return tags.reduce(
    (result, tag) =>
      removeUntilStable(
        result,
        new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\b[^>]*>`, 'gi'),
        replacement
      ),
    html
  );
}

function stripTags(html: string, replacement = ''): string {
  return removeUntilStable(html, /<[^>]*>/g, replacement);
}

function removeNonContent(html: string): string {
  return removeUntilStable(
    removeElements(html, ['script', 'style', 'nav', 'footer', 'aside']),
    /<!--[\s\S]*?-->/g
  );
}

function stripHtmlTags(html: string): string {
  const withoutChrome = removeElements(removeNonContent(html), ['header'], ' ');
  const text = stripTags(
    withoutChrome
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n\n'),
    ' '
  );
  return decodeEntities(text)
    .replace(/\s+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlToMarkdown(html: string): string {
  const markdown = stripTags(
    removeNonContent(html)
      .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n')
      .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n')
      .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n')
      .replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n\n')
      .replace(/<h5[^>]*>(.*?)<\/h5>/gi, '##### $1\n\n')
      .replace(/<h6[^>]*>(.*?)<\/h6>/gi, '###### $1\n\n')
      .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
      .replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**')
      .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
      .replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*')
      .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
      .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, '[$2]($1)')
      .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
  );
  return decodeEntities(markdown)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTitle(html: string): string {
  const titleMatch = /<title[^>]*>(.*?)<\/title>/i.exec(html);
  if (titleMatch) {
    return titleMatch[1].replace(/&[^;]+;/g, ' ').trim();
  }

  const h1Match = /<h1[^>]*>(.*?)<\/h1>/i.exec(html);
  if (h1Match) {
    return stripTags(h1Match[1]).trim();
  }

  return '';
}

function extractLinks(html: string, baseUrl: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const regex = /<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const href = match[1];
    const text = stripTags(match[2]).trim();

    if (!href || !text || href.startsWith('#')) {
      continue;
    }

    try {
      const absoluteUrl = new URL(href, baseUrl);
      if (UNSAFE_LINK_PROTOCOLS.has(absoluteUrl.protocol)) continue;
      links.push({ text, href: absoluteUrl.href });
    } catch {
      continue;
    }
  }

  const seen = new Set<string>();
  return links.filter((link) => {
    if (seen.has(link.href)) return false;
    seen.add(link.href);
    return true;
  });
}

function extractImages(html: string, baseUrl: string): ExtractedImage[] {
  const images: ExtractedImage[] = [];
  const regex = /<img[^>]*src=["']([^"']+)["'][^>]*>/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const src = match[1];
    const altMatch = /alt=["']([^"']*?)["']/i.exec(match[0]);
    const alt = altMatch ? altMatch[1] : '';

    if (!src || src.startsWith('data:')) {
      continue;
    }

    try {
      const absoluteUrl = new URL(src, baseUrl).href;
      images.push({ src: absoluteUrl, alt });
    } catch {
      continue;
    }
  }

  const seen = new Set<string>();
  return images.filter((img) => {
    if (seen.has(img.src)) return false;
    seen.add(img.src);
    return true;
  });
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractBySelector(html: string, selector: string): string | null {
  const tagSelectors: Record<string, RegExp> = {
    article: /<article[^>]*>([\s\S]*?)<\/article>/i,
    main: /<main[^>]*>([\s\S]*?)<\/main>/i,
    section: /<section[^>]*>([\s\S]*?)<\/section>/i,
    div: /<div[^>]*>([\s\S]*?)<\/div>/i,
    p: /<p[^>]*>([\s\S]*?)<\/p>/gi,
  };

  if (selector.startsWith('.')) {
    const className = escapeRegex(selector.slice(1));
    const classRegex = new RegExp(
      `<[^>]+class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`,
      'i'
    );
    const match = classRegex.exec(html);
    return match ? match[1] : null;
  }

  if (selector.startsWith('#')) {
    const id = escapeRegex(selector.slice(1));
    const idRegex = new RegExp(`<[^>]+id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'i');
    const match = idRegex.exec(html);
    return match ? match[1] : null;
  }

  const regex = tagSelectors[selector.toLowerCase()];
  if (regex) {
    if (selector.toLowerCase() === 'p') {
      const matches = html.match(regex);
      return matches ? matches.join('\n') : null;
    }
    const match = html.match(regex);
    return match ? match[1] : null;
  }

  return null;
}

export const webScrape = tool({
  name: 'web_scrape',
  description:
    'Fetch and extract content from a web page. Supports text, markdown, or HTML output. Can extract specific elements using CSS selectors.',
  parameters: webScrapeParams,
  category: 'web',
  tags: ['scrape', 'web', 'extract', 'html'],
  sideEffects: ['network'],
  execute: async (
    {
      url,
      selector,
      format = 'text',
      maxLength = 50000,
      timeout = 30000,
      includeLinks = false,
      includeImages = false,
    },
    context
  ) => {
    const abort = createLinkedAbortController(context?.signal, timeout);

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; CogitatorBot/1.0; +https://github.com/cogitator-ai/Cogitator-AI)',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: abort.signal,
      });

      if (!response.ok) {
        return { error: `HTTP ${response.status}: ${response.statusText}`, url };
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        return { error: `Not an HTML page: ${contentType}`, url };
      }

      let html = await response.text();
      const title = extractTitle(html);

      if (selector) {
        const extracted = extractBySelector(html, selector);
        if (!extracted) {
          return { error: `Selector "${selector}" not found on page`, url };
        }
        html = extracted;
      }

      let content: string;
      switch (format) {
        case 'markdown':
          content = htmlToMarkdown(html);
          break;
        case 'html':
          content = html;
          break;
        default:
          content = stripHtmlTags(html);
      }

      const truncated = content.length > maxLength;
      if (truncated) {
        content = content.slice(0, maxLength);
      }

      const result: ScrapeResult = {
        url,
        title,
        content,
        format,
        length: content.length,
        truncated,
      };

      if (includeLinks) {
        result.links = extractLinks(html, url).slice(0, 50);
      }

      if (includeImages) {
        result.images = extractImages(html, url).slice(0, 20);
      }

      return result;
    } catch (err) {
      const error = err as Error;
      if (error.name === 'AbortError') {
        return { error: getAbortErrorMessage('Request', abort, timeout), url };
      }
      return { error: error.message, url };
    } finally {
      abort.cleanup();
    }
  },
});
