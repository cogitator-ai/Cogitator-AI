/**
 * Minimal .env file parser (KEY=VALUE, quotes, `export` prefix, inline comments)
 */

import { existsSync, readFileSync } from 'node:fs';

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*?)\s*$/;
const DOUBLE_QUOTE_ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  '"': '"',
  '\\': '\\',
};

function closingQuoteIndex(raw: string, quote: string): number {
  for (let i = 1; i < raw.length; i++) {
    if (quote === '"' && raw[i] === '\\') {
      i++;
      continue;
    }
    if (raw[i] === quote) return i;
  }
  return -1;
}

function parseValue(raw: string): string {
  const quote = raw[0];
  if (quote === '"' || quote === "'" || quote === '`') {
    const end = closingQuoteIndex(raw, quote);
    if (end > 0) {
      const inner = raw.slice(1, end);
      return quote === '"'
        ? inner.replace(/\\([nrt"\\])/g, (_, c: string) => DOUBLE_QUOTE_ESCAPES[c] ?? c)
        : inner;
    }
  }
  const commentStart = raw.search(/\s#/);
  return (commentStart >= 0 ? raw.slice(0, commentStart) : raw).trim();
}

/**
 * Parse the contents of a .env file. Later duplicates win; comments and
 * malformed lines are ignored.
 */
export function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = ENV_LINE.exec(line);
    if (match) result[match[1]] = parseValue(match[2]);
  }
  return result;
}

/**
 * Read and parse a .env file. Returns an empty object when the file does not exist.
 */
export function loadDotenvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseDotenv(readFileSync(path, 'utf-8'));
}
