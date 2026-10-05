import { z } from 'zod';
import type { RobotsChecker } from '@cogitator-ai/types';
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
import {
  assertPublicHost,
  createPublicFetch,
  DEFAULT_USER_AGENT,
  type FetchFunction,
} from '../utils/public-network';

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
 * another ends the outer one, as browsers do. The page is kept in parts and a link
 * rewrites only its own, so a page of many links costs as much as its length.
 */
function renderMarkdown(tokens: readonly HtmlToken[]): string {
  const parts: string[] = [];
  let link: { href: string; start: number } | null = null;

  const closeLink = () => {
    if (!link) return;
    const text = parts.splice(link.start).join('');
    const label = collapseWhitespace(text);
    parts.push(label ? `[${label}](${link.href})` : text);
    link = null;
  };

  for (const token of removeElements(tokens, NON_CONTENT)) {
    if (token.type === 'text') {
      parts.push(decodeEntities(token.text));
    } else if (token.name !== 'a') {
      parts.push(renderMarkdownTag(token));
    } else {
      closeLink();
      const href = token.closing ? undefined : getAttribute(token, 'href');
      if (href) link = { href, start: parts.length };
    }
  }
  closeLink();

  return parts
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

/** How a `web_scrape` tool fetches pages. */
export interface WebScrapeOptions {
  /** Sent as the User-Agent. Default: a CogitatorBot string */
  userAgent?: string;
  /**
   * Checks every URL, redirect targets included, against the site's robots.txt before fetching
   * it, e.g. `new RobotsPolicy({ userAgent, fetch: fetchPublic })`. A disallowed page is reported
   * as an error. While the tool reaches only public hosts, a URL is checked before its robots.txt
   * is read; a policy with `fetch: fetchPublic` keeps its own reads on public hosts too
   */
  robots?: RobotsChecker;
  /**
   * Let the tool reach loopback, private and link-local hosts, for an agent that scrapes a
   * trusted intranet. Off by default: a model chooses the URL, and a page or a prompt can ask
   * it for `http://169.254.169.254/` or an internal admin page
   */
  allowPrivateNetwork?: boolean;
  /**
   * Fetches pages instead of the built-in client, e.g. through a proxy. The tool then trusts it
   * with every URL, so it should apply its own network policy
   */
  fetch?: FetchFunction;
}

const MAX_REDIRECTS = 5;

/**
 * A `web_scrape` tool with its own User-Agent and, optionally, a robots.txt checker. With a
 * checker the tool follows redirects itself so every hop is checked. It reaches only public
 * hosts unless `allowPrivateNetwork` is set or a `fetch` of the caller's own is given.
 */
export function createWebScrapeTool(options: WebScrapeOptions = {}) {
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const robots = options.robots;
  const fetchPage =
    options.fetch ?? createPublicFetch({ allowPrivateNetwork: options.allowPrivateNetwork });
  const guarded = !options.fetch && !options.allowPrivateNetwork;

  return tool({
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
        const headers = {
          'User-Agent': userAgent,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        };
        let current = url;
        let response: Response | undefined;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          if (robots && guarded) await assertPublicHost(current);
          if (robots && !(await robots.allows(current))) {
            return { error: `robots.txt does not allow fetching ${current}`, url };
          }
          response = await fetchPage(current, {
            headers,
            signal: abort.signal,
            redirect: robots ? 'manual' : 'follow',
          });
          const location = response.headers.get('location');
          if (!robots || response.status < 300 || response.status >= 400 || !location) break;
          current = new URL(location, current).href;
          response = undefined;
        }
        if (!response) {
          return { error: `Too many redirects (max ${MAX_REDIRECTS})`, url };
        }

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
}

/** The `web_scrape` tool with the default User-Agent, no robots.txt check and public hosts only. */
export const webScrape = createWebScrapeTool();
