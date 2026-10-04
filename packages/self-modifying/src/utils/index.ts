export { llmChat } from './llm-helper';

export function extractJson(text: string): string | null {
  let cleaned = text;

  const fenceStart = text.indexOf('```');
  const fenceEnd = fenceStart === -1 ? -1 : text.indexOf('```', fenceStart + 3);
  if (fenceEnd !== -1) {
    const bodyStart = text.startsWith('json', fenceStart + 3) ? fenceStart + 7 : fenceStart + 3;
    cleaned = text.slice(bodyStart, fenceEnd).trim();
  }

  const objectStart = cleaned.indexOf('{');
  const arrayStart = cleaned.indexOf('[');

  let start: number;
  let open: string;
  let close: string;

  if (objectStart === -1 && arrayStart === -1) {
    return null;
  } else if (objectStart === -1) {
    start = arrayStart;
    open = '[';
    close = ']';
  } else if (arrayStart === -1) {
    start = objectStart;
    open = '{';
    close = '}';
  } else if (objectStart < arrayStart) {
    start = objectStart;
    open = '{';
    close = '}';
  } else {
    start = arrayStart;
    open = '[';
    close = ']';
  }

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        return cleaned.slice(start, i + 1);
      }
    }
  }

  if (depth > 0) {
    let repaired = cleaned.slice(start);
    repaired = repaired.replace(/,\s*$/, '');
    repaired += close.repeat(depth);
    try {
      JSON.parse(repaired);
      return repaired;
    } catch {
      return null;
    }
  }

  return null;
}
