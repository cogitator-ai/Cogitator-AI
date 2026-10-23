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

/**
 * Characters the search may read in all, as a multiple of the answer's length: an answer full of
 * brackets that open and never close (text an extraction quotes back, say) makes every one of
 * them a start whose scan runs to the end, and this keeps the search linear in the answer
 */
const SCAN_BUDGET = 4;

/** What the search may still read, shared by every start */
interface Budget {
  left: number;
}

/**
 * The pieces of text between the commas of the array that opens at `from`, and where it closes.
 * Undefined when its brackets do not pair, or when the budget ran out before it closed
 */
function scanArray(
  text: string,
  from: number,
  budget: Budget
): { elements: string[]; end?: number } | undefined {
  const open: string[] = [];
  const elements: string[] = [];
  let start = from + 1;
  let inString = false;
  let escaped = false;
  for (let at = from; at < text.length; at++) {
    if (--budget.left < 0) return undefined;
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

function parsed(element: string, budget: Budget): unknown[] {
  const text = element.trim();
  if (!text) return [];
  budget.left -= text.length;
  if (budget.left < 0 || !/^[[{"\d-]|^(true|false|null)$/.test(text)) return [];
  try {
    return [JSON.parse(text) as unknown];
  } catch {
    return [];
  }
}

/** Where the next array that could hold objects opens: a `[` before a `{`, or an empty one */
const START = /\[\s*[{\]]/g;

function nextStart(text: string, from: number): number {
  START.lastIndex = from;
  return START.exec(text)?.index ?? -1;
}

const isObject = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The first JSON array in `answer` that holds an object, so a bracket in the text before it (such
 * as a message number, `[3]`) is passed over, and so is text after it. Only a `[` that opens
 * with an object, or an empty array, is tried. An empty array counts
 * only when no array of objects follows, so `No items in []` before the answer does not hide
 * it. Each element is read on its own: one that is not JSON is left out instead of failing the
 * array. When the answer ends inside the array, as one cut at its length limit does, the
 * elements it finished are kept and `cut` says the rest is missing. Undefined when no such array
 * is there. The search reads at most a few times the answer's length, however many brackets it
 * holds.
 */
export function findAnswerArray(answer: string): AnswerArray | undefined {
  const budget: Budget = { left: answer.length * SCAN_BUDGET };
  let empty: AnswerArray | undefined;
  let from = nextStart(answer, 0);
  while (from !== -1 && budget.left > 0) {
    const scan = scanArray(answer, from, budget);
    if (scan) {
      const values = scan.elements.flatMap((element) => parsed(element, budget));
      if (values.some(isObject)) return { values, cut: scan.end === undefined };
      if (scan.end !== undefined && scan.elements.every((element) => !element.trim())) {
        empty ??= { values: [], cut: false };
      }
    }
    from = nextStart(answer, scan?.end !== undefined ? scan.end + 1 : from + 1);
  }
  return empty;
}
