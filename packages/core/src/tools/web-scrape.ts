import { z } from 'zod';
import { tool } from '../tool';
import { createLinkedAbortController, getAbortErrorMessage } from '../utils/abort';
import {
  decodeEntities,
  findClosingTag,
  getAttribute,
  removeElements,
  tokenizeHtml,
  type HtmlTagToken,
  type HtmlToken,
} from '../utils/html';

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

const UNSAFE_LINK_PROTOCOLS = new Set(['javascript:', 'data:', 'vbscript:']);
const NON_CONTENT = new Set(['script', 'style', 'nav', 'footer', 'aside', 'template', 'noscript']);
const TEXT_NON_CONTENT = new Set([...NON_CONTENT, 'header']);
const SELECTABLE_TAGS = new Set(['article', 'main', 'section', 'div', 'p']);
const HEADINGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
const TEXT_BREAKS: Record<string, string> = {
  p: '\n\n',
  div: '\n',
  li: '\n',
  h1: '\n\n',
  h2: '\n\n',
  h3: '\n\n',
  h4: '\n\n',
  h5: '\n\n',
  h6: '\n\n',
};
const MARKDOWN_EMPHASIS: Record<string, string> = {
  strong: '**',
  b: '**',
  em: '*',
  i: '*',
  code: '`',
};

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function renderText(tokens: readonly HtmlToken[]): string {
  let text = '';
  for (const token of removeElements(tokens, TEXT_NON_CONTENT)) {
    if (token.type === 'text') text += decodeEntities(token.text);
    else if (token.name === 'br') text += '\n';
    else text += (token.closing && TEXT_BREAKS[token.name]) || ' ';
  }
  return text
    .replace(/\s+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function renderMarkdownTag(tag: HtmlTagToken): string {
  const level = HEADINGS[tag.name];
  if (level) return tag.closing ? '\n\n' : `${'#'.repeat(level)} `;

  const emphasis = MARKDOWN_EMPHASIS[tag.name];
  if (emphasis) return emphasis;

  switch (tag.name) {
    case 'li':
      return tag.closing ? '\n' : '- ';
    case 'br':
      return '\n';
    case 'p':
      return tag.closing ? '\n\n' : '';
    case 'div':
      return tag.closing ? '\n' : '';
    default:
      return '';
  }
}

/**
 * Markdown for a page. A link becomes `[text](href)` with its text on one line, a link
 * without text (an icon, say) leaves only its whitespace, and an `a` opened inside
 * another ends the outer one, as browsers do.
 */
function renderMarkdown(tokens: readonly HtmlToken[]): string {
  let markdown = '';
  let link: { href: string; start: number } | null = null;

  const closeLink = () => {
    if (!link) return;
    const text = markdown.slice(link.start);
    const label = collapseWhitespace(text);
    markdown = markdown.slice(0, link.start) + (label ? `[${label}](${link.href})` : text);
    link = null;
  };

  for (const token of removeElements(tokens, NON_CONTENT)) {
    if (token.type === 'text') {
      markdown += decodeEntities(token.text);
    } else if (token.name !== 'a') {
      markdown += renderMarkdownTag(token);
    } else {
      closeLink();
      const href = token.closing ? undefined : getAttribute(token, 'href');
      if (href) link = { href, start: markdown.length };
    }
  }
  closeLink();

  return markdown.replace(/\n{3,}/g, '\n\n').trim();
}

function innerText(tokens: readonly HtmlToken[], open: number, close: number): string {
  let text = '';
  for (let i = open + 1; i < close; i++) {
    const token = tokens[i];
    text += token.type === 'text' ? decodeEntities(token.text) : ' ';
  }
  return collapseWhitespace(text);
}

function findElement(tokens: readonly HtmlToken[], name: string): [number, number] | null {
  const open = tokens.findIndex((t) => t.type === 'tag' && !t.closing && t.name === name);
  if (open === -1) return null;
  const close = findClosingTag(tokens, open);
  return close === -1 ? null : [open, close];
}

function extractTitle(tokens: readonly HtmlToken[]): string {
  const title = findElement(tokens, 'title');
  if (title) return innerText(tokens, ...title);

  const heading = findElement(tokens, 'h1');
  return heading ? innerText(tokens, ...heading) : '';
}

function resolveUrl(target: string, baseUrl: string): URL | null {
  try {
    return new URL(target, baseUrl);
  } catch {
    return null;
  }
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function extractLinks(tokens: readonly HtmlToken[], baseUrl: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  let open: { href: string; text: string } | null = null;

  for (const token of tokens) {
    if (token.type === 'text') {
      if (open) open.text += decodeEntities(token.text);
      continue;
    }
    if (token.name !== 'a') {
      if (open) open.text += ' ';
      continue;
    }
    if (!token.closing) {
      const href = getAttribute(token, 'href');
      open = href ? { href, text: '' } : null;
      continue;
    }
    if (!open) continue;

    const text = collapseWhitespace(open.text);
    const url = open.href.startsWith('#') ? null : resolveUrl(open.href, baseUrl);
    open = null;
    if (text && url && !UNSAFE_LINK_PROTOCOLS.has(url.protocol)) {
      links.push({ text, href: url.href });
    }
  }

  return uniqueBy(links, (link) => link.href);
}

function extractImages(tokens: readonly HtmlToken[], baseUrl: string): ExtractedImage[] {
  const images: ExtractedImage[] = [];

  for (const token of tokens) {
    if (token.type !== 'tag' || token.closing || token.name !== 'img') continue;
    const src = getAttribute(token, 'src');
    if (!src || src.toLowerCase().startsWith('data:')) continue;
    const url = resolveUrl(src, baseUrl);
    if (url) images.push({ src: url.href, alt: getAttribute(token, 'alt') ?? '' });
  }

  return uniqueBy(images, (image) => image.src);
}

function matchesSelector(tag: HtmlTagToken, selector: string): boolean {
  if (selector.startsWith('.')) {
    const className = selector.slice(1);
    return (getAttribute(tag, 'class') ?? '').split(/\s+/).includes(className);
  }
  if (selector.startsWith('#')) return getAttribute(tag, 'id') === selector.slice(1);
  return tag.name === selector;
}

/**
 * The HTML a selector picks: the inner HTML of the first element with that class, id or
 * tag name (`article`, `main`, `section`, `div`), or every `p` element joined by newlines.
 */
function extractBySelector(
  html: string,
  tokens: readonly HtmlToken[],
  selector: string
): string | null {
  const normalized =
    selector.startsWith('.') || selector.startsWith('#') ? selector : selector.toLowerCase();
  if (
    !normalized.startsWith('.') &&
    !normalized.startsWith('#') &&
    !SELECTABLE_TAGS.has(normalized)
  ) {
    return null;
  }

  const paragraphs: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== 'tag' || token.closing || !matchesSelector(token, normalized)) continue;

    const close = findClosingTag(tokens, i);
    const end = close === -1 ? html.length : tokens[close].start;
    if (normalized !== 'p') return html.slice(token.end, end) || null;

    paragraphs.push(html.slice(token.start, close === -1 ? end : tokens[close].end));
    if (close === -1) break;
    i = close;
  }

  return paragraphs.length > 0 ? paragraphs.join('\n') : null;
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

      const page = await response.text();
      const pageTokens = tokenizeHtml(page);
      const title = extractTitle(pageTokens);

      let html = page;
      let tokens = pageTokens;
      if (selector) {
        const extracted = extractBySelector(page, pageTokens, selector);
        if (!extracted) {
          return { error: `Selector "${selector}" not found on page`, url };
        }
        html = extracted;
        tokens = tokenizeHtml(extracted);
      }

      let content: string;
      switch (format) {
        case 'markdown':
          content = renderMarkdown(tokens);
          break;
        case 'html':
          content = html;
          break;
        default:
          content = renderText(tokens);
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
        result.links = extractLinks(tokens, url).slice(0, 50);
      }

      if (includeImages) {
        result.images = extractImages(tokens, url).slice(0, 20);
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
