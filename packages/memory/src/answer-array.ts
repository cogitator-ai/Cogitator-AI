/**
 * Reading the JSON array of objects a model answers with, out of the text around it, and out of
 * an answer its length limit cut
 */

/** The array an answer holds: its elements that are JSON, and whether the answer ended inside it */
export interface AnswerArray {
  values: unknown[];
  /** The answer stopped before the array closed, so `values` are the elements it finished */
  cut: boolean;
}

const CLOSER: Readonly<Record<string, string>> = { '[': ']', '{': '}' };

/** The pieces of text between the commas of the array that opens at `from`, and where it closes */
function scanArray(text: string, from: number): { elements: string[]; end?: number } | undefined {
  const open: string[] = [];
  const elements: string[] = [];
  let start = from + 1;
  let inString = false;
  let escaped = false;
  for (let at = from; at < text.length; at++) {
    const char = text[at]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '[' || char === '{') {
      open.push(CLOSER[char]!);
    } else if (char === ']' || char === '}') {
      if (open.pop() !== char) return undefined;
      if (open.length === 0) {
        elements.push(text.slice(start, at));
        return { elements, end: at };
      }
    } else if (char === ',' && open.length === 1) {
      elements.push(text.slice(start, at));
      start = at + 1;
    }
  }
  elements.push(text.slice(start));
  return { elements };
}

function parsed(element: string): unknown[] {
  const text = element.trim();
  if (!text) return [];
  try {
    return [JSON.parse(text) as unknown];
  } catch {
    return [];
  }
}

const isObject = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The first JSON array in `answer` that is empty or holds an object, so a bracket in the text
 * before it (such as a message number, `[3]`) is passed over, and so is text after it. Each
 * element is read on its own: one that is not JSON is left out instead of failing the array.
 * When the answer ends inside the array, as one cut at its length limit does, the elements it
 * finished are kept and `cut` says the rest is missing. Undefined when no such array is there.
 */
export function findAnswerArray(answer: string): AnswerArray | undefined {
  let from = answer.indexOf('[');
  while (from !== -1) {
    const scan = scanArray(answer, from);
    if (scan) {
      const values = scan.elements.flatMap(parsed);
      const empty = scan.end !== undefined && scan.elements.every((element) => !element.trim());
      if (empty || values.some(isObject)) return { values, cut: scan.end === undefined };
    }
    from = answer.indexOf('[', scan?.end !== undefined ? scan.end + 1 : from + 1);
  }
  return undefined;
}
