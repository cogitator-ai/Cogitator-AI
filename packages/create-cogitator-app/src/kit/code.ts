/**
 * Source text for a generated file, written as an indented template literal.
 *
 * Escapes work as in any template literal: write `\\n` for a backslash and an
 * `n` in the generated code, `` \` `` for a backtick and `\${` for `${`.
 *
 * The common indentation of the template is removed, so a template can follow the
 * indentation of the code that writes it. A multi-line value is indented to the column
 * of its placeholder, so a nested block lands where it is interpolated. `false`, `null`
 * and `undefined` render as nothing, and a line left blank by them is dropped, which
 * makes `${cond && 'line'}` an optional line. Runs of blank lines collapse to one, and
 * the result ends with exactly one newline.
 */
export function code(strings: TemplateStringsArray, ...values: unknown[]): string {
  const parts = Array.from(strings, (part, index) => {
    if (part === undefined)
      throw new Error(`Invalid escape sequence in code template part ${index}`);
    return part;
  });
  const dropped = new Set<number>();
  let out = '';

  for (let i = 0; i < parts.length; i++) {
    out += parts[i];
    if (i >= values.length) break;

    const value = values[i];
    if (value === false || value === null || value === undefined) {
      dropped.add(lineIndex(out));
      continue;
    }

    const text = String(value).replace(/\n$/, '');
    const lineStart = out.lastIndexOf('\n') + 1;
    const indent = /^[ \t]*/.exec(out.slice(lineStart))?.[0] ?? '';
    out += text.replace(/\n(?=[^\n])/g, `\n${indent}`);
  }

  const lines = out.split('\n');
  const kept = lines.filter((line, index) => !(dropped.has(index) && line.trim() === ''));
  return finish(dedent(kept));
}

function lineIndex(text: string): number {
  let count = 0;
  for (const char of text) if (char === '\n') count++;
  return count;
}

function dedent(lines: string[]): string[] {
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

  let common = Infinity;
  for (const line of lines) {
    if (line.trim() === '') continue;
    common = Math.min(common, /^ */.exec(line)?.[0].length ?? 0);
  }
  if (!Number.isFinite(common) || common === 0) return lines;
  return lines.map((line) => (line.trim() === '' ? '' : line.slice(common)));
}

function finish(lines: string[]): string {
  const collapsed: string[] = [];
  for (const line of lines) {
    const blank = line.trim() === '';
    if (blank && collapsed.length > 0 && collapsed[collapsed.length - 1] === '') continue;
    collapsed.push(blank ? '' : line.replace(/[ \t]+$/, ''));
  }
  return collapsed.join('\n') + '\n';
}

/** `value` as a single-quoted TypeScript string literal, safe for any input. */
export function tsString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\p{Zl}/gu, '\\u2028')
    .replace(/\p{Zp}/gu, '\\u2029');
  return `'${escaped}'`;
}

/** `name` as a property key: bare when it is an identifier, quoted otherwise. */
export function tsKey(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : tsString(name);
}

/** A YAML scalar for `value`, quoted only when YAML would read it as something else. */
export function yamlString(value: string): string {
  if (value === '' || /^[\s]|[\s]$/.test(value)) return JSON.stringify(value);
  if (/^(true|false|yes|no|on|off|null|~|[-+]?\d[\d._:eE+-]*)$/i.test(value)) {
    return JSON.stringify(value);
  }
  if (/[:#{}[\],&*!|>'"%@`]|^[-?]/.test(value)) return JSON.stringify(value);
  return value;
}
