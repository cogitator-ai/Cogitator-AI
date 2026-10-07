/** Lines of context around each change in a unified diff. */
const CONTEXT = 3;

/** Above this many line pairs the diff falls back to one hunk that replaces the whole file. */
const MAX_CELLS = 4_000_000;

type Edit = { op: ' ' | '-' | '+'; line: string };

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** The shortest edit script from `a` to `b`, by the longest common subsequence. */
function editScript(a: readonly string[], b: readonly string[]): Edit[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head: Edit[] = a.slice(0, start).map((line) => ({ op: ' ', line }));
  const tail: Edit[] = a.slice(endA).map((line) => ({ op: ' ', line }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  if (midA.length * midB.length > MAX_CELLS) {
    return [
      ...head,
      ...midA.map((line): Edit => ({ op: '-', line })),
      ...midB.map((line): Edit => ({ op: '+', line })),
      ...tail,
    ];
  }

  const width = midB.length + 1;
  const lcs = new Uint32Array((midA.length + 1) * width);
  for (let i = midA.length - 1; i >= 0; i--) {
    for (let j = midB.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        midA[i] === midB[j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const middle: Edit[] = [];
  let i = 0;
  let j = 0;
  while (i < midA.length || j < midB.length) {
    if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
      middle.push({ op: ' ', line: midA[i] });
      i++;
      j++;
    } else if (
      i < midA.length &&
      (j === midB.length || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])
    ) {
      middle.push({ op: '-', line: midA[i] });
      i++;
    } else {
      middle.push({ op: '+', line: midB[j] });
      j++;
    }
  }
  return [...head, ...middle, ...tail];
}

/**
 * A unified diff from `before` to `after`, as `git diff` prints it, or an
 * empty string when they are equal. A missing side is `undefined`: the file
 * is created or deleted.
 */
export function unifiedDiff(
  path: string,
  before: string | undefined,
  after: string | undefined
): string {
  if (before === after) return '';
  const a = splitLines(before ?? '');
  const b = splitLines(after ?? '');
  const edits = editScript(a, b);

  const changed = edits.flatMap((edit, index) => (edit.op === ' ' ? [] : [index]));
  if (changed.length === 0) return '';

  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const from = Math.max(0, index - CONTEXT);
    const to = Math.min(edits.length, index + CONTEXT + 1);
    const last = ranges.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }

  const out = [
    `--- ${before === undefined ? '/dev/null' : `a/${path}`}`,
    `+++ ${after === undefined ? '/dev/null' : `b/${path}`}`,
  ];
  let lineA = 1;
  let lineB = 1;
  let cursor = 0;
  for (const [from, to] of ranges) {
    for (; cursor < from; cursor++) {
      if (edits[cursor].op !== '+') lineA++;
      if (edits[cursor].op !== '-') lineB++;
    }
    const hunk = edits.slice(from, to);
    const countA = hunk.filter((edit) => edit.op !== '+').length;
    const countB = hunk.filter((edit) => edit.op !== '-').length;
    out.push(
      `@@ -${countA === 0 ? lineA - 1 : lineA},${countA} +${countB === 0 ? lineB - 1 : lineB},${countB} @@`
    );
    for (const edit of hunk) out.push(`${edit.op}${edit.line}`);
    for (; cursor < to; cursor++) {
      if (edits[cursor].op !== '+') lineA++;
      if (edits[cursor].op !== '-') lineB++;
    }
  }
  return out.join('\n') + '\n';
}
