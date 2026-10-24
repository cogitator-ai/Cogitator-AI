/**
 * Reading a shell command line the way permission rules match it: tokenized as a POSIX shell does
 * (quotes, escapes, line continuations, redirections glued to words), split into the commands it
 * runs, each as its argument vector. Rules match the argument vector, never the raw text, and an
 * allow rule only matches a command the parser fully understands
 */

import { basename, posix } from 'node:path';
import { wildcardMatch } from './wildcard';

/** A redirection of a command */
export interface ShellRedirect {
  /** The operator, such as `>`, `>>`, `<`, `<>`, `&>`, `>&`, `<<`, `<<<` */
  op: string;
  /** The file the redirection reads or writes, quotes removed */
  target: string;
  /** Whether it writes the target (`>`, `>>`, `>|`, `<>`, `&>`, `&>>`, `>&file`) */
  writes: boolean;
  /** Whether it reads the target (`<`, `<>`) */
  reads: boolean;
}

/** A command of a command line, as rules match it */
export interface ShellCommand {
  /** The words of the command, quotes and escapes removed, assignments before it taken off */
  argv: string[];
  /** `argv` joined by single spaces, what command patterns match */
  text: string;
  /** Names of the variables assigned before the command (`NAME=value`, `env NAME=value`) */
  assigned: string[];
  redirects: ShellRedirect[];
  /**
   * Whether the command is plain enough for an allow rule: no substitutions, expansions,
   * here-documents, subshells, control flow or function definitions, no program that runs other
   * code (`eval`, `exec`, `source`, shells with `-c`, `sudo`, `env` with flags...) and only the
   * wrappers whose options are known (`timeout`, `time`, `nice`, `nohup`, `stdbuf`, `command`,
   * `builtin`, `noglob`, a bare `xargs`), which are taken off `argv`
   */
  understood: boolean;
  /**
   * `.` when the command runs where the line starts. Undefined after a `cd`, `pushd`, `popd` or a
   * subshell earlier in the line: the directory is not followed (a failed `cd` stays, `cd -P`
   * resolves physically), so such a command is never understood
   */
  dir?: string;
}

/** A command line taken apart, see {@link parseCommandLine} */
export interface ParsedCommandLine {
  /** The commands of the line itself, in order, safe wrappers taken off */
  commands: ShellCommand[];
  /**
   * Every command the line may run, for `deny` and `ask` rules: each command as written and with
   * every wrapper taken off (`sudo`, `env`, `nice`, `xargs`, `exec`...), the program by its base
   * name too, the commands of `sh -c '...'`, `eval`, `find -exec`, substitutions, subshells and
   * loop bodies, and `git` without its global options
   */
  candidates: ShellCommand[];
  /** Whether every command is understood and nothing is left unfinished */
  certain: boolean;
}

interface Word {
  value: string;
  /** It holds an expansion or a substitution, so its value is not known before it runs */
  expands: boolean;
  /** Some of it was quoted or escaped */
  quoted: boolean;
  /** It holds an unquoted glob (`*`, `?`, `[...]`) or brace expansion, so the shell rewrites it */
  globbed: boolean;
}

type Token =
  | { type: 'word'; word: Word }
  | { type: 'op'; op: string }
  | { type: 'paren'; open: boolean }
  | { type: 'redirect'; redirect: ShellRedirect; heredoc: boolean };

interface Lexed {
  tokens: Token[];
  /** Command lines inside substitutions and process substitutions */
  nested: string[];
  /** Something the lexer could not finish: an open quote, a missing `)` */
  unfinished: boolean;
}

const OPERATORS = ['&&', '||', ';;&', ';;', ';&', '|&', ';', '|', '&', '\n'];

