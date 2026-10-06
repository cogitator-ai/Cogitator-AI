import { createHash } from 'node:crypto';

/**
 * A document id that stays the same each time `source` is loaded, so results cite the same
 * document after a re-ingest. `part` tells apart several documents of one source: a row, an
 * item, a page.
 */
export function documentId(source: string, part?: string | number): string {
  const key = part === undefined ? source : `${source}#${part}`;
  return `doc_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}
