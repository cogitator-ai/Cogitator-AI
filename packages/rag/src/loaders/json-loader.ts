import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { nanoid } from 'nanoid';
import type { DocumentLoader, RAGDocument } from '@cogitator-ai/types';

const CONTENT_FIELDS = ['content', 'text', 'body'];

export interface JSONLoaderOptions {
  contentField?: string;
  metadataFields?: string[];
}

export class JSONLoader implements DocumentLoader {
  readonly supportedTypes = ['json'];
  private readonly contentField?: string;
  private readonly metadataFields?: string[];

  constructor(options?: JSONLoaderOptions) {
    this.contentField = options?.contentField;
    this.metadataFields = options?.metadataFields;
  }

  async load(source: string): Promise<RAGDocument[]> {
    const filePath = resolve(source);
    const raw = await readFile(filePath, 'utf-8');
    const data: unknown = JSON.parse(raw);

    const items = Array.isArray(data) ? data : [data];
    return items.map((item) => this.itemToDocument(item, filePath));
  }

  private itemToDocument(item: unknown, source: string): RAGDocument {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return {
        id: nanoid(),
        content: String(item),
        source,
        sourceType: 'json',
      };
    }
    const obj = item as Record<string, unknown>;
    const content = this.extractContent(obj);
    const metadata = this.extractMetadata(obj);

    return {
      id: nanoid(),
      content,
      source,
      sourceType: 'json',
      ...(metadata && Object.keys(metadata).length > 0 && { metadata }),
    };
  }

  private extractContent(obj: Record<string, unknown>): string {
    if (this.contentField && this.contentField in obj) {
      return String(obj[this.contentField]);
    }

    for (const field of CONTENT_FIELDS) {
      if (field in obj) {
        return String(obj[field]);
      }
    }

    return JSON.stringify(obj, null, 2);
  }

  private extractMetadata(obj: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!this.metadataFields) return undefined;

    const metadata: Record<string, unknown> = {};
    for (const field of this.metadataFields) {
      if (field in obj) {
        metadata[field] = obj[field];
      }
    }
    return metadata;
  }
}
