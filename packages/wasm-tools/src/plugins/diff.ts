interface DiffInput {
  original: string;
  modified: string;
  format?: 'unified' | 'inline' | 'json';
  context?: number;
}

interface DiffChange {
  type: 'add' | 'remove' | 'equal';
  value: string;
  lineNumber?: { original?: number; modified?: number };
}

interface DiffOutput {
  diff: string;
  additions: number;
  deletions: number;
  changes: DiffChange[];
  error?: string;
}

function myersDiff(oldArr: string[], newArr: string[]): DiffChange[] {
  const n = oldArr.length;
  const m = newArr.length;
  const max = n + m;

  if (max === 0) return [];

  const v: Record<number, number> = { 1: 0 };
  const trace: Array<Record<number, number>> = [];

  outer: for (let d = 0; d <= max; d++) {
    trace.push({ ...v });

    for (let k = -d; k <= d; k += 2) {
      let x: number;

      if (k === -d || (k !== d && v[k - 1] < v[k + 1])) {
        x = v[k + 1];
      } else {
        x = v[k - 1] + 1;
      }

      let y = x - k;

      while (x < n && y < m && oldArr[x] === newArr[y]) {
        x++;
        y++;
      }

      v[k] = x;

      if (x >= n && y >= m) {
        break outer;
      }
    }
  }

  const changes: DiffChange[] = [];
  let x = n;
  let y = m;

  for (let d = trace.length - 1; d >= 0; d--) {
    const vPrev = trace[d];
    const k = x - y;

    let prevK: number;
    if (k === -d || (k !== d && vPrev[k - 1] < vPrev[k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }

    const prevX = vPrev[prevK];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      changes.unshift({
        type: 'equal',
        value: oldArr[x - 1],
        lineNumber: { original: x, modified: y },
      });
      x--;
      y--;
    }

    if (d > 0) {
      if (x === prevX) {
        changes.unshift({
          type: 'add',
          value: newArr[y - 1],
          lineNumber: { modified: y },
        });
        y--;
      } else {
        changes.unshift({
          type: 'remove',
          value: oldArr[x - 1],
          lineNumber: { original: x },
        });
        x--;
      }
    }
  }

  return changes;
}

function formatRange(start: number, count: number): string {
  if (count === 0) return `${start - 1},0`;
  return count === 1 ? `${start}` : `${start},${count}`;
}

function formatUnified(changes: DiffChange[], context: number): string {
  const changeIndexes: number[] = [];
  changes.forEach((change, index) => {
    if (change.type !== 'equal') changeIndexes.push(index);
  });
  if (changeIndexes.length === 0) return '';

  const hunks: Array<{ start: number; end: number }> = [];
  for (const index of changeIndexes) {
    const start = Math.max(0, index - context);
    const end = Math.min(changes.length - 1, index + context);
    const last = hunks[hunks.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      hunks.push({ start, end });
    }
  }

  const oldLineAt: number[] = [];
  const newLineAt: number[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const change of changes) {
    oldLineAt.push(oldLine);
    newLineAt.push(newLine);
    if (change.type !== 'add') oldLine++;
    if (change.type !== 'remove') newLine++;
  }

  const lines: string[] = ['--- original', '+++ modified'];
  for (const hunk of hunks) {
    const slice = changes.slice(hunk.start, hunk.end + 1);
    const oldCount = slice.filter((c) => c.type !== 'add').length;
    const newCount = slice.filter((c) => c.type !== 'remove').length;
    lines.push(
      `@@ -${formatRange(oldLineAt[hunk.start], oldCount)} +${formatRange(newLineAt[hunk.start], newCount)} @@`
    );
    for (const change of slice) {
      const prefix = change.type === 'add' ? '+' : change.type === 'remove' ? '-' : ' ';
      lines.push(`${prefix}${change.value}`);
    }
  }

  return lines.join('\n');
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function formatInline(changes: DiffChange[]): string {
  const lines: string[] = [];

  for (const change of changes) {
    if (change.type === 'add') {
      lines.push(`[+] ${change.value}`);
    } else if (change.type === 'remove') {
      lines.push(`[-] ${change.value}`);
    } else {
      lines.push(`    ${change.value}`);
    }
  }

  return lines.join('\n');
}

export function diff(): number {
  try {
    const inputStr = Host.inputString();
    const input: DiffInput = JSON.parse(inputStr);

    if (typeof input.original !== 'string' || typeof input.modified !== 'string') {
      throw new Error('original and modified must be strings');
    }
    const format = input.format ?? 'unified';
    if (format !== 'unified' && format !== 'inline' && format !== 'json') {
      throw new Error(`Unknown format: ${String(format)}`);
    }
    const context = input.context ?? 3;
    if (!Number.isInteger(context) || context < 0) {
      throw new Error('context must be a non-negative integer');
    }

    const oldLines = splitLines(input.original);
    const newLines = splitLines(input.modified);

    const changes = myersDiff(oldLines, newLines);

    const additions = changes.filter((c) => c.type === 'add').length;
    const deletions = changes.filter((c) => c.type === 'remove').length;

    let diffStr: string;
    if (format === 'json') {
      diffStr = JSON.stringify(changes);
    } else if (format === 'inline') {
      diffStr = formatInline(changes);
    } else {
      diffStr = formatUnified(changes, context);
    }

    const output: DiffOutput = {
      diff: diffStr,
      additions,
      deletions,
      changes,
    };

    Host.outputString(JSON.stringify(output));
    return 0;
  } catch (error) {
    const output: DiffOutput = {
      diff: '',
      additions: 0,
      deletions: 0,
      changes: [],
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
