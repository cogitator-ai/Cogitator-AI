import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { nanoid } from 'nanoid';
import type { DocumentLoader, RAGDocument } from '@cogitator-ai/types';

const TEXT_EXTENSIONS = new Set(['txt', 'text']);

export class TextLoader implements DocumentLoader {
  readonly supportedTypes = ['txt', 'text'];

  async load(source: string): Promise<RAGDocument[]> {
    const resolved = resolve(source);
    const info = await stat(resolved);

    if (info.isDirectory()) {
      return this.loadDirectory(resolved);
    }

    return [await this.loadFile(resolved)];
  }

  private async loadFile(filePath: string): Promise<RAGDocument> {
    const content = await readFile(filePath, 'utf-8');
    return {
      id: nanoid(),
      content,
      source: filePath,
      sourceType: 'text',
    };
  }

  private async loadDirectory(dirPath: string): Promise<RAGDocument[]> {
    const entries = await readdir(dirPath);
    const docs: RAGDocument[] = [];

    for (const entry of entries) {
      const ext = entry.split('.').pop()?.toLowerCase() ?? '';
      if (!TEXT_EXTENSIONS.has(ext)) continue;

      const filePath = join(dirPath, entry);
      const info = await stat(filePath);
      if (info.isFile()) {
        docs.push(await this.loadFile(filePath));
      }
    }

    return docs;
  }
}
