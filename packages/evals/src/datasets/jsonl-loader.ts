import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { EvalCaseSchema } from '../schema';
import type { EvalCase } from '../schema';

export async function loadJsonl(path: string): Promise<EvalCase[]> {
  const cases: EvalCase[] = [];
  let lineNumber = 0;

  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lineNumber++;
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`Invalid JSON at line ${lineNumber}: ${trimmed}`);
    }

    cases.push(EvalCaseSchema.parse(parsed));
  }

  return cases;
}
