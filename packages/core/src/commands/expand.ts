import type { CommandDefinition } from '@cogitator-ai/types';

/** An input that names a command: the name after `/` and what follows it */
export interface CommandInvocation {
  name: string;
  arguments: string;
}

/**
 * The command `input` names: `/name` at its very start, then white space and the arguments.
 * Undefined for any other input, `/` alone or a path such as `/usr/bin` included
 */
export function commandInvocation(input: string): CommandInvocation | undefined {
  const text = input.trimEnd();
  if (!text.startsWith('/')) return undefined;
  let end = 1;
  while (end < text.length && !isSpace(text[end] ?? '') && text[end] !== '/') end++;
  if (end === 1) return undefined;
  if (end < text.length && !isSpace(text[end] ?? '')) return undefined;
  return { name: text.slice(1, end), arguments: text.slice(end).trim() };
}

function isSpace(char: string): boolean {
  return (
    char === ' ' ||
    char === '\t' ||
    char === '\n' ||
    char === '\r' ||
    char === '\f' ||
    char === '\v'
  );
}

/**
 * `text` split into arguments the way a shell splits words: white space separates them, double
 * and single quotes keep white space in one, and a backslash outside single quotes takes the next
 * character as it is
 */
export function splitArguments(text: string): string[] {
  const args: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? '';
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else if (char === '\\' && quote === '"' && index + 1 < text.length) {
        current += text[++index] ?? '';
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === '\\' && index + 1 < text.length) {
      current += text[++index] ?? '';
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

/** Values of `${NAME}` variables a template may hold, such as `CLAUDE_PROJECT_DIR` */
export type CommandVariables = Readonly<Record<string, string>>;

/**
 * The message `command` makes of `args`, as Claude Code expands it: `$ARGUMENTS` is everything
 * typed after the name, `$ARGUMENTS[N]` and `$N` the argument at 0-based position `N` (split as
 * a shell splits words), and `$name` the argument at the position of `name` in the command's
 * `arguments`. An indexed placeholder without an argument stays as written, a named one becomes
 * empty. A single backslash before a placeholder keeps it as written, without the backslash.
 * Values are put in as they are, never expanded again. When arguments were given and no
 * placeholder took one, they are added at the end as `ARGUMENTS: <value>`. `${NAME}` variables of
 * `variables` are replaced first
 */
export function expandCommand(
  command: Pick<CommandDefinition, 'template' | 'arguments'>,
  args: string,
  variables: CommandVariables = {}
): string {
  const positional = splitArguments(args);
  const names = command.arguments ?? [];
  const withVariables = command.template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (all, name) =>
    Object.hasOwn(variables, name) ? (variables[name] ?? all) : all
  );
  let received = false;
  let expanded = '';
  let slashes = 0;
  for (let at = 0; at < withVariables.length;) {
    const char = withVariables[at] ?? '';
    if (char === '\\') {
      slashes++;
      at++;
      continue;
    }
    const pending = '\\'.repeat(slashes);
    slashes = 0;
    const token = char === '$' ? placeholderAt(withVariables, at + 1) : undefined;
    if (!token || (token.kind === 'named' && !names.includes(token.value))) {
      expanded += pending + char;
      at++;
      continue;
    }
    const written = withVariables.slice(at, token.end);
    at = token.end;
    if (pending.length === 1) {
      expanded += written;
      continue;
    }
    let value: string | undefined;
    if (token.kind === 'whole') value = args;
    else if (token.kind === 'index') value = positional[Number(token.value)];
    else {
      value = positional[names.indexOf(token.value)] ?? '';
      received = true;
    }
    if (value === undefined) {
      expanded += pending + written;
      continue;
    }
    if (args !== '') received = true;
    expanded += pending + value;
  }
  expanded += '\\'.repeat(slashes);
  if (args !== '' && !received) return `${expanded}\n\nARGUMENTS: ${args}`;
  return expanded;
}

/** A placeholder after a `$` at `from`: its kind, what it names and where it ends */
function placeholderAt(
  text: string,
  from: number
): { kind: 'whole' | 'index' | 'named'; value: string; end: number } | undefined {
  const digitsFrom = (start: number): number => {
    let end = start;
    while (end < text.length && isDigit(text[end] ?? '')) end++;
    return end;
  };
  if (text.startsWith('ARGUMENTS[', from)) {
    const open = from + 'ARGUMENTS['.length;
    const end = digitsFrom(open);
    if (end > open && text[end] === ']') {
      return { kind: 'index', value: text.slice(open, end), end: end + 1 };
    }
  }
  const digits = digitsFrom(from);
  if (digits > from) return { kind: 'index', value: text.slice(from, digits), end: digits };
  if (!isWordStart(text[from] ?? '')) return undefined;
  let end = from + 1;
  while (end < text.length && (isWordStart(text[end] ?? '') || isDigit(text[end] ?? ''))) end++;
  const word = text.slice(from, end);
  return word === 'ARGUMENTS'
    ? { kind: 'whole', value: word, end }
    : { kind: 'named', value: word, end };
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function isWordStart(char: string): boolean {
  return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_';
}
