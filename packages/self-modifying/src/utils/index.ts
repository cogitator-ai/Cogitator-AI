export { llmChat } from './llm-helper';

export function extractJson(text: string): string | null {
  let cleaned = text;

  const codeBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)```/;
  const codeBlockMatch = codeBlockRegex.exec(cleaned);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  }

  const start = cleaned.indexOf('{');
  if (start === -1) return null;

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

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return cleaned.slice(start, i + 1);
      }
    }
  }

  if (depth > 0) {
    let repaired = cleaned.slice(start);
    repaired = repaired.replace(/,\s*$/, '');
    repaired += '}'.repeat(depth);
    try {
      JSON.parse(repaired);
      return repaired;
    } catch {
      return null;
    }
  }

  return null;
}
