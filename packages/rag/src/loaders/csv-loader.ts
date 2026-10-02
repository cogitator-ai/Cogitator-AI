import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { nanoid } from 'nanoid';
import type { DocumentLoader, RAGDocument } from '@cogitator-ai/types';

type Papa = typeof import('papaparse');

async function loadPapaparse(): Promise<Papa> {
  let mod: Papa & { default?: Papa };
  try {
    mod = (await import('papaparse')) as Papa & { default?: Papa };
  } catch {
    throw new Error('papaparse is required for CSVLoader. Install it: pnpm add papaparse');
  }
  const interop = mod.default;
  return interop && typeof interop.parse === 'function' ? interop : mod;
}

export interface CSVLoaderOptions {
  contentColumn?: string;
  metadataColumns?: string[];
  delimiter?: string;
}

export class CSVLoader implements DocumentLoader {
  readonly supportedTypes = ['csv'];
  private readonly contentColumn?: string;
  private readonly metadataColumns?: string[];
  private readonly delimiter?: string;

  constructor(options?: CSVLoaderOptions) {
    this.contentColumn = options?.contentColumn;
    this.metadataColumns = options?.metadataColumns;
    this.delimiter = options?.delimiter;
  }

  async load(source: string): Promise<RAGDocument[]> {
    const Papa = await loadPapaparse();
    const filePath = resolve(source);
    const raw = await readFile(filePath, 'utf-8');

    const result = Papa.parse<Record<string, string>>(raw, {
      header: true,
      skipEmptyLines: true,
      delimiter: this.delimiter,
    });

    const headers = result.meta.fields ?? [];
    const contentCol = this.contentColumn ?? headers[0];
    if (contentCol === undefined) return [];

    if (this.contentColumn && !headers.includes(this.contentColumn)) {
      throw new Error(
        `CSVLoader: contentColumn "${this.contentColumn}" not found in CSV headers: ${headers.join(', ')}`
      );
    }

    return result.data.map((row, index) => {
      const content = row[contentCol] ?? '';
      const metadata = { ...this.extractMetadata(row), row: index + 1 };

      return {
        id: nanoid(),
        content,
        source: filePath,
        sourceType: 'csv' as const,
        metadata,
      };
    });
  }

  private extractMetadata(row: Record<string, string>): Record<string, unknown> | undefined {
    if (!this.metadataColumns) return undefined;

    const metadata: Record<string, unknown> = {};
    for (const col of this.metadataColumns) {
      if (col in row) {
        metadata[col] = row[col];
      }
    }
    return metadata;
  }
}
