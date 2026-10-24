/**
 * Reading a shell command line the way permission rules match it: tokenized as a POSIX shell does
 * (quotes, escapes, line continuations, redirections glued to words), split into the commands it
 * runs, each as its argument vector. Rules match the argument vector, never the raw text, and an
 * allow rule only matches a command the parser fully understands
 */

import { basename } from 'node:path';

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

function lex(line: string): Lexed {
  const tokens: Token[] = [];
  const nested: string[] = [];
  let unfinished = false;
  let i = 0;

  let word: Word | undefined;
  const start = (): Word => (word ??= { value: '', expands: false, quoted: false });
  const flush = () => {
    if (word) tokens.push({ type: 'word', word });
    word = undefined;
  };

  /** Reads a `$`-expansion at `i`, adding to `current`. Returns the index after it */
  const expansion = (current: Word, at: number): number => {
    const next = line[at + 1];
    current.expands = true;
    if (next === '(') {
      const end = closingParen(line, at + 1);
      if (end === -1) {
        unfinished = true;
        return line.length;
      }
      const inner = line.slice(at + 2, end);
      nested.push(inner.startsWith('(') && inner.endsWith(')') ? '' : inner);
      current.value += line.slice(at, end + 1);
      return end + 1;
    }
    if (next === '{') {
      const end = line.indexOf('}', at + 2);
      if (end === -1) {
        unfinished = true;
        return line.length;
      }
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
            at = expansion(current, at);
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
      start().value += char;
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
      const rest = line.slice(i + 1);
      if (char === '>') {
        if (rest.startsWith('>')) op = '>>';
        else if (rest.startsWith('|')) op = '>|';
        else if (rest.startsWith('&')) op = '>&';
      } else if (rest.startsWith('<<')) op = '<<<';
      else if (rest.startsWith('<-')) op = '<<-';
      else if (rest.startsWith('<')) op = '<<';
      else if (rest.startsWith('>')) op = '<>';
      else if (rest.startsWith('&')) op = '<&';
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
    if (head === 'command' || head === 'builtin' || head === 'noglob') {
      if (rest[1]?.startsWith('-')) return undefined;
      rest = rest.slice(1);
      continue;
    }
    if (head === 'xargs') {
      if (rest[1] === undefined || rest[1].startsWith('-')) return undefined;
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
      const script = rest.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(word));
      if (script !== -1 && rest[script + 1] !== undefined) lines.push(rest[script + 1]);
      break;
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

function command(
  argv: string[],
  assigned: string[],
  redirects: ShellRedirect[],
  understood: boolean
): ShellCommand {
  return { argv, text: argv.join(' '), assigned, redirects, understood };
}

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
  const close = () => {
    if (words.length === 0 && redirects.length === 0) {
      plain = true;
      return;
    }
    let understood = plain;
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
    if (rest.some((word) => word.expands)) understood = false;
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
    if (RUNS_OTHER_CODE.has(basename(program))) understood = false;
    if (basename(program) === 'git' && effective[1]?.startsWith('-')) {
      if (!['--version', '--help'].includes(effective[1])) understood = false;
    }
    if (basename(program) === 'find' && effective.some((word) => FIND_ACTIONS.has(word))) {
      understood = false;
    }
    if (!understood) certain = false;
    const own = command(effective.length > 0 ? effective : argv, assigned, redirects, understood);
    commands.push(own);
    const seen = new Set<string>();
    const add = (variant: string[]) => {
      const key = variant.join('\u0000');
      if (seen.has(key) || variant.length === 0) return;
      seen.add(key);
      candidates.push(command(variant, assigned, redirects, understood));
      const git = withoutGitOptions(variant);
      if (git) add(git);
    };
    add(argv);
    add(effective);
    const loose = looseUnwrap(argv);
    for (const variant of loose.variants) add(variant);
    if (depth < MAX_DEPTH) {
      for (const inner of loose.lines)
        candidates.push(...parseCommandLine(inner, depth + 1).candidates);
    }
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
    } else {
      close();
    }
  }
  close();

  if (depth < MAX_DEPTH) {
    for (const inner of nested) {
      if (inner.trim() !== '') candidates.push(...parseCommandLine(inner, depth + 1).candidates);
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
  const source = spec
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\S]*');
  return new RegExp(`^${source}$`).test(command);
}

/** Programs that read the files they name, for `Read(...)` deny and ask rules */
const READERS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'sed',
  'awk',
  'gawk',
  'cut',
  'sort',
  'uniq',
  'xxd',
  'od',
  'hexdump',
  'strings',
  'base64',
  'nl',
  'tac',
  'wc',
  'file',
  'diff',
  'cmp',
  'jq',
  'yq',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'shasum',
  'bat',
  'view',
  'vi',
  'vim',
  'nano',
  'source',
  '.',
]);

