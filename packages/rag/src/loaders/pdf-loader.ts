import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { nanoid } from 'nanoid';
import type { DocumentLoader, RAGDocument } from '@cogitator-ai/types';

type PdfParseFn = (
  dataBuffer: Buffer,
  options?: {
    pagerender?: (pageData: { pageIndex: number }) => string | Promise<string>;
    max?: number;
  }
) => Promise<{
  numpages: number;
  info: Record<string, unknown>;
  text: string;
}>;

async function loadPdfParse(): Promise<PdfParseFn> {
  try {
    const mod = await import('pdf-parse');
    return mod.default as unknown as PdfParseFn;
  } catch {
    throw new Error('pdf-parse is required for PDFLoader. Install it: pnpm add pdf-parse');
  }
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
    const pdfParse = await loadPdfParse();
    const filePath = resolve(source);
    const buffer = await readFile(filePath);

    if (this.splitPages) {
      return this.loadSplitPages(pdfParse, buffer, filePath);
    }

    return this.loadSingleDocument(pdfParse, buffer, filePath);
  }

  private async loadSingleDocument(
    pdfParse: PdfParseFn,
    buffer: Buffer,
    source: string
  ): Promise<RAGDocument[]> {
    const result = await pdfParse(buffer);
    const title = result.info?.Title;

    const metadata: Record<string, unknown> = { pages: result.numpages };
    if (title) metadata.title = title;

    return [
      {
        id: nanoid(),
        content: result.text,
        source,
        sourceType: 'pdf',
        metadata,
      },
    ];
  }

  private async loadSplitPages(
    pdfParse: PdfParseFn,
    buffer: Buffer,
    source: string
  ): Promise<RAGDocument[]> {
    const pageContents: string[] = [];

    const result = await pdfParse(buffer, {
      pagerender(pageData: { pageIndex: number }) {
        pageContents[pageData.pageIndex] = '';
        return '';
      },
    });

    const title = result.info?.Title;

    if (pageContents.length === 0) {
      const pages = result.text.split(/\f/);
      return pages.map((text, i) =>
        this.buildPageDoc(text.trim(), source, i + 1, result.numpages, title)
      );
    }

    return pageContents.map((text, i) =>
      this.buildPageDoc(text || '', source, i + 1, result.numpages, title)
    );
  }

  private buildPageDoc(
    content: string,
    source: string,
    pageNumber: number,
    totalPages: number,
    title: unknown
  ): RAGDocument {
    const metadata: Record<string, unknown> = { pageNumber, totalPages };
    if (title) metadata.title = title;

    return {
      id: nanoid(),
      content,
      source,
      sourceType: 'pdf',
      metadata,
    };
  }
}
