/**
 * Reading a shell command the way permission rules match it: split into the commands it runs,
 * wrappers such as `timeout` and leading variable assignments taken off
 */

/** A command of a command line, as rules match it */
export interface ShellCommand {
  /** The words of the command, quotes kept as written, joined by single spaces */
  text: string;
  /** The words, quotes removed */
  words: string[];
  /** Names of the variables the command line assigned before the command */
  assigned: string[];
  /** Whether it writes to a file with `>` or `>>` (not `2>&1` or `/dev/null`) */
  redirectsOutput: boolean;
}

/** A command line taken apart, see {@link parseCommandLine} */
export interface ParsedCommandLine {
  /** The commands of the line itself, in order */
  commands: ShellCommand[];
  /**
   * The commands it runs inside command substitutions, subshells, groups and loop bodies, for
   * `deny` and `ask` rules, which match any command a line runs
   */
  nested: ShellCommand[];
  /**
   * False when the line cannot be read with certainty (an open quote, an operator with nothing
   * after it, a command or process substitution): `allow` rules then match nothing
   */
  certain: boolean;
}

const SEPARATORS = ['&&', '||', '|&', ';', '|', '&', '\n'];

const SAFE_VARIABLES = new Set([
  'NODE_ENV',
  'CI',
  'DEBUG',
  'FORCE_COLOR',
  'NO_COLOR',
  'TERM',
  'LANG',
  'LC_ALL',
  'TZ',
  'PYTHONUNBUFFERED',
  'PYTHONDONTWRITEBYTECODE',
  'RUST_BACKTRACE',
  'RUST_LOG',
  'GOFLAGS',
]);

const FLOW_KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'while',
  'until',
  'for',
  'case',
  'esac',
  'in',
  '{',
  '}',
  '(',
  ')',
  '!',
]);

interface RawPiece {
  text: string;
  nested: string[];
  uncertain: boolean;
}

/** Splits `line` at its separators outside quotes, collecting what runs inside `$(...)` and backticks */
function splitLine(line: string): { pieces: RawPiece[]; certain: boolean } {
  const pieces: RawPiece[] = [];
  let current = '';
  let nested: string[] = [];
  let uncertain = false;
  let certain = true;
  let quote: '"' | "'" | undefined;
  let i = 0;
  const push = () => {
    pieces.push({ text: current, nested, uncertain });
    current = '';
    nested = [];
    uncertain = false;
  };
  while (i < line.length) {
    const char = line[i];
    if (quote === "'") {
      current += char;
      if (char === "'") quote = undefined;
      i++;
      continue;
    }
    if (char === '\\' && i + 1 < line.length) {
      current += char + line[i + 1];
      i += 2;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === '$' && line[i + 1] === '(') {
        const end = closingParen(line, i + 1);
        nested.push(line.slice(i + 2, end));
        uncertain = true;
        current += line.slice(i, end + 1);
        i = end + 1;
        continue;
      } else if (char === '`') {
        const end = line.indexOf('`', i + 1);
        const stop = end === -1 ? line.length : end;
        nested.push(line.slice(i + 1, stop));
        uncertain = true;
        current += line.slice(i, stop + 1);
        i = stop + 1;
        continue;
      }
      current += char;
      i++;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      i++;
      continue;
    }
    if ((char === '$' || char === '<' || char === '>') && line[i + 1] === '(') {
      const end = closingParen(line, i + 1);
      nested.push(line.slice(i + 2, end));
      uncertain = true;
      current += line.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (char === '`') {
      const end = line.indexOf('`', i + 1);
      const stop = end === -1 ? line.length : end;
      nested.push(line.slice(i + 1, stop));
      uncertain = true;
      current += line.slice(i, stop + 1);
      i = stop + 1;
      continue;
    }
    if (char === '#' && (current === '' || /\s$/.test(current))) {
      const end = line.indexOf('\n', i);
      i = end === -1 ? line.length : end;
      continue;
    }
    const separator = SEPARATORS.find((candidate) => line.startsWith(candidate, i));
    if (separator && !(separator === '&' && (line[i - 1] === '>' || line[i + 1] === '>'))) {
      push();
      i += separator.length;
      if (
        separator !== '\n' &&
        separator !== ';' &&
        separator !== '&' &&
        !/\S/.test(line.slice(i))
      ) {
        certain = false;
      }
      continue;
    }
    current += char;
    i++;
  }
  if (quote) certain = false;
  push();
  return { pieces: pieces.filter((piece) => piece.text.trim() !== ''), certain };
}

function closingParen(line: string, open: number): number {
  let depth = 0;
  let quote: '"' | "'" | undefined;
  for (let i = open; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === '\\' && quote === '"') i++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '\\') {
      i++;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return line.length;
}

