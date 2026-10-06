import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DocumentLoader, RAGDocument } from '@cogitator-ai/types';
import { documentId } from './document-id.js';

async function loadCheerio() {
  try {
    return await import('cheerio');
  } catch {
    throw new Error('cheerio is required for HTMLLoader. Install it: pnpm add cheerio');
  }
}

export interface HTMLLoaderOptions {
  selector?: string;
}

const NON_CONTENT_SELECTOR = 'script, style, noscript, template, svg, iframe, object, head';
const BLOCK_SELECTOR =
  'address, article, aside, blockquote, dd, div, dl, dt, fieldset, figcaption, figure, footer, ' +
  'form, h1, h2, h3, h4, h5, h6, header, hr, li, main, nav, ol, p, pre, section, table, tr, ul';

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extracts readable text from HTML: scripts, styles and other non-content elements are
 * dropped, block elements become line breaks and whitespace is normalized.
 */
export class HTMLLoader implements DocumentLoader {
  readonly supportedTypes = ['html', 'htm'];
  readonly selector: string;

  constructor(options?: HTMLLoaderOptions) {
    this.selector = options?.selector ?? 'body';
  }

  async load(source: string): Promise<RAGDocument[]> {
    const filePath = resolve(source);
    const html = await readFile(filePath, 'utf-8');
    return [await this.parseHTML(html, filePath, 'html')];
  }

  async parseHTML(html: string, source: string, sourceType: 'html' | 'web'): Promise<RAGDocument> {
    const cheerio = await loadCheerio();
    const $ = cheerio.load(html);

    const title = $('title').first().text().trim() || undefined;

    $(NON_CONTENT_SELECTOR).remove();
    $('br').replaceWith('\n');
    $(BLOCK_SELECTOR).each((_, element) => {
      $(element).before('\n').after('\n');
    });
    $('td, th').after(' ');

    const content = normalizeWhitespace(
      $(this.selector)
        .map((_, element) => $(element).text())
        .get()
        .join('\n\n')
    );

    const metadata: Record<string, unknown> = {};
    if (title) metadata.title = title;

    return {
      id: documentId(source),
      content,
      source,
      sourceType,
      ...(Object.keys(metadata).length > 0 && { metadata }),
    };
  }
}
