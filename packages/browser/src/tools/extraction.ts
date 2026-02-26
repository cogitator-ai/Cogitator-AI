import { tool } from '@cogitator-ai/core';
import type { BrowserSession } from '../session';
import {
  getTextSchema,
  getHtmlSchema,
  getAttributeSchema,
  getLinksSchema,
  querySelectorAllSchema,
  extractTableSchema,
  extractStructuredSchema,
  type GetTextInput,
  type GetHtmlInput,
  type GetAttributeInput,
  type GetLinksInput,
  type QuerySelectorAllInput,
  type ExtractTableInput,
  type ExtractStructuredInput,
} from '../utils/schemas';

export function createGetTextTool(session: BrowserSession) {
  return tool({
    name: 'browser_get_text',
    description:
      'Extract text content from the page or a specific element. Returns body innerText if no selector is given.',
    category: 'web' as const,
    tags: ['browser', 'extraction'],
    parameters: getTextSchema,
    execute: async (params: GetTextInput) => {
      const page = session.page;
      if (params.selector) {
        const text = await page.textContent(params.selector);
        return { text: text ?? '' };
      }
      const text = await page.evaluate(() => document.body.innerText);
      return { text };
    },
  });
}

export function createGetHtmlTool(session: BrowserSession) {
  return tool({
    name: 'browser_get_html',
    description: 'Get HTML content of the page or a specific element. Supports inner/outer HTML.',
    category: 'web' as const,
    tags: ['browser', 'extraction'],
    parameters: getHtmlSchema,
    execute: async (params: GetHtmlInput) => {
      const page = session.page;
      if (params.selector) {
        if (params.outer) {
          const html = await page.locator(params.selector).evaluate((el) => el.outerHTML);
          return { html };
        }
        const html = await page.innerHTML(params.selector);
        return { html };
      }
      const html = await page.content();
      return { html };
    },
  });
}

export function createGetAttributeTool(session: BrowserSession) {
  return tool({
    name: 'browser_get_attribute',
    description: 'Get the value of an attribute on a DOM element.',
    category: 'web' as const,
    tags: ['browser', 'extraction'],
    parameters: getAttributeSchema,
    execute: async (params: GetAttributeInput) => {
      const value = await session.page.getAttribute(params.selector, params.attribute);
      return { value };
    },
  });
}

export function createGetLinksTool(session: BrowserSession) {
  return tool({
    name: 'browser_get_links',
    description:
      'Extract all links from the page or a scoped element. Returns text, href, and title for each link.',
    category: 'web' as const,
    tags: ['browser', 'extraction'],
    parameters: getLinksSchema,
    execute: async (params: GetLinksInput) => {
      const page = session.page;
      const links = await page.evaluate(
        ({ selector, baseUrl }) => {
          const scope = selector ? document.querySelector(selector) : document;
          if (!scope) return [];
          const anchors = scope.querySelectorAll('a');
          return Array.from(anchors).map((a) => {
            const rawHref = a.getAttribute('href') ?? '';
            let href = rawHref;
            if (baseUrl) {
              try {
                href = new URL(rawHref, baseUrl).href;
              } catch {
                href = rawHref;
              }
            }
            return {
              text: a.textContent?.trim() ?? '',
              href,
              title: a.getAttribute('title') ?? undefined,
            };
          });
        },
        { selector: params.selector, baseUrl: params.baseUrl }
      );
      return { links };
    },
  });
}

export function createQuerySelectorAllTool(session: BrowserSession) {
  return tool({
    name: 'browser_query_selector_all',
    description:
      'Query all elements matching a CSS selector. Returns tag, text, attributes, and visibility for each.',
    category: 'web' as const,
    tags: ['browser', 'extraction'],
    parameters: querySelectorAllSchema,
    execute: async (params: QuerySelectorAllInput) => {
      const page = session.page;
      const elements = await page.evaluate(
        ({ selector, attributes, limit }) => {
          const nodes = document.querySelectorAll(selector);
          const results: Array<{
            tag: string;
            text: string;
            attributes: Record<string, string>;
            visible: boolean;
          }> = [];
          const max = limit ?? nodes.length;
          for (let i = 0; i < Math.min(nodes.length, max); i++) {
            const el = nodes[i] as HTMLElement;
            const rect = el.getBoundingClientRect();
            const attrs: Record<string, string> = {};
            const attrNames = attributes ?? ['id', 'class', 'href', 'src', 'type', 'name'];
            for (const name of attrNames) {
              const val = el.getAttribute(name);
              if (val !== null) attrs[name] = val;
            }
            results.push({
              tag: el.tagName.toLowerCase(),
              text: el.textContent?.trim().slice(0, 200) ?? '',
              attributes: attrs,
              visible: rect.width > 0 && rect.height > 0,
            });
          }
          return results;
        },
        { selector: params.selector, attributes: params.attributes, limit: params.limit }
      );
      return { elements };
    },
  });
}

export function createExtractTableTool(session: BrowserSession) {
  return tool({
    name: 'browser_extract_table',
    description: 'Extract structured data from an HTML table. Returns headers and rows as arrays.',
    category: 'web' as const,
    tags: ['browser', 'extraction'],
    parameters: extractTableSchema,
    execute: async (params: ExtractTableInput) => {
      const page = session.page;
      const data = await page.evaluate((selector) => {
        const table = selector ? document.querySelector(selector) : document.querySelector('table');
        if (!table) return { headers: [] as string[], rows: [] as string[][] };

        const headerRow = table.querySelector('thead tr') ?? table.querySelector('tr');
        const headers = headerRow
          ? Array.from(headerRow.querySelectorAll('th, td')).map((c) => c.textContent?.trim() ?? '')
          : [];

        const bodyRows = table.querySelectorAll('tbody tr');
        const rowNodes = bodyRows.length > 0 ? bodyRows : table.querySelectorAll('tr');
        const rows: string[][] = [];
        const startIdx = bodyRows.length > 0 ? 0 : 1;
        for (let i = startIdx; i < rowNodes.length; i++) {
          const cells = rowNodes[i].querySelectorAll('td, th');
          rows.push(Array.from(cells).map((c) => c.textContent?.trim() ?? ''));
        }
        return { headers, rows };
      }, params.selector);
      return data;
    },
  });
}

export function createExtractStructuredTool(session: BrowserSession) {
  return tool({
    name: 'browser_extract_structured',
    description:
      'Extract clean readable text from the page for agent processing. Removes scripts, styles, and non-visible elements.',
    category: 'web' as const,
    tags: ['browser', 'extraction'],
    parameters: extractStructuredSchema,
    execute: async (params: ExtractStructuredInput) => {
      const page = session.page;
      const text = await page.evaluate((selector) => {
        const scope = selector ? document.querySelector(selector) : document.body;
        if (!scope) return '';
        const clone = scope.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('script, style, noscript, svg').forEach((el) => el.remove());
        return clone.innerText?.trim() ?? clone.textContent?.trim() ?? '';
      }, params.selector);
      return {
        instruction: params.instruction,
        text,
        url: page.url(),
        title: await page.title(),
      };
    },
  });
}

export function createExtractionTools(session: BrowserSession) {
  return [
    createGetTextTool(session),
    createGetHtmlTool(session),
    createGetAttributeTool(session),
    createGetLinksTool(session),
    createQuerySelectorAllTool(session),
    createExtractTableTool(session),
    createExtractStructuredTool(session),
  ];
}