/** The words of `piece`, each as written (`raw`) and with its quotes removed (`value`) */
function wordsOf(piece: string): Array<{ raw: string; value: string }> {
  const words: Array<{ raw: string; value: string }> = [];
  let raw = '';
  let value = '';
  let quote: '"' | "'" | undefined;
  let started = false;
  const push = () => {
    if (started) words.push({ raw, value });
    raw = '';
    value = '';
    started = false;
  };
  for (let i = 0; i < piece.length; i++) {
    const char = piece[i];
    if (quote) {
      raw += char;
      if (char === quote) quote = undefined;
      else if (char === '\\' && quote === '"' && i + 1 < piece.length) {
        raw += piece[i + 1];
        value += piece[i + 1];
        i++;
      } else value += char;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    started = true;
    if (char === "'" || char === '"') {
      quote = char;
      raw += char;
      continue;
    }
    if (char === '\\' && i + 1 < piece.length) {
      raw += char + piece[i + 1];
      value += piece[i + 1];
      i++;
      continue;
    }
    raw += char;
    value += char;
  }
  push();
  return words;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Takes the wrappers that run their arguments as the command off the front of `words` */
function unwrap(
  words: Array<{ raw: string; value: string }>
): Array<{ raw: string; value: string }> {
  let rest = words;
  for (;;) {
    const head = rest[0]?.value;
    if (head === undefined) return rest;
    if (head === 'timeout') {
      let i = 1;
      while (rest[i]?.value.startsWith('-')) {
        const flag = rest[i].value;
        i += /^-(s|k|-signal|-kill-after)$/.test(flag) ? 2 : 1;
      }
      rest = rest.slice(i + 1);
      continue;
    }
    if (head === 'time') {
      rest = rest.slice(rest[1]?.value === '-p' ? 2 : 1);
      continue;
    }
    if (head === 'nice') {
      let i = 1;
      if (rest[i]?.value === '-n') i += 2;
      else if (/^-\d+$/.test(rest[i]?.value ?? '') || /^-n\d+$/.test(rest[i]?.value ?? '')) i++;
      rest = rest.slice(i);
      continue;
    }
    if (head === 'stdbuf') {
      let i = 1;
      while (
        /^-[ioe]/.test(rest[i]?.value ?? '') ||
        /^--(input|output|error)=/.test(rest[i]?.value ?? '')
      ) {
        i += /^-[ioe]$/.test(rest[i].value) ? 2 : 1;
      }
      rest = rest.slice(i);
      continue;
    }
    if (head === 'nohup' || head === 'builtin' || head === 'noglob') {
      rest = rest.slice(1);
      continue;
    }
    if (head === 'command' && rest[1]?.value !== '-v' && rest[1]?.value !== '-V') {
      rest = rest.slice(rest[1]?.value === '-p' ? 2 : 1);
      continue;
    }
    if (head === 'xargs' && rest[1] !== undefined && !rest[1].value.startsWith('-')) {
      rest = rest.slice(1);
      continue;
    }
    return rest;
  }
}

function commandOf(piece: string): ShellCommand | undefined {
  let words = wordsOf(piece);
  while (words.length > 0 && FLOW_KEYWORDS.has(words[0].value)) words = words.slice(1);
  if (words[0]?.value.startsWith('(')) {
    words = [{ raw: words[0].raw.slice(1), value: words[0].value.slice(1) }, ...words.slice(1)];
    if (words[0].value === '') words = words.slice(1);
  }
  const assigned: string[] = [];
  for (;;) {
    words = unwrap(words);
    const head = words[0];
    if (!head || !ASSIGNMENT.test(head.value)) break;
    assigned.push(head.value.slice(0, head.value.indexOf('=')));
    words = words.slice(1);
  }
  while (words.length > 0 && /^\)+$/.test(words[words.length - 1].value))
    words = words.slice(0, -1);
  if (words.length === 0) return undefined;
  const redirectsOutput = words.some((word, index) => {
    if (!/^\d*>>?/.test(word.raw) && !word.raw.startsWith('&>')) return false;
    const target = word.value.replace(/^\d*>>?|^&>/, '') || words[index + 1]?.value || '';
    return !/^&\d$/.test(target) && target !== '/dev/null';
  });
  return {
    text: words.map((word) => word.raw).join(' '),
    words: words.map((word) => word.value),
    assigned,
    redirectsOutput,
  };
}

/**
 * Takes a command line apart the way Claude Code's permission rules read it: the commands
 * between `&&`, `||`, `;`, `|`, `|&`, `&` and newlines, outside quotes, each without the wrappers
 * that run their arguments (`timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`, `builtin`,
 * `noglob`, a bare `xargs`) and leading `NAME=value` assignments, and the commands inside
 * command substitutions, subshells and loop bodies apart
 */
export function parseCommandLine(line: string, depth = 0): ParsedCommandLine {
  const { pieces, certain } = splitLine(line);
  const commands: ShellCommand[] = [];
  const nested: ShellCommand[] = [];
  let sure = certain;
  for (const piece of pieces) {
    if (piece.uncertain) sure = false;
    const command = commandOf(piece.text);
    if (command) commands.push(command);
    if (depth < 8) {
      for (const inner of piece.nested) {
        const parsed = parseCommandLine(inner, depth + 1);
        nested.push(...parsed.commands, ...parsed.nested);
      }
    }
  }
  return { commands, nested, certain: sure };
}

/** Whether `command` assigns only variables known to be safe before it runs */
export function assignsOnlySafeVariables(command: ShellCommand): boolean {
  return command.assigned.every((name) => SAFE_VARIABLES.has(name));
}

/**
 * Whether `command` matches the command pattern of a rule: `*` stands for any text, spaces
 * included, a trailing ` *` (or `:*`) that is the only wildcard also matches the command without
 * anything after it, and the rest is compared as written, runs of spaces as one
 */
export function matchesCommandPattern(command: string, pattern: string): boolean {
  let spec = pattern.trim().replace(/\s+/g, ' ');
  if (spec.endsWith(':*')) spec = `${spec.slice(0, -2)} *`;
  if (spec === '*' || spec === '') return true;
  const wildcards = spec.split('*').length - 1;
  if (wildcards === 1 && spec.endsWith(' *') && command === spec.slice(0, -2)) return true;
  const source = spec
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\S]*');
  return new RegExp(`^${source}$`).test(command);
}