/** Programs whose first operand is a pattern or a script rather than a file */
const PATTERN_FIRST = new Set([
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'sed',
  'awk',
  'gawk',
  'jq',
  'yq',
]);

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

/**
 * The files a command reads and the files it changes, best effort as Claude Code reads them: the
 * operands of readers (`cat`, `grep`, `sed`...), the sources and the target of `cp`, `mv`,
 * `install` and `ln`, the operands of `tee`, `touch`, `rm`..., and the targets of redirections
 */
export function filesOf(command: ShellCommand): { reads: string[]; writes: string[] } {
  const reads: string[] = [];
  const writes: string[] = [];
  for (const redirect of command.redirects) {
    if (redirect.reads) reads.push(redirect.target);
    if (redirect.writes) writes.push(redirect.target);
  }
  const program = basename(command.argv[0] ?? '');
  const operands = operandsOf(command.argv);
  if (READERS.has(program)) {
    const files =
      PATTERN_FIRST.has(program) && !command.argv.some((word) => word === '-e' || word === '-f')
        ? operands.slice(1)
        : operands;
    reads.push(...files);
    if (
      program === 'sed' &&
      command.argv.some((word) => word.startsWith('-i') || word === '--in-place')
    ) {
      writes.push(...files);
    }
  } else if (['cp', 'mv', 'install', 'ln', 'rsync', 'scp'].includes(program)) {
    const target = command.argv.findIndex((word) => word === '-t' || word === '--target-directory');
    const attached = command.argv.find(
      (word) => /^-t./.test(word) || word.startsWith('--target-directory=')
    );
    if (target !== -1 || attached) {
      const dir = attached
        ? attached.startsWith('--')
          ? attached.slice(attached.indexOf('=') + 1)
          : attached.slice(2)
        : command.argv[target + 1];
      if (dir) writes.push(dir);
      reads.push(...operands.filter((operand) => operand !== dir));
    } else {
      reads.push(...operands.slice(0, -1));
      if (operands.length > 0) writes.push(operands[operands.length - 1]);
    }
    if (program === 'mv') writes.push(...operands.slice(0, -1));
  } else if (EDITORS.has(program)) {
    writes.push(...(program === 'chmod' || program === 'chown' ? operands.slice(1) : operands));
  }
  return { reads, writes };
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

/** Commands `plan` mode runs: they read and never change anything */
const READ_ONLY_COMMANDS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'pwd',
  'echo',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'tree',
  'file',
  'stat',
  'du',
  'df',
  'which',
  'whoami',
  'date',
  'uname',
  'diff',
  'cmp',
  'sort',
  'uniq',
  'cut',
  'nl',
  'basename',
  'dirname',
  'realpath',
  'true',
  'false',
]);

const READ_ONLY_GIT = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'rev-parse',
  'ls-files',
  'grep',
  'shortlog',
  'describe',
]);

/** Whether `command` only reads: a known read-only program, without output redirections */
export function isReadOnlyCommand(command: ShellCommand): boolean {
  if (!command.understood || command.redirects.some((redirect) => redirect.writes)) return false;
  const program = command.argv[0] ?? '';
  if (program === 'git') return READ_ONLY_GIT.has(command.argv[1] ?? '');
  if (program === 'find') return !command.argv.some((word) => FIND_ACTIONS.has(word));
  return READ_ONLY_COMMANDS.has(program);
}
