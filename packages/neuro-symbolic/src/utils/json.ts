function balancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (ch === '\\') {
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

export function extractJSON(text: string): string | null {
  let start = text.indexOf('{');
  let fallback: string | null = null;

  while (start !== -1) {
    const end = balancedObjectEnd(text, start);
    if (end === -1) break;

    const candidate = text.slice(start, end + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      fallback ??= candidate;
    }

    start = text.indexOf('{', start + 1);
  }

  return fallback;
}
