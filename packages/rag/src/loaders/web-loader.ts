import type { DocumentLoader, RAGDocument } from '@cogitator-ai/types';
import { HTMLLoader } from './html-loader';

export interface WebLoaderOptions {
  selector?: string;
  headers?: Record<string, string>;
}

export class WebLoader implements DocumentLoader {
  readonly supportedTypes = ['http', 'https'];
  private readonly htmlLoader: HTMLLoader;
  private readonly headers?: Record<string, string>;

  constructor(options?: WebLoaderOptions) {
    this.htmlLoader = new HTMLLoader({ selector: options?.selector });
    this.headers = options?.headers;
  }

  async load(source: string): Promise<RAGDocument[]> {
    const response = await fetch(source, {
      headers: this.headers ?? {},
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch ${source}: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const doc = await this.htmlLoader.parseHTML(html, source, 'web');

    return [doc];
  }
}
