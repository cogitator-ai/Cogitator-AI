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

function formatUnified(changes: DiffChange[], context: number): string {
  const lines: string[] = [];
  let i = 0;

  while (i < changes.length) {
    let start = i;
    while (start > 0 && i - start < context && changes[start - 1].type === 'equal') {
      start--;
    }

    let end = i;
    while (end < changes.length) {
      if (changes[end].type !== 'equal') {
        let nextChange = end + 1;
        while (nextChange < changes.length && changes[nextChange].type === 'equal') {
          nextChange++;
        }
        if (nextChange - end <= context * 2 && nextChange < changes.length) {
          end = nextChange;
        } else {
          end = Math.min(end + context, changes.length - 1);
          break;
        }
      }
      end++;
    }

    if (end >= changes.length) end = changes.length - 1;

    let hasChanges = false;
    for (let j = start; j <= end; j++) {
      if (changes[j].type !== 'equal') {
        hasChanges = true;
        break;
      }
    }

    if (hasChanges) {
      for (let j = start; j <= end; j++) {
        const change = changes[j];
        if (change.type === 'add') {
          lines.push(`+ ${change.value}`);
        } else if (change.type === 'remove') {
          lines.push(`- ${change.value}`);
        } else {
          lines.push(`  ${change.value}`);
        }
      }
    }

    i = end + 1;
    while (i < changes.length && changes[i].type === 'equal') {
      i++;
    }
  }

  return lines.join('\n');
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

    const format = input.format ?? 'unified';
    const context = input.context ?? 3;

    const oldLines = input.original.split('\n');
    const newLines = input.modified.split('\n');

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
