import { readFile } from 'node:fs/promises';
import { EvalCaseSchema } from '../schema';
import type { EvalCase } from '../schema';

export async function loadCsv(path: string): Promise<EvalCase[]> {
  let Papa: typeof import('papaparse');
  try {
    Papa = await import('papaparse');
  } catch {
    throw new Error(
      'papaparse is required for CSV loading. Install it with: npm install papaparse'
    );
  }

  const content = await readFile(path, 'utf-8');
  const { data, meta } = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
  });

  if (!meta.fields?.includes('input')) {
    throw new Error('CSV must have an "input" column');
  }

  return data.map((row) => {
    const evalCase: Record<string, unknown> = { input: row.input };

    if (row.expected !== undefined && row.expected !== '') {
      evalCase.expected = row.expected;
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

    return EvalCaseSchema.parse(evalCase);
  });
}