/** Reads the text between `(` at `open` and its `)`, quotes respected; -1 when it never closes */
function closingParen(line: string, open: number): number {
  let depth = 0;
  let quote: '"' | "'" | undefined;
  for (let i = open; i < line.length; i++) {
    const char = line[i];
    if (quote === "'") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (char === '\\') {
      i++;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Reads the `}` or `]` that closes the `{` or `[` at `open`, nesting and quotes respected */
function closingBracket(line: string, open: number): number {
  const opener = line[open];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let quote: '"' | "'" | undefined;
  for (let i = open; i < line.length; i++) {
    const char = line[i];
    if (quote === "'") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (char === '\\') {
      i++;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === opener) depth++;
    else if (char === closer) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const ANSI_ESCAPES: Record<string, string> = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
};

/** The value of an ANSI-C quoted string (`$'...'`) starting after its `'`, and where it ends */
function ansiC(line: string, from: number): { value: string; end: number } {
  let value = '';
  for (let i = from; i < line.length; i++) {
    const char = line[i];
    if (char === "'") return { value, end: i };
    if (char !== '\\') {
      value += char;
      continue;
    }
    const next = line[i + 1] ?? '';
    if (next in ANSI_ESCAPES) {
      value += ANSI_ESCAPES[next];
      i++;
      continue;
    }
    if (next === 'x' || next === 'u' || next === 'U') {
      const size = next === 'x' ? 2 : next === 'u' ? 4 : 8;
      let digits = '';
      while (digits.length < size && /[0-9A-Fa-f]/.test(line[i + 2 + digits.length] ?? '')) {
        digits += line[i + 2 + digits.length];
      }
      value += digits ? String.fromCodePoint(Number.parseInt(digits, 16)) : `\\${next}`;
      i += 1 + digits.length;
      continue;
    }
    if (/[0-7]/.test(next)) {
      let digits = '';
      while (digits.length < 3 && /[0-7]/.test(line[i + 1 + digits.length] ?? '')) {
        digits += line[i + 1 + digits.length];
      }
      value += String.fromCharCode(Number.parseInt(digits, 8));
      i += digits.length;
      continue;
    }
    if (next === 'c') {
      value += String.fromCharCode((line.charCodeAt(i + 2) || 0) & 31);
      i += 2;
      continue;
    }
    value += `\\${next}`;
    i++;
  }
  return { value, end: -1 };
}

function lex(line: string): Lexed {
  const tokens: Token[] = [];
  const nested: string[] = [];
  let unfinished = false;
  let i = 0;

  let word: Word | undefined;
  const start = (): Word => (word ??= { value: '', expands: false, quoted: false, globbed: false });
  let braceAt: number | undefined;
  let bracketAt: number | undefined;

  /** The command lines inside `text`: `$(...)` and backticks, also inside `${...}` and `$((...))` */
  const collect = (text: string, depth = 0): void => {
    if (depth > 8) return;
    for (let at = 0; at < text.length; at++) {
      const char = text[at];
      if (char === '\\') {
        at++;
        continue;
      }
      if (char === "'") {
        const end = text.indexOf("'", at + 1);
        if (end === -1) return;
        at = end;
        continue;
      }
      if (char === '`') {
        let end = at + 1;
        while (end < text.length && text[end] !== '`') end += text[end] === '\\' ? 2 : 1;
        nested.push(text.slice(at + 1, end));
        at = end;
        continue;
      }
      if (char === '$' && (text[at + 1] === '(' || text[at + 1] === '{' || text[at + 1] === '[')) {
        const open = text[at + 1];
        const end = open === '(' ? closingParen(text, at + 1) : closingBracket(text, at + 1);
        if (end === -1) {
          unfinished = true;
          return;
        }
        const inner = text.slice(at + 2, end);
        if (open === '(' && !inner.startsWith('(')) nested.push(inner);
        else collect(inner, depth + 1);
        at = end;
      }
    }
  };
  const flush = () => {
    if (word) tokens.push({ type: 'word', word });
    word = undefined;
    braceAt = undefined;
    bracketAt = undefined;
  };

  /** Reads a `$`-expansion at `i`, adding to `current`. Returns the index after it */
  const expansion = (current: Word, at: number, quoted = false): number => {
    const next = line[at + 1];
    if (!quoted && next === "'") {
      const { value, end } = ansiC(line, at + 2);
      if (end === -1) {
        unfinished = true;
        return line.length;
      }
      current.value += value;
      current.quoted = true;
      return end + 1;
    }
    if (!quoted && next === '"') return at + 1;
    current.expands = true;
    if (next === '(' || next === '{' || next === '[') {
      const end = next === '(' ? closingParen(line, at + 1) : closingBracket(line, at + 1);
      if (end === -1) {
        unfinished = true;
        return line.length;
      }
      collect(line.slice(at, end + 1));
      current.value += line.slice(at, end + 1);
      return end + 1;
    }
    current.value += '$';
    return at + 1;
  };

  const backtick = (current: Word, at: number): number => {
    let end = at + 1;
    while (end < line.length && line[end] !== '`') end += line[end] === '\\' ? 2 : 1;
    if (end >= line.length) {
      unfinished = true;
      return line.length;
    }
    current.expands = true;
    nested.push(line.slice(at + 1, end));
    current.value += line.slice(at, end + 1);
    return end + 1;
  };

  /** Reads one word at `i` (a redirection's target), returning it and the index after it */
  const readTarget = (from: number): { target: Word | undefined; end: number } => {
    let at = from;
    while (at < line.length && (line[at] === ' ' || line[at] === '\t')) at++;
    const saved = word;
    word = undefined;
    const end = readWord(at);
    const target = word;
    word = saved;
    return { target, end };
  };

  /** Reads word characters from `from` into `word`, stopping at a blank, operator or paren */
  const readWord = (from: number): number => {
    let at = from;
    while (at < line.length) {
      const char = line[at];
      if (char === '\\') {
        if (line[at + 1] === '\n') {
          at += 2;
          continue;
        }
        if (at + 1 >= line.length) {
          unfinished = true;
          at++;
          continue;
        }
        const current = start();
        current.value += line[at + 1];
        current.quoted = true;
        at += 2;
        continue;
      }
      if (char === "'") {
        const end = line.indexOf("'", at + 1);
        const current = start();
        current.quoted = true;
        if (end === -1) {
          unfinished = true;
          current.value += line.slice(at + 1);
          return line.length;
        }
        current.value += line.slice(at + 1, end);
        at = end + 1;
        continue;
      }
      if (char === '"') {
        const current = start();
        current.quoted = true;
        at++;
        let closed = false;
        while (at < line.length) {
          const inner = line[at];
          if (inner === '"') {
            closed = true;
            at++;
            break;
          }
          if (inner === '\\' && at + 1 < line.length) {
            const escaped = line[at + 1];
            if (escaped === '\n') {
              at += 2;
              continue;
            }
            current.value += '$`"\\'.includes(escaped) ? escaped : `\\${escaped}`;
            at += 2;
            continue;
          }
          if (inner === '$') {
            at = expansion(current, at, true);
            continue;
          }
          if (inner === '`') {
            at = backtick(current, at);
            continue;
          }
          current.value += inner;
          at++;
        }
        if (!closed) unfinished = true;
        continue;
      }
      if (char === '$') {
        at = expansion(start(), at);
        continue;
      }
      if (char === '`') {
        at = backtick(start(), at);
        continue;
      }
      if ((char === '<' || char === '>') && line[at + 1] === '(') {
        const end = closingParen(line, at + 1);
        const current = start();
        current.expands = true;
        if (end === -1) {
          unfinished = true;
          return line.length;
        }
        nested.push(line.slice(at + 2, end));
        current.value += line.slice(at, end + 1);
        at = end + 1;
        continue;
      }
      if (
        char === ' ' ||
        char === '\t' ||
        char === '\n' ||
        char === ';' ||
        char === '&' ||
        char === '|' ||
        char === '(' ||
        char === ')' ||
        char === '<' ||
        char === '>'
      ) {
        return at;
      }
      const current = start();
      if (char === '*' || char === '?') current.globbed = true;
      if (char === '[') bracketAt = current.value.length;
      if (char === ']' && bracketAt !== undefined) current.globbed = true;
      if (char === '{') braceAt = current.value.length;
      if (char === '}' && braceAt !== undefined) {
        const inside = current.value.slice(braceAt + 1);
        if (inside.includes(',') || inside.includes('..')) current.globbed = true;
      }
      current.value += char;
      at++;
    }
    return at;
  };

  while (i < line.length) {
    const char = line[i];
    if (char === ' ' || char === '\t') {
      flush();
      i++;
      continue;
    }
    if (char === '\\' && line[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (char === '#' && word === undefined) {
      const end = line.indexOf('\n', i);
      i = end === -1 ? line.length : end;
      continue;
    }
    const isFd = word !== undefined && !word.quoted && !word.expands && /^\d+$/.test(word.value);
    if ((char === '<' || char === '>') && line[i + 1] !== '(') {
      const fd = isFd ? word : undefined;
      if (fd) word = undefined;
      else flush();
      let op = char;
      const next = (text: string) => line.startsWith(text, i + 1);
      if (char === '>') {
        if (next('>')) op = '>>';
        else if (next('|')) op = '>|';
        else if (next('&')) op = '>&';
      } else if (next('<<')) op = '<<<';
      else if (next('<-')) op = '<<-';
      else if (next('<')) op = '<<';
      else if (next('>')) op = '<>';
      else if (next('&')) op = '<&';
      const { target, end } = readTarget(i + op.length);
      i = end;
      if (!target) {
        unfinished = true;
        continue;
      }
      const heredoc = op === '<<' || op === '<<-';
      const duplicate = (op === '>&' || op === '<&') && /^(\d+|-)$/.test(target.value);
      const writes = !heredoc && op !== '<<<' && !duplicate && (op.startsWith('>') || op === '<>');
      const reads = op === '<' || op === '<>';
      tokens.push({
        type: 'redirect',
        heredoc,
        redirect: {
          op,
          target: target.value,
          writes: writes || (target.expands && op.startsWith('>') && !duplicate),
          reads,
        },
      });
      continue;
    }
    if (char === '&' && line[i + 1] === '>') {
      flush();
      const op = line[i + 2] === '>' ? '&>>' : '&>';
      const { target, end } = readTarget(i + op.length);
      i = end;
      if (!target) {
        unfinished = true;
        continue;
      }
      tokens.push({
        type: 'redirect',
        heredoc: false,
        redirect: { op, target: target.value, writes: true, reads: false },
      });
      continue;
    }
    const operator = OPERATORS.find((candidate) => line.startsWith(candidate, i));
    if (operator) {
      flush();
      tokens.push({ type: 'op', op: operator });
      i += operator.length;
      continue;
    }
    if (char === '(' || char === ')') {
      flush();
      tokens.push({ type: 'paren', open: char === '(' });
      i++;
      continue;
    }
    i = readWord(i);
  }
  flush();
  return { tokens, nested, unfinished };
}

const KEYWORDS = new Set([
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
  'select',
  'function',
  'in',
  'coproc',
  '{',
  '}',
  '!',
  '[[',
  ']]',
]);

/** Programs that run code an allow rule cannot see: never understood */
const RUNS_OTHER_CODE = new Set([
  'eval',
  'exec',
  'source',
  '.',
  'sudo',
  'doas',
  'su',
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'csh',
  'tcsh',
  'watch',
  'setsid',
  'ionice',
  'flock',
  'chroot',
  'nsenter',
  'unshare',
  'runuser',
  'strace',
  'ltrace',
  'script',
  'parallel',
  'trap',
  'alias',
  'nohup',
  'xargs',
  'busybox',
  'toybox',
  'command',
  'builtin',
]);

const FIND_ACTIONS = new Set([
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
  '-files0-from',
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** `git` options that come before its subcommand, and whether they take a value */
const GIT_GLOBAL_OPTIONS: Record<string, boolean> = {
  '-C': true,
  '-c': true,
  '--git-dir': true,
  '--work-tree': true,
  '--namespace': true,
  '--exec-path': false,
  '--super-prefix': true,
  '--config-env': true,
  '--list-cmds': true,
  '--attr-source': true,
  '-p': false,
  '-P': false,
  '--paginate': false,
  '--no-pager': false,
  '--bare': false,
  '--no-replace-objects': false,
  '--no-lazy-fetch': false,
  '--no-optional-locks': false,
  '--no-advice': false,
  '--literal-pathspecs': false,
  '--glob-pathspecs': false,
  '--noglob-pathspecs': false,
  '--icase-pathspecs': false,
};

/** `argv` without the global options of `git`, or undefined when it is not `git` or has none */
function withoutGitOptions(argv: readonly string[]): string[] | undefined {
  if (basename(argv[0] ?? '') !== 'git') return undefined;
  let i = 1;
  while (i < argv.length && argv[i].startsWith('-')) {
    const option = argv[i];
    const name = option.includes('=') ? option.slice(0, option.indexOf('=')) : option;
    const takesValue = GIT_GLOBAL_OPTIONS[name];
    if (takesValue === undefined) {
      if (/^-c./.test(option) || /^-C./.test(option)) {
        i++;
        continue;
      }
      break;
    }
    i += takesValue && !option.includes('=') ? 2 : 1;
  }
  return i === 1 ? undefined : ['git', ...argv.slice(i)];
}

/**
 * Takes the known wrappers off the front of `argv` with their exact options. Undefined when a
 * wrapper has an option it does not know, so the command is not understood
 */
function safeUnwrap(argv: string[]): string[] | undefined {
  let rest = argv;
  for (;;) {
    const head = rest[0];
    if (head === 'timeout') {
      let i = 1;
      while (rest[i]?.startsWith('-')) {
        const option = rest[i];
        if (['--preserve-status', '--foreground', '-v', '--verbose'].includes(option)) i++;
        else if (option === '-s' || option === '-k') i += 2;
        else if (/^--(signal|kill-after)=/.test(option) || /^-[sk]./.test(option)) i++;
        else return undefined;
      }
      if (rest[i] === undefined || !/^\d+(\.\d+)?[smhd]?$/.test(rest[i])) return undefined;
      rest = rest.slice(i + 1);
      continue;
    }
    if (head === 'time') {
      rest = rest.slice(rest[1] === '-p' ? 2 : 1);
      if (rest[0]?.startsWith('-')) return undefined;
      continue;
    }
    if (head === 'nice') {
      let i = 1;
      if (rest[i] === '-n') i += 2;
      else if (/^-n?-?\d+$/.test(rest[i] ?? '') || /^--adjustment=-?\d+$/.test(rest[i] ?? '')) i++;
      if (rest[i]?.startsWith('-')) return undefined;
      rest = rest.slice(i);
      continue;
    }
    if (head === 'stdbuf') {
      let i = 1;
      while (rest[i]?.startsWith('-')) {
        const option = rest[i];
        if (/^-[ioe]$/.test(option)) i += 2;
        else if (/^-[ioe]\S+$/.test(option) || /^--(input|output|error)=\S+$/.test(option)) i++;
        else return undefined;
      }
      rest = rest.slice(i);
      continue;
    }
    if (head === 'noglob') {
      rest = rest.slice(1);
      continue;
    }
    return rest;
  }
}

/** Option values of wrappers that `looseUnwrap` skips, by wrapper */
const WRAPPER_VALUE_OPTIONS: Record<string, readonly string[]> = {
  sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T', '-R'],
  doas: ['-u', '-C'],
  env: ['-u', '-C', '-S', '--unset', '--chdir', '--split-string'],
  nice: ['-n'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  stdbuf: ['-i', '-o', '-e'],
  xargs: [
    '-a',
    '-d',
    '-E',
    '-I',
    '-L',
    '-n',
    '-P',
    '-s',
    '--arg-file',
    '--delimiter',
    '--max-args',
    '--max-procs',
  ],
  watch: ['-n', '-d', '--interval'],
  ionice: ['-c', '-n', '-p'],
  flock: ['-w', '-E', '--timeout', '--conflict-exit-code'],
  exec: ['-a'],
  strace: ['-e', '-o', '-p', '-s', '-u'],
  ltrace: ['-e', '-o', '-p', '-s', '-u'],
  runuser: ['-u', '-g', '-G'],
  su: ['-c', '-s', '-g', '-G'],
};

const LOOSE_WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'command',
  'builtin',
  'exec',
  'nohup',
  'time',
  'nice',
  'timeout',
  'stdbuf',
  'xargs',
  'watch',
  'setsid',
  'ionice',
  'flock',
  'noglob',
  'strace',
  'ltrace',
  'runuser',
  'busybox',
  'toybox',
]);

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh']);

/**
 * Every command `argv` may run with its wrappers taken off loosely, for `deny` and `ask`
 * rules: options skipped, a wrapper's value options with their values, `env` assignments,
 * the duration of `timeout` and the file of `flock`. Command lines it runs as text (`sh -c`,
 * `eval`, `su -c`) are in `lines`
 */
function looseUnwrap(argv: readonly string[]): { variants: string[][]; lines: string[] } {
  const variants: string[][] = [];
  const lines: string[] = [];
  let rest = [...argv];
  for (let guard = 0; guard < 16 && rest.length > 0; guard++) {
    variants.push(rest);
    const program = basename(rest[0]);
    if (program !== rest[0]) variants.push([program, ...rest.slice(1)]);
    if (program === 'eval') {
      lines.push(rest.slice(1).join(' '));
      break;
    }
    if (SHELLS.has(program) || program === 'su') {
      const script = rest.findIndex((word, index) => index > 0 && isScriptFlag(word));
      let at = script + 1;
      while (rest[at] === '--') at++;
      if (script !== -1 && rest[at] !== undefined) lines.push(rest[at]);
      break;
    }
    if (program === 'git') {
      for (let at = 1; at < rest.length - 1; at++) {
        if (rest[at] !== '-c') continue;
        const setting = rest[at + 1];
        const bang = setting.indexOf('=!');
        if (setting.startsWith('alias.') && bang !== -1) lines.push(setting.slice(bang + 2));
      }
    }
    if (program === 'env') {
      for (let at = 1; at < rest.length; at++) {
        const word = rest[at];
        if ((word === '-S' || word === '--split-string') && rest[at + 1] !== undefined) {
          lines.push(rest.slice(at + 1).join(' '));
        } else if (word.startsWith('--split-string=')) {
          lines.push([word.slice('--split-string='.length), ...rest.slice(at + 1)].join(' '));
        } else if (word.startsWith('-S') && word.length > 2) {
          lines.push([word.slice(2), ...rest.slice(at + 1)].join(' '));
        }
      }
    }
    if (program === 'find') {
      const action = rest.findIndex(
        (word) => word === '-exec' || word === '-execdir' || word === '-ok' || word === '-okdir'
      );
      if (action !== -1) {
        const end = rest.findIndex(
          (word, index) => index > action && (word === ';' || word === '+')
        );
        const inner = rest.slice(action + 1, end === -1 ? undefined : end);
        if (inner.length > 0) rest = inner;
        else break;
        continue;
      }
      break;
    }
    if (!LOOSE_WRAPPERS.has(program)) break;
    const valued = WRAPPER_VALUE_OPTIONS[program] ?? [];
    let i = 1;
    while (i < rest.length) {
      const word = rest[i];
      if (word === '--') {
        i++;
        break;
      }
      if (word.startsWith('-') && word !== '-') {
        const name = word.includes('=') ? word.slice(0, word.indexOf('=')) : word;
        i += valued.includes(name) && !word.includes('=') ? 2 : 1;
        continue;
      }
      if ((program === 'env' || program === 'sudo') && ASSIGNMENT.test(word)) {
        i++;
        continue;
      }
      break;
    }
    if (program === 'timeout' && rest[i] !== undefined) i++;
    if (program === 'flock' && rest[i] !== undefined) i++;
    if (program === 'watch' && rest.length === i + 1) {
      lines.push(rest[i]);
      break;
    }
    rest = rest.slice(i);
  }
  return { variants, lines };
}

/** A shell option that takes a script, such as `-c`, `-lc`, `-ce` */
function isScriptFlag(word: string): boolean {
  if (word.length < 2 || !word.startsWith('-') || word.startsWith('--')) return false;
  let script = false;
  for (let at = 1; at < word.length; at++) {
    const char = word[at];
    if (char === 'c') script = true;
    else if (char < 'a' || char > 'z') return false;
  }
  return script;
}

/** Interpreters, and the options that hand them program text on the command line */
const INTERPRETERS: Record<string, readonly string[]> = {
  python: ['-c'],
  python2: ['-c'],
  python3: ['-c'],
  pypy: ['-c'],
  pypy3: ['-c'],
  node: ['-e', '-p', '--eval', '--print'],
  nodejs: ['-e', '-p', '--eval', '--print'],
  deno: ['eval'],
  bun: ['-e', '--eval', '-p', '--print'],
  perl: ['-e', '-E'],
  ruby: ['-e'],
  php: ['-r'],
  lua: ['-e'],
  luajit: ['-e'],
  tclsh: [],
  osascript: ['-e'],
  Rscript: ['-e'],
  R: ['-e'],
  julia: ['-e', '--eval'],
};

/**
 * Whether `argv` runs program text an allow rule cannot judge: an interpreter given code on the
 * command line (`python3 -c`, `node -e`, `perl -e`, `deno eval`...) or reading it from stdin (no
 * script operand), or `awk` and its kin, whose program is their first operand
 */
export function runsInlineCode(argv: readonly string[]): boolean {
  const program = basename(argv[0] ?? '');
  if (program === 'awk' || program === 'gawk' || program === 'mawk' || program === 'nawk')
    return true;
  const flags = INTERPRETERS[program] ?? INTERPRETERS[withoutVersion(program)];
  if (!flags) return false;
  const operands = argv.slice(1).filter((word) => !word.startsWith('-'));
  if (operands.length === 0 || operands[0] === '-') return true;
  return argv
    .slice(1)
    .some((word) =>
      flags.some((flag) =>
        flag.startsWith('--')
          ? word === flag || word.startsWith(`${flag}=`)
          : flag.startsWith('-')
            ? word === flag ||
              (word.startsWith('-') && !word.startsWith('--') && word.includes(flag[1]))
            : word === flag
      )
    );
}

/** `python3.12` as `python`: the name without the digits and dots at its end */
function withoutVersion(program: string): string {
  let end = program.length;
  while (end > 0 && /[\d.]/.test(program[end - 1])) end--;
  return program.slice(0, end);
}

/** Whether the file system compares names without case, so `TOUCH` runs `touch` */
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

function command(
  argv: string[],
  assigned: string[],
  redirects: ShellRedirect[],
  understood: boolean,
  dir: string | undefined
): ShellCommand {
  return {
    argv,
    text: argv.join(' '),
    assigned,
    redirects,
    understood,
    ...(dir !== undefined && { dir }),
  };
}

/** `command` run from `base`, relative to the line it is nested in */
function placed(child: ShellCommand, base: string | undefined): ShellCommand {
  const { dir: own, ...rest } = child;
  if (base === undefined || own === undefined) return rest;
  return { ...rest, dir: posix.join(base, own) };
}

/** Commands that change the directory the commands after them run in */
const MOVERS = new Set(['cd', 'pushd', 'popd', 'chdir']);

const MAX_DEPTH = 8;

/**
 * Takes a command line apart the way Claude Code's permission rules read it: tokenized with
 * quotes, escapes and line continuations, split at `&&`, `||`, `;`, `|`, `|&`, `&` and newlines,
 * each command as its argument vector. See {@link ParsedCommandLine}
 */
export function parseCommandLine(line: string, depth = 0): ParsedCommandLine {
  const { tokens, nested, unfinished } = lex(line);
  const commands: ShellCommand[] = [];
  const candidates: ShellCommand[] = [];
  let certain = !unfinished && nested.length === 0;
  if (tokens.length > 0 && tokens[tokens.length - 1].type === 'op') {
    const last = tokens[tokens.length - 1];
    if (last.type === 'op' && ['&&', '||', '|', '|&'].includes(last.op)) certain = false;
  }

  let words: Word[] = [];
  let redirects: ShellRedirect[] = [];
  let plain = true;
  let dir: string | undefined = '.';
  const close = () => {
    if (words.length === 0 && redirects.length === 0) {
      plain = true;
      return;
    }
    let understood = plain && dir !== undefined;
    let rest = words;
    const keyworded = rest.length > 0 && KEYWORDS.has(rest[0].value) && !rest[0].quoted;
    if (keyworded) understood = false;
    while (rest.length > 0 && KEYWORDS.has(rest[0].value) && !rest[0].quoted) rest = rest.slice(1);
    const assigned: string[] = [];
    while (rest.length > 0 && !rest[0].quoted && ASSIGNMENT.test(rest[0].value)) {
      assigned.push(rest[0].value.slice(0, rest[0].value.indexOf('=')));
      if (rest[0].expands) understood = false;
      rest = rest.slice(1);
    }
    if (rest.some((word) => word.expands || word.globbed)) understood = false;
    let argv = rest.map((word) => word.value);
    if (argv[0] === 'env') {
      let i = 1;
      while (argv[i] !== undefined && ASSIGNMENT.test(argv[i])) {
        assigned.push(argv[i].slice(0, argv[i].indexOf('=')));
        i++;
      }
      if (argv[i]?.startsWith('-') || argv[i] === undefined) understood = false;
      argv = argv.slice(i);
    }
    let effective = argv;
    if (understood) {
      const unwrapped = safeUnwrap(argv);
      if (!unwrapped || unwrapped.length === 0) understood = false;
      else effective = unwrapped;
    }
    const program = effective[0] ?? '';
    if (RUNS_OTHER_CODE.has(basename(program)) || runsInlineCode(effective)) understood = false;
    if (basename(program) === 'git' && effective[1]?.startsWith('-')) {
      if (!['--version', '--help'].includes(effective[1])) understood = false;
    }
    if (basename(program) === 'find' && effective.some((word) => FIND_ACTIONS.has(word))) {
      understood = false;
    }
    if (!understood) certain = false;
    const here = dir;
    const own = command(
      effective.length > 0 ? effective : argv,
      assigned,
      redirects,
      understood,
      here
    );
    commands.push(own);
    if (argv.length === 0) candidates.push(own);
    const seen = new Set<string>();
    const add = (variant: string[]) => {
      const key = variant.join('\u0000');
      if (seen.has(key) || variant.length === 0) return;
      seen.add(key);
      candidates.push(command(variant, assigned, redirects, understood, here));
      const git = withoutGitOptions(variant);
      if (git) add(git);
    };
    add(argv);
    add(effective);
    const loose = looseUnwrap(argv);
    for (const variant of loose.variants) {
      add(variant);
      const name = basename(variant[0] ?? '');
      if (CASE_INSENSITIVE && name.toLowerCase() !== name) {
        add([name.toLowerCase(), ...variant.slice(1)]);
      }
    }
    const runner = basename(argv[0] ?? '');
    if (SHELLS.has(runner) || INTERPRETERS[runner] !== undefined) {
      for (const redirect of redirects) {
        if (redirect.op === '<<<') loose.lines.push(redirect.target);
      }
    }
    if (depth < MAX_DEPTH) {
      for (const inner of loose.lines) {
        candidates.push(
          ...parseCommandLine(inner, depth + 1).candidates.map((entry) => placed(entry, here))
        );
      }
    }
    if (loose.variants.some((variant) => MOVERS.has(basename(variant[0] ?? '')))) dir = undefined;
    words = [];
    redirects = [];
    plain = true;
  };

  for (const token of tokens) {
    if (token.type === 'word') words.push(token.word);
    else if (token.type === 'redirect') {
      redirects.push(token.redirect);
      if (token.heredoc) {
        plain = false;
        certain = false;
      }
      if (token.redirect.target.includes('$') || token.redirect.target.includes('`')) plain = false;
    } else if (token.type === 'paren') {
      close();
      certain = false;
      plain = false;
      dir = undefined;
    } else {
      close();
    }
  }
  close();

  if (depth < MAX_DEPTH) {
    const moved = commands.some((entry) => entry.dir !== '.');
    for (const inner of nested) {
      if (inner.trim() === '') continue;
      candidates.push(
        ...parseCommandLine(inner, depth + 1).candidates.map((entry) =>
          placed(entry, moved ? undefined : '.')
        )
      );
    }
  }
  return { commands, candidates, certain: certain && commands.every((entry) => entry.understood) };
}

const SAFE_VARIABLES = new Set([
  'NODE_ENV',
  'CI',
  'DEBUG',
  'FORCE_COLOR',
  'NO_COLOR',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'PYTHONUNBUFFERED',
  'PYTHONDONTWRITEBYTECODE',
  'RUST_BACKTRACE',
  'RUST_LOG',
  'COLUMNS',
  'LINES',
]);

/** Whether an environment variable is one an allow rule may run a command with */
export function isSafeVariable(name: string): boolean {
  return SAFE_VARIABLES.has(name);
}

/** Whether `command` assigns only variables known to be safe before it runs */
export function assignsOnlySafeVariables(command: ShellCommand): boolean {
  return command.assigned.every(isSafeVariable);
}

/**
 * Whether the text of a command (`argv` joined) matches the command pattern of a rule: `*` stands
 * for any text, spaces included, a trailing ` *` (or `:*`) that is the only wildcard also matches
 * the command without anything after it. The pattern is read as words, as the shell would read it,
 * so `Bash(git "push" *)` is `git push *`
 */
export function matchesCommandPattern(command: string, pattern: string): boolean {
  let spec = pattern.trim();
  if (spec.endsWith(':*')) spec = `${spec.slice(0, -2)} *`;
  spec = spec.replace(/\s+/g, ' ');
  if (spec === '*' || spec === '') return true;
  const wildcards = spec.split('*').length - 1;
  if (wildcards === 1 && spec.endsWith(' *') && command === spec.slice(0, -2)) return true;
  return wildcardMatch(command, spec);
}

/** Programs that read the directories they name with everything inside */
const RECURSIVE_READERS = new Set(['rg', 'ag', 'ack', 'tar', 'bsdtar', 'rsync', 'scp']);

/** Programs that read directories recursively with `-r`, `-R` or `--recursive` */
const RECURSIVE_WITH_FLAG = new Set([
  'grep',
  'egrep',
  'fgrep',
  'cp',
  'zip',
  'ls',
  'chmod',
  'chown',
  'diff',
]);

/** Programs whose first operand is a pattern rather than a file */
const PATTERN_FIRST = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);

/** Programs that change the files they name */
const EDITORS = new Set([
  'tee',
  'touch',
  'mkdir',
  'rm',
  'rmdir',
  'truncate',
  'chmod',
  'chown',
  'shred',
  'unlink',
]);

function operandsOf(argv: readonly string[]): string[] {
  const operands: string[] = [];
  let options = true;
  for (const word of argv.slice(1)) {
    if (options && word === '--') {
      options = false;
      continue;
    }
    if (options && word.startsWith('-') && word !== '-') continue;
    operands.push(word);
  }
  return operands;
}

/** The paths a word may name: itself, what follows `=` (`if=x`, `--file=x`) and `:` (`HEAD:x`) */
function pathsIn(word: string): string[] {
  const paths = [word];
  const equals = word.indexOf('=');
  if (equals !== -1 && equals < word.length - 1) paths.push(word.slice(equals + 1));
  const colon = word.indexOf(':');
  if (colon !== -1 && colon < word.length - 1 && !word.includes('://')) {
    paths.push(word.slice(colon + 1));
  }
  return paths;
}

/**
 * The files a command may read, the directories it may read through, and the files it changes,
 * best effort: every word after the program counts as a file it may read (with what follows `=`
 * or `:` in it), whatever the program, the operands of recursive readers (`grep -r`, `rg`, `tar`,
 * `cp -r`...) as directories, and the targets of `cp`, `mv`, `install` and `ln`, the operands of
 * `tee`, `touch`, `rm`, `sed -i`... and output redirections as changed files
 */
export function filesOf(command: ShellCommand): {
  reads: string[];
  readsInto: string[];
  writes: string[];
  writesInto: string[];
} {
  const reads: string[] = [];
  const readsInto: string[] = [];
  const writes: string[] = [];
  const writesInto: string[] = [];
  for (const redirect of command.redirects) {
    if (redirect.reads) reads.push(redirect.target);
    if (redirect.writes) writes.push(redirect.target);
  }
  const program = basename(command.argv[0] ?? '');
  const operands = operandsOf(command.argv);
  for (const word of command.argv.slice(1)) reads.push(...pathsIn(word));
  const recursive =
    RECURSIVE_READERS.has(program) ||
    (RECURSIVE_WITH_FLAG.has(program) &&
      command.argv.some(
        (word) =>
          word === '--recursive' ||
          word === '-a' ||
          (word.startsWith('-') && !word.startsWith('--') && /[rR]/.test(word))
      ));
  if (recursive) {
    const searched =
      PATTERN_FIRST.has(program) && !command.argv.includes('-e') ? operands.slice(1) : operands;
    readsInto.push(...(searched.length > 0 ? searched : ['.']));
  }
  if (
    (program === 'sed' || program === 'gsed' || program === 'perl') &&
    command.argv.some((word) => word.startsWith('-i') || word === '--in-place')
  ) {
    writes.push(...operands.slice(1));
  }
  if (['cp', 'mv', 'install', 'ln', 'rsync', 'scp'].includes(program)) {
    const target = command.argv.findIndex((word) => word === '-t' || word === '--target-directory');
    const attached = command.argv.find(
      (word) =>
        (word.startsWith('-t') && word.length > 2 && !word.startsWith('--')) ||
        word.startsWith('--target-directory=')
    );
    const dir =
      target !== -1 || attached
        ? attached
          ? attached.startsWith('--')
            ? attached.slice(attached.indexOf('=') + 1)
            : attached.slice(2)
          : command.argv[target + 1]
        : operands[operands.length - 1];
    const sources =
      target !== -1 || attached
        ? operands.filter((operand) => operand !== dir)
        : operands.slice(0, -1);
    if (dir) {
      writes.push(dir);
      for (const source of sources) writes.push(posix.join(dir, posix.basename(source)));
      const whole =
        program === 'mv' ||
        program === 'rsync' ||
        command.argv.some(
          (word) =>
            word === '--recursive' ||
            word === '--archive' ||
            (word.startsWith('-') && !word.startsWith('--') && /[rRa]/.test(word))
        );
      if (whole) {
        writesInto.push(dir, ...sources.map((source) => posix.join(dir, posix.basename(source))));
      }
    }
    if (program === 'mv') writes.push(...sources);
  } else if (EDITORS.has(program)) {
    writes.push(...(program === 'chmod' || program === 'chown' ? operands.slice(1) : operands));
  }
  return { reads, readsInto, writes, writesInto };
}

/** The options of the commands `acceptEdits` runs, and which of them take a path or a value */
const EDIT_COMMAND_OPTIONS: Record<
  string,
  { flags: string; long: readonly string[]; valued: Record<string, 'path' | 'value'> }
> = {
  mkdir: {
    flags: 'pv',
    long: ['--parents', '--verbose'],
    valued: { '-m': 'value', '--mode': 'value' },
  },
  touch: {
    flags: 'acmh',
    long: ['--no-create', '--no-dereference'],
    valued: {
      '-d': 'value',
      '-t': 'value',
      '-r': 'path',
      '--date': 'value',
      '--reference': 'path',
    },
  },
  mv: {
    flags: 'finvuT',
    long: [
      '--force',
      '--interactive',
      '--no-clobber',
      '--verbose',
      '--update',
      '--no-target-directory',
    ],
    valued: { '-t': 'path', '--target-directory': 'path', '-S': 'value', '--suffix': 'value' },
  },
  cp: {
    flags: 'finvuTrRpaPLHlsx',
    long: [
      '--force',
      '--interactive',
      '--no-clobber',
      '--verbose',
      '--update',
      '--recursive',
      '--archive',
      '--no-target-directory',
      '--preserve',
    ],
    valued: { '-t': 'path', '--target-directory': 'path', '-S': 'value', '--suffix': 'value' },
  },
};

/**
 * The paths a `mkdir`, `touch`, `mv` or `cp` command touches, its options read exactly.
 * Undefined for another program, or an option the reading does not know
 */
export function editCommandPaths(command: ShellCommand): string[] | undefined {
  const program = command.argv[0] ?? '';
  const spec = EDIT_COMMAND_OPTIONS[program];
  if (!spec) return undefined;
  const paths: string[] = [];
  const args = command.argv.slice(1);
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (options && word === '--') {
      options = false;
      continue;
    }
    if (options && word.startsWith('--')) {
      const name = word.includes('=') ? word.slice(0, word.indexOf('=')) : word;
      const valued = spec.valued[name];
      if (valued) {
        const value = word.includes('=') ? word.slice(word.indexOf('=') + 1) : args[++i];
        if (value === undefined) return undefined;
        if (valued === 'path') paths.push(value);
        continue;
      }
      if (spec.long.includes(word)) continue;
      return undefined;
    }
    if (options && word.startsWith('-') && word.length > 1) {
      for (let at = 1; at < word.length; at++) {
        const flag = `-${word[at]}`;
        const valued = spec.valued[flag];
        if (valued) {
          const value = at + 1 < word.length ? word.slice(at + 1) : args[++i];
          if (value === undefined) return undefined;
          if (valued === 'path') paths.push(value);
          break;
        }
        if (!spec.flags.includes(word[at])) return undefined;
      }
      continue;
    }
    paths.push(word);
  }
  return paths;
}

/**
 * The commands `plan` mode runs, with the options each may take: short flags without a value,
 * short and long options with a value, long flags, and the most operands (`uniq in out` writes
 * `out`). Any other option makes the command not read-only
 */
interface ReadOnlySpec {
  flags?: string;
  valued?: readonly string[];
  long?: readonly string[];
  longValued?: readonly string[];
  maxOperands?: number;
  /** Any argument, the command reads nothing from them (`echo`, `pwd`) */
  anything?: boolean;
  /** Operands are allowed only with one of these flags (`git branch -l <pattern>` lists, `git branch <name>` creates) */
  operandsWith?: readonly string[];
}

const READ_ONLY: Record<string, ReadOnlySpec> = {
  ls: {
    flags: 'laAhRtSr1dFGiopsucUX',
    long: ['--all', '--almost-all', '--human-readable', '--recursive', '--color'],
    longValued: ['--color', '--sort', '--time-style'],
  },
  cat: { flags: 'nbsAvETeut', long: ['--number', '--show-all'] },
  head: { flags: 'qvz', valued: ['-n', '-c'], longValued: ['--lines', '--bytes'] },
  tail: { flags: 'qvzfF', valued: ['-n', '-c'], longValued: ['--lines', '--bytes'] },
  wc: { flags: 'lwcmL', long: ['--lines', '--words', '--chars', '--bytes'] },
  pwd: { flags: 'LP', maxOperands: 0 },
  echo: { anything: true },
  cd: { flags: 'LPe', maxOperands: 1 },
  printf: { anything: true },
  true: { anything: true },
  false: { anything: true },
  whoami: { maxOperands: 0 },
  date: {
    flags: 'uR',
    valued: ['-d', '-r'],
    long: ['--utc', '--rfc-3339'],
    longValued: ['--date', '--rfc-3339', '--iso-8601'],
    maxOperands: 1,
  },
  uname: { flags: 'asnrvmpio', maxOperands: 0 },
  grep: {
    flags: 'rRinvwlLcoqsEFGPhHxzZabIUT',
    valued: ['-e', '-f', '-A', '-B', '-C', '-m', '-d', '-D'],
    long: [
      '--recursive',
      '--ignore-case',
      '--invert-match',
      '--word-regexp',
      '--count',
      '--files-with-matches',
      '--line-number',
      '--color',
      '--no-messages',
      '--extended-regexp',
      '--fixed-strings',
    ],
    longValued: [
      '--include',
      '--exclude',
      '--exclude-dir',
      '--color',
      '--colour',
      '--max-count',
      '--context',
      '--after-context',
      '--before-context',
      '--regexp',
    ],
  },
  rg: {
    flags: 'iswlcnNvFHLuUS0',
    valued: ['-e', '-g', '-t', '-T', '-A', '-B', '-C', '-m', '-M'],
    long: [
      '--hidden',
      '--no-ignore',
      '--files',
      '--count',
      '--json',
      '--line-number',
      '--ignore-case',
      '--smart-case',
      '--word-regexp',
      '--fixed-strings',
      '--files-with-matches',
      '--no-heading',
      '--heading',
      '--follow',
    ],
    longValued: [
      '--glob',
      '--type',
      '--type-not',
      '--max-count',
      '--context',
      '--after-context',
      '--before-context',
      '--regexp',
      '--max-depth',
      '--color',
    ],
  },
  tree: { flags: 'adfiLlpshDCJ', valued: ['-L', '-I', '-P'] },
  file: { flags: 'bLhiN' },
  stat: { flags: 'Lft', valued: ['-c'], longValued: ['--format', '--printf'] },
  du: { flags: 'shacbkmLxH', valued: ['-d'], longValued: ['--max-depth'] },
  df: { flags: 'hHkiTlaP' },
  which: { flags: 'a' },
  basename: { flags: 'az', valued: ['-s'] },
  dirname: { flags: 'z' },
  realpath: { flags: 'eLPqsz', valued: [] },
  nl: { flags: 'bnpw', valued: ['-b', '-n', '-s', '-v', '-w'] },
  cut: {
    flags: 'nsz',
    valued: ['-d', '-f', '-c', '-b'],
    longValued: ['--delimiter', '--fields', '--characters', '--bytes'],
  },
  sort: {
    flags: 'rnufbdghiMRVsz',
    valued: ['-k', '-t'],
    longValued: ['--key', '--field-separator'],
  },
  uniq: { flags: 'cdiuzD', valued: ['-f', '-s', '-w'], maxOperands: 1 },
  diff: {
    flags: 'uqrNiwbBaEsy',
    valued: ['-U', '-C'],
    long: ['--brief', '--recursive', '--unified'],
    longValued: ['--unified', '--color'],
  },
  cmp: { flags: 'lsb', valued: ['-n', '-i'] },
};

const READ_ONLY_GIT: Record<string, ReadOnlySpec> = {
  status: {
    flags: 'sbuz',
    long: ['--short', '--branch', '--porcelain', '--long'],
    longValued: ['--porcelain', '--untracked-files'],
  },
  log: {
    flags: 'p',
    valued: ['-n'],
    long: [
      '--patch',
      '--no-ext-diff',
      '--no-textconv',
      '--oneline',
      '--graph',
      '--all',
      '--stat',
      '--decorate',
      '--reverse',
      '--name-only',
      '--name-status',
    ],
    longValued: [
      '--max-count',
      '--since',
      '--until',
      '--author',
      '--grep',
      '--format',
      '--pretty',
      '--decorate',
    ],
  },
  diff: {
    flags: 'pw',
    valued: ['-U'],
    long: [
      '--stat',
      '--cached',
      '--staged',
      '--name-only',
      '--name-status',
      '--no-ext-diff',
      '--no-textconv',
      '--color',
    ],
    longValued: ['--unified', '--color'],
  },
  show: {
    flags: 'p',
    long: ['--stat', '--oneline', '--name-only', '--no-ext-diff', '--no-textconv'],
    longValued: ['--format', '--pretty'],
  },
  blame: { flags: 'lsewp', valued: ['-L'] },
  'rev-parse': {
    long: ['--show-toplevel', '--abbrev-ref', '--git-dir', '--is-inside-work-tree', '--short'],
    longValued: ['--short'],
  },
  'ls-files': {
    flags: 'comdsz',
    long: ['--others', '--cached', '--modified', '--deleted', '--exclude-standard'],
  },
  shortlog: { flags: 'sne' },
  describe: {
    long: ['--tags', '--always', '--dirty', '--long'],
    longValued: ['--abbrev', '--match'],
  },
  branch: {
    flags: 'avrl',
    long: ['--list', '--all', '--remotes', '--show-current', '--verbose'],
    longValued: [
      '--contains',
      '--no-contains',
      '--merged',
      '--no-merged',
      '--format',
      '--sort',
      '--points-at',
    ],
    operandsWith: ['-l', '--list'],
  },
  tag: {
    flags: 'l',
    valued: ['-n'],
    long: ['--list'],
    longValued: [
      '--contains',
      '--no-contains',
      '--merged',
      '--no-merged',
      '--format',
      '--sort',
      '--points-at',
    ],
    operandsWith: ['-l', '--list'],
  },
  remote: { flags: 'v', long: ['--verbose'], maxOperands: 0 },
  'stash list': { flags: 'p', long: ['--stat'], longValued: ['--format', '--pretty'] },
  'worktree list': { long: ['--porcelain', '--verbose'], maxOperands: 0 },
};

/** Whether `args` only uses the options `spec` allows, with at most its operands */
function argsAllowed(args: readonly string[], spec: ReadOnlySpec): boolean {
  if (spec.anything) return true;
  let operands = 0;
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (options && word === '--') {
      options = false;
      continue;
    }
    if (options && word.startsWith('--')) {
      const equals = word.indexOf('=');
      const name = equals === -1 ? word : word.slice(0, equals);
      if (equals !== -1) {
        if (!spec.longValued?.includes(name)) return false;
        continue;
      }
      if (spec.long?.includes(name)) continue;
      if (spec.longValued?.includes(name) && i + 1 < args.length) {
        i++;
        continue;
      }
      return false;
    }
    if (options && word.startsWith('-') && word.length > 1) {
      if (/^-\d+$/.test(word) && (spec.valued?.includes('-n') ?? false)) continue;
      for (let at = 1; at < word.length; at++) {
        const flag = `-${word[at]}`;
        if (spec.valued?.includes(flag)) {
          if (at === word.length - 1) i++;
          break;
        }
        if (!spec.flags?.includes(word[at])) return false;
      }
      continue;
    }
    operands++;
  }
  if (operands > 0 && spec.operandsWith) {
    const listing = args.some(
      (word) =>
        spec.operandsWith?.includes(word) ||
        (word.startsWith('-') &&
          !word.startsWith('--') &&
          spec.operandsWith?.some((flag) => flag.length === 2 && word.includes(flag[1])))
    );
    if (!listing) return false;
  }
  return spec.maxOperands === undefined || operands <= spec.maxOperands;
}

/**
 * Whether `command` only reads: a known read-only program with options known to only read
 * (no `sort -o`, `rg --pre`, a second `uniq` operand), and no output redirection. `git` only in a
 * repository you trust (`trustRepository`): its config can run code (`diff.external`, textconv
 * and filter drivers, `core.fsmonitor`, hooks, a pager, aliases), and a command that shows a diff
 * only with `--no-ext-diff --no-textconv`
 */
export function isReadOnlyCommand(
  command: ShellCommand,
  options: { trustRepository?: boolean } = {}
): boolean {
  if (!command.understood || command.redirects.some((redirect) => redirect.writes)) return false;
  if (!assignsOnlySafeVariables(command)) return false;
  const program = command.argv[0] ?? '';
  if (program === 'git') {
    if (options.trustRepository !== true) return false;
    const sub = command.argv[1] ?? '';
    const args = command.argv.slice(2);
    const patches =
      sub === 'diff' ||
      sub === 'show' ||
      (sub === 'log' && args.some((word) => word === '-p' || word === '--patch' || word === '-u'));
    if (patches && !(args.includes('--no-ext-diff') && args.includes('--no-textconv'))) {
      return false;
    }
    if (sub === 'stash' || sub === 'worktree') {
      const spec = READ_ONLY_GIT[`${sub} ${command.argv[2] ?? ''}`];
      return spec !== undefined && argsAllowed(command.argv.slice(3), spec);
    }
    const spec = Object.hasOwn(READ_ONLY_GIT, sub) ? READ_ONLY_GIT[sub] : undefined;
    return spec !== undefined && argsAllowed(command.argv.slice(2), spec);
  }
  if (program === 'find') {
    return command.argv
      .slice(1)
      .every(
        (word) =>
          !word.startsWith('-') ||
          [
            '-name',
            '-iname',
            '-type',
            '-path',
            '-ipath',
            '-maxdepth',
            '-mindepth',
            '-size',
            '-mtime',
            '-newer',
            '-print',
            '-not',
            '-o',
            '-a',
            '-empty',
            '-L',
            '-H',
            '-P',
          ].includes(word)
      );
  }
  const spec = Object.hasOwn(READ_ONLY, program) ? READ_ONLY[program] : undefined;
  return spec !== undefined && argsAllowed(command.argv.slice(1), spec);
}
