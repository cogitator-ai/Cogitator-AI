import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { nanoid } from 'nanoid';
import type { DocumentLoader, RAGDocument } from '@cogitator-ai/types';

const MD_EXTENSIONS = new Set(['md', 'mdx']);

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

export interface MarkdownLoaderOptions {
  stripFrontmatter?: boolean;
}

export class MarkdownLoader implements DocumentLoader {
  readonly supportedTypes = ['md', 'mdx'];
  private readonly stripFrontmatter: boolean;

  constructor(options?: MarkdownLoaderOptions) {
    this.stripFrontmatter = options?.stripFrontmatter ?? false;
  }

  async load(source: string): Promise<RAGDocument[]> {
    const resolved = resolve(source);
    const info = await stat(resolved);

    if (info.isDirectory()) {
      return this.loadDirectory(resolved);
    }

    return [await this.loadFile(resolved)];
  }

  private async loadFile(filePath: string): Promise<RAGDocument> {
    const raw = await readFile(filePath, 'utf-8');
    let content = raw;
    let metadata: Record<string, unknown> | undefined;

    if (this.stripFrontmatter) {
      const match = raw.match(FRONTMATTER_RE);
      if (match) {
        metadata = this.parseFrontmatter(match[1]);
        content = raw.slice(match[0].length);
      }
    }

    return {
      id: nanoid(),
      content,
      source: filePath,
      sourceType: 'markdown',
      ...(metadata && { metadata }),
    };
  }

  private parseFrontmatter(raw: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const line of raw.split('\n')) {
      const match = line.match(/^(\w[\w\s-]*?):\s*(.+)$/);
      if (match) {
        result[match[1].trim()] = match[2].trim();
      }
    }
    return result;
  }

  private async loadDirectory(dirPath: string): Promise<RAGDocument[]> {
    const entries = await readdir(dirPath);
    const docs: RAGDocument[] = [];

    for (const entry of entries) {
      const ext = entry.split('.').pop()?.toLowerCase() ?? '';
      if (!MD_EXTENSIONS.has(ext)) continue;

      const filePath = join(dirPath, entry);
      const info = await stat(filePath);
      if (info.isFile()) {
        docs.push(await this.loadFile(filePath));
      }
    }

    return docs;
  }
}
