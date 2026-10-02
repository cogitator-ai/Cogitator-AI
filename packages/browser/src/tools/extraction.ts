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
import { getReadableText } from '../utils/page-helpers';

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
        const text = await page
          .locator(params.selector)
          .first()
          .evaluate((el) => (el instanceof HTMLElement ? el.innerText : (el.textContent ?? '')));
        return { text };
      }
      const text = await page.evaluate(() => document.body?.innerText ?? '');
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
            if (baseUrl && rawHref) {
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
            const el = nodes[i];
            const rect = el.getBoundingClientRect();
            const rendered =
              typeof el.checkVisibility !== 'function' ||
              el.checkVisibility({
                checkOpacity: true,
                checkVisibilityCSS: true,
                opacityProperty: true,
                visibilityProperty: true,
              });
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
              visible: rect.width > 0 && rect.height > 0 && rendered,
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
        const empty = { headers: [] as string[], rows: [] as string[][] };
        const target = selector
          ? document.querySelector(selector)
          : document.querySelector('table');
        if (!target) return empty;
        const table = target instanceof HTMLTableElement ? target : target.querySelector('table');
        if (!table) return empty;

        const cellsOf = (row: HTMLTableRowElement) =>
          Array.from(row.cells).map((cell) => cell.textContent?.trim() ?? '');

        const allRows = Array.from(table.rows);
        const headRows = table.tHead ? Array.from(table.tHead.rows) : [];

        if (headRows.length > 0) {
          return {
            headers: cellsOf(headRows[headRows.length - 1]),
            rows: allRows.filter((row) => !headRows.includes(row)).map(cellsOf),
          };
        }

        return {
          headers: allRows.length > 0 ? cellsOf(allRows[0]) : [],
          rows: allRows.slice(1).map(cellsOf),
        };
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
      const text = await getReadableText(page, params.selector);
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
