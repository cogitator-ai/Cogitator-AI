import { readFile } from 'node:fs/promises';
import { EvalCaseSchema } from '../schema';
import { describeIssues } from './issues';
import type { EvalCase } from '../schema';

/** Columns whose cells hold JSON, such as `["follow-up question"]` for `turns` */
const JSON_FIELDS = ['turns', 'expectedToolCalls', 'expectedPassages'] as const;

/**
 * Cases from a CSV file with an `input` column, an optional `expected` one, `metadata.<key>` and
 * `context.<key>` columns, and `turns`, `expectedToolCalls` and `expectedPassages` columns whose
 * cells hold JSON arrays (an empty cell leaves the field out)
 */
export async function loadCsv(path: string): Promise<EvalCase[]> {
  let Papa: typeof import('papaparse');
  try {
    const loaded = (await import('papaparse')) as typeof import('papaparse') & {
      default?: typeof import('papaparse');
    };
    Papa = loaded.default ?? loaded;
  } catch {
    throw new Error(
      'papaparse is required for CSV loading. Install it with: npm install papaparse'
    );
  }

  const content = (await readFile(path, 'utf-8')).replace(/^\uFEFF/, '');
  const lineOf = lineFinder(content);
  let fields: string[] | undefined;
  const rows: Array<{ row: Record<string, string>; line: number }> = [];
  let rowStart = 0;
  let malformed: string | undefined;
  Papa.parse<string[]>(content, {
    delimiter: ',',
    skipEmptyLines: true,
    step: (result, parser) => {
      const line = lineOf(firstContent(content, rowStart));
      rowStart = result.meta.cursor;
      const [error] = result.errors;
      if (error) {
        malformed = `Invalid CSV at line ${line}: ${error.message}`;
        parser.abort();
        return;
      }
      if (!fields) {
        fields = result.data;
        return;
      }
      const row: Record<string, string> = {};
      fields.forEach((field, at) => {
        const value = result.data[at];
        if (value !== undefined) row[field] = value;
      });
      rows.push({ row, line });
    },
  });

  if (malformed) throw new Error(malformed);
  if (!fields?.includes('input')) {
    throw new Error('CSV must have an "input" column');
  }

  return rows.map(({ row, line }) => {
    const evalCase: Record<string, unknown> = { input: row.input };

    if (row.expected !== undefined && row.expected !== '') {
      evalCase.expected = row.expected;
    }

    for (const field of JSON_FIELDS) {
      const cell = row[field];
      if (cell === undefined || cell.trim() === '') continue;
      try {
        evalCase[field] = JSON.parse(cell) as unknown;
      } catch {
        throw new Error(`Invalid case at line ${line}: ${field}: not valid JSON`);
      }
    }

    const metadata: Record<string, unknown> = {};
    const context: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(row)) {
      if (key === 'input' || key === 'expected') continue;

      if (key.startsWith('metadata.')) {
        metadata[key.slice('metadata.'.length)] = value;
      } else if (key.startsWith('context.')) {
        context[key.slice('context.'.length)] = value;
      }
    }

    if (Object.keys(metadata).length > 0) evalCase.metadata = metadata;
    if (Object.keys(context).length > 0) evalCase.context = context;

    const checked = EvalCaseSchema.safeParse(evalCase);
    if (!checked.success) {
      throw new Error(`Invalid case at line ${line}: ${describeIssues(checked.error)}`);
    }
    return checked.data;
  });
}

/** Where the text after `offset` starts, past the line breaks of blank lines before it */
function firstContent(content: string, offset: number): number {
  let at = offset;
  while (at < content.length && (content[at] === '\n' || content[at] === '\r')) at++;
  return at;
}

/** The 1-based line of an offset in `content`, a line ending at `\r\n`, `\r` or `\n` */
function lineFinder(content: string): (offset: number) => number {
  const starts: number[] = [0];
  for (let at = 0; at < content.length; at++) {
    const char = content[at];
    if (char === '\r' && content[at + 1] === '\n') continue;
    if (char === '\n' || char === '\r') starts.push(at + 1);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}
