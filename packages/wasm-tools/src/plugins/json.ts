/**
 * JSON Processor WASM Plugin
 *
 * This file is compiled to WASM using the Extism JS PDK.
 * It provides safe JSON parsing and basic querying.
 *
 * Build command:
 *   esbuild src/plugins/json.ts -o dist/temp/json.js --bundle --format=cjs --target=es2020
 *   extism-js dist/temp/json.js -o dist/wasm/json.wasm
 */

interface JsonInput {
  json: string;
  query?: string;
}

interface JsonOutput {
  result: unknown;
  type: string;
  found?: boolean;
  error?: string;
}

type PathSegment =
  | { kind: 'key'; key: string }
  | { kind: 'index'; index: number }
  | { kind: 'slice'; start?: number; end?: number; step?: number }
  | { kind: 'wildcard' }
  | { kind: 'descendant'; key: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseQuotedKey(path: string, start: number): { key: string; end: number } {
  const quote = path[start];
  let key = '';
  let i = start + 1;
  while (i < path.length && path[i] !== quote) {
    if (path[i] === '\\' && i + 1 < path.length) {
      key += path[i + 1];
      i += 2;
      continue;
    }
    key += path[i++];
  }
  if (path[i] !== quote) throw new Error(`Unterminated quoted key in path: ${path}`);
  return { key, end: i + 1 };
}

function parseBracket(path: string, start: number): { segments: PathSegment[]; end: number } {
  let i = start + 1;
  while (path[i] === ' ') i++;

  if (path[i] === '"' || path[i] === "'") {
    const keys: string[] = [];
    while (path[i] === '"' || path[i] === "'") {
      const { key, end } = parseQuotedKey(path, i);
      keys.push(key);
      i = end;
      while (path[i] === ' ') i++;
      if (path[i] === ',') {
        i++;
        while (path[i] === ' ') i++;
      }
    }
    if (path[i] !== ']') throw new Error(`Expected ] in path: ${path}`);
    if (keys.length !== 1) throw new Error(`Union of keys is not supported: ${path}`);
    return { segments: [{ kind: 'key', key: keys[0] }], end: i + 1 };
  }

  const close = path.indexOf(']', i);
  if (close === -1) throw new Error(`Expected ] in path: ${path}`);
  const body = path.slice(i, close).trim();

  if (body === '*') return { segments: [{ kind: 'wildcard' }], end: close + 1 };

  if (/^-?\d+$/.test(body)) {
    return { segments: [{ kind: 'index', index: parseInt(body, 10) }], end: close + 1 };
  }

  const slice = /^(-?\d+)?\s*:\s*(-?\d+)?(?:\s*:\s*(-?\d+))?$/.exec(body);
  if (slice) {
    const step = slice[3] !== undefined ? parseInt(slice[3], 10) : undefined;
    if (step === 0) throw new Error('Slice step cannot be 0');
    return {
      segments: [
        {
          kind: 'slice',
          start: slice[1] !== undefined ? parseInt(slice[1], 10) : undefined,
          end: slice[2] !== undefined ? parseInt(slice[2], 10) : undefined,
          step,
        },
      ],
      end: close + 1,
    };
  }

  throw new Error(`Unsupported JSONPath expression: [${body}]`);
}

function readName(path: string, start: number): { name: string; end: number } {
  let i = start;
  while (i < path.length && path[i] !== '.' && path[i] !== '[') i++;
  return { name: path.slice(start, i), end: i };
}

function parsePath(path: string): PathSegment[] {
  const trimmed = path.trim();
  if (trimmed === '' || trimmed === '$') return [];

  let i = 0;
  if (trimmed.startsWith('$')) i = 1;
  const segments: PathSegment[] = [];

  while (i < trimmed.length) {
    const char = trimmed[i];

    if (char === '.' && trimmed[i + 1] === '.') {
      i += 2;
      if (trimmed[i] === '[') {
        const { segments: inner, end } = parseBracket(trimmed, i);
        const first = inner[0];
        if (first.kind === 'key') segments.push({ kind: 'descendant', key: first.key });
        else if (first.kind === 'wildcard') segments.push({ kind: 'descendant', key: null });
        else {
          segments.push({ kind: 'descendant', key: null });
          segments.push(first);
        }
        i = end;
        continue;
      }
      const { name, end } = readName(trimmed, i);
      if (!name) throw new Error(`Expected a name after ".." in path: ${path}`);
      segments.push({ kind: 'descendant', key: name === '*' ? null : name });
      i = end;
      continue;
    }

    if (char === '.') {
      const { name, end } = readName(trimmed, i + 1);
      if (!name) throw new Error(`Expected a name after "." in path: ${path}`);
      segments.push(name === '*' ? { kind: 'wildcard' } : { kind: 'key', key: name });
      i = end;
      continue;
    }

    if (char === '[') {
      const { segments: inner, end } = parseBracket(trimmed, i);
      segments.push(...inner);
      i = end;
      continue;
    }

    if (segments.length === 0 && i === 0) {
      const { name, end } = readName(trimmed, i);
      segments.push(name === '*' ? { kind: 'wildcard' } : { kind: 'key', key: name });
      i = end;
      continue;
    }

    throw new Error(`Unexpected character "${char}" in path: ${path}`);
  }

  return segments;
}

function childrenOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) return Object.values(value);
  return [];
}

