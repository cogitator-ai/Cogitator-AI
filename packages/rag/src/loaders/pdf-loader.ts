import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PDFParse as PDFParseClass } from 'pdf-parse';
import type { DocumentLoader, RAGDocument } from '@cogitator-ai/types';
import { documentId } from './document-id.js';

type PDFParseConstructor = typeof PDFParseClass;

interface ParsedPdf {
  text: string;
  totalPages: number;
  pages: Array<{ num: number; text: string }>;
  title?: string;
}

async function loadPdfParse(): Promise<PDFParseConstructor> {
  try {
    const mod = await import('pdf-parse');
    return mod.PDFParse;
  } catch {
    throw new Error('pdf-parse is required for PDFLoader. Install it: pnpm add pdf-parse');
  }
}

function extractTitle(info: unknown): string | undefined {
  if (typeof info !== 'object' || info === null || !('Title' in info)) return undefined;
  const title = info.Title;
  return typeof title === 'string' && title.length > 0 ? title : undefined;
}

export interface PDFLoaderOptions {
  splitPages?: boolean;
}

export class PDFLoader implements DocumentLoader {
  readonly supportedTypes = ['pdf'];
  private readonly splitPages: boolean;

  constructor(options?: PDFLoaderOptions) {
    this.splitPages = options?.splitPages ?? false;
  }

  async load(source: string): Promise<RAGDocument[]> {
    const PDFParse = await loadPdfParse();
    const filePath = resolve(source);
    const buffer = await readFile(filePath);
    const parsed = await this.parse(PDFParse, buffer, filePath);

    if (this.splitPages) {
      return this.buildPageDocs(parsed, filePath);
    }

    return [this.buildSingleDoc(parsed, filePath)];
  }

  private async parse(
    PDFParse: PDFParseConstructor,
    buffer: Buffer,
    source: string
  ): Promise<ParsedPdf> {
    let parser: PDFParseClass | undefined;
    try {
      parser = new PDFParse({ data: new Uint8Array(buffer) });
      const info = await parser.getInfo();
      const result = await parser.getText({ pageJoiner: '' });
      return {
        text: result.text,
        totalPages: result.total,
        pages: result.pages.map(({ num, text }) => ({ num, text })),
        title: extractTitle(info.info),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`PDFLoader: failed to parse "${source}": ${message}`, { cause: err });
    } finally {
      await parser?.destroy();
    }
  }

  private buildSingleDoc(parsed: ParsedPdf, source: string): RAGDocument {
    const metadata: Record<string, unknown> = { pages: parsed.totalPages };
    if (parsed.title) metadata.title = parsed.title;

    return {
      id: documentId(source),
      content: parsed.text,
      source,
      sourceType: 'pdf',
      metadata,
    };
  }

  private buildPageDocs(parsed: ParsedPdf, source: string): RAGDocument[] {
    const pages = parsed.pages.filter((page) => page.text.trim().length > 0);

    if (pages.length === 0) {
      return [this.buildPageDoc(parsed.text, source, 1, parsed.totalPages, parsed.title)];
    }

    return pages.map((page) =>
      this.buildPageDoc(page.text.trim(), source, page.num, parsed.totalPages, parsed.title)
    );
  }

  private buildPageDoc(
    content: string,
    source: string,
    pageNumber: number,
    totalPages: number,
    title: string | undefined
  ): RAGDocument {
    const metadata: Record<string, unknown> = { pageNumber, totalPages };
    if (title) metadata.title = title;

    return {
      id: documentId(source, `page-${pageNumber}`),
      content,
      source,
      sourceType: 'pdf',
      metadata,
    };
  }
}
