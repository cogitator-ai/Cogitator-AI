import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DocumentLoader, RAGDocument } from '@cogitator-ai/types';
import { JSONLoader, type JSONLoaderOptions } from './json-loader.js';

export type JSONLLoaderOptions = JSONLoaderOptions;

/**
 * Loads JSON Lines files (`.jsonl`, `.ndjson`): one JSON document per line.
 *
 * Each line is parsed on its own, so one broken line fails the whole load
 * naming the file and the 1-based line number. Blank lines are skipped.
 * Documents keep `sourceType: 'json'` and ids that are stable across
 * loads of the same file, one per line.
 */
export class JSONLLoader extends JSONLoader {
  override readonly supportedTypes = ['jsonl', 'ndjson'];

  async load(source: string): Promise<RAGDocument[]> {
    const filePath = resolve(source);
    const raw = await readFile(filePath, 'utf-8');

    const documents: RAGDocument[] = [];
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') continue;

      let item: unknown;
      try {
        item = JSON.parse(line);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`JSONLLoader: failed to parse "${filePath}" line ${i + 1}: ${message}`, {
          cause: err,
        });
      }
      documents.push(this.itemToDocument(item, filePath, i + 1));
    }
    return documents;
  }
}