function collectDescendants(value: unknown, key: string | null, out: unknown[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (key === null) out.push(item);
      collectDescendants(item, key, out);
    }
  } else if (isRecord(value)) {
    for (const [k, item] of Object.entries(value)) {
      if (key === null || k === key) out.push(item);
      collectDescendants(item, key, out);
    }
  }
}

function applySlice(arr: unknown[], segment: { start?: number; end?: number; step?: number }) {
  const len = arr.length;
  const step = segment.step ?? 1;
  const normalize = (n: number) =>
    n < 0 ? Math.max(len + n, step > 0 ? 0 : -1) : Math.min(n, len);
  const result: unknown[] = [];
  if (step > 0) {
    const start = segment.start === undefined ? 0 : normalize(segment.start);
    const end = segment.end === undefined ? len : normalize(segment.end);
    for (let i = start; i < end; i += step) result.push(arr[i]);
  } else {
    const start =
      segment.start === undefined ? len - 1 : Math.min(normalize(segment.start), len - 1);
    const end = segment.end === undefined ? -1 : normalize(segment.end);
    for (let i = start; i > end; i += step) result.push(arr[i]);
  }
  return result;
}

function evaluatePath(root: unknown, segments: PathSegment[]): unknown[] {
  let nodes: unknown[] = [root];

  for (const segment of segments) {
    const next: unknown[] = [];
    for (const node of nodes) {
      switch (segment.kind) {
        case 'key':
          if (isRecord(node) && Object.prototype.hasOwnProperty.call(node, segment.key)) {
            next.push(node[segment.key]);
          }
          break;
        case 'index':
          if (Array.isArray(node)) {
            const index = segment.index < 0 ? node.length + segment.index : segment.index;
            if (index >= 0 && index < node.length) next.push(node[index]);
          }
          break;
        case 'slice':
          if (Array.isArray(node)) next.push(...applySlice(node, segment));
          break;
        case 'wildcard':
          next.push(...childrenOf(node));
          break;
        case 'descendant':
          collectDescendants(node, segment.key, next);
          break;
      }
    }
    nodes = next;
  }

  return nodes;
}

function isMultiValuePath(segments: PathSegment[]): boolean {
  return segments.some(
    (s) => s.kind === 'wildcard' || s.kind === 'descendant' || s.kind === 'slice'
  );
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

export function process(): number {
  try {
    const inputStr = Host.inputString();
    const input: JsonInput = JSON.parse(inputStr);

    if (typeof input.json !== 'string') {
      throw new Error('json must be a string');
    }
    const parsed: unknown = JSON.parse(input.json);

    let output: JsonOutput;
    if (input.query === undefined || input.query === '') {
      output = { result: parsed, type: typeOf(parsed), found: true };
    } else {
      const segments = parsePath(input.query);
      const matches = evaluatePath(parsed, segments);
      if (isMultiValuePath(segments)) {
        output = { result: matches, type: 'array', found: matches.length > 0 };
      } else if (matches.length === 0) {
        output = { result: null, type: 'undefined', found: false };
      } else {
        output = { result: matches[0], type: typeOf(matches[0]), found: true };
      }
    }

    Host.outputString(JSON.stringify(output));
    return 0;
  } catch (error) {
    const output: JsonOutput = {
      result: null,
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
    Host.outputString(JSON.stringify(output));
    return 1;
  }
}

declare const Host: {
  inputString(): string;
  outputString(s: string): void;
};
