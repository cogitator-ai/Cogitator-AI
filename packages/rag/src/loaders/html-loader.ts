import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { nanoid } from 'nanoid';
import type { DocumentLoader, RAGDocument } from '@cogitator-ai/types';

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

    const content = $(this.selector).text().trim();
    const title = $('title').text().trim() || undefined;

    const metadata: Record<string, unknown> = {};
    if (title) metadata.title = title;

    return {
      id: nanoid(),
      content,
      source,
      sourceType,
      ...(Object.keys(metadata).length > 0 && { metadata }),
    };
  }
}
