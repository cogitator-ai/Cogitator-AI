/**
 * Reading a command line for `excludedCommands`: a command line leaves the sandbox only when it
 * is a plain list of commands, each matched by an entry. Anything the reader does not fully
 * understand keeps the line sandboxed
 */

/** Programs a line with stays sandboxed: they run other commands or change where the next runs */
const KEEP_SANDBOXED = new Set([
  'cd',
  'pushd',
  'popd',
  'sudo',
  'doas',
  'eval',
  'exec',
  'xargs',
  'source',
  '.',
  'env',
  'command',
  'builtin',
  'nohup',
  'time',
  'timeout',
  'nice',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'select',
  'function',
  '!',
  '[[',
]);

/** Git subcommands that write a whole tree where their path argument points */
const GIT_TREE_WRITERS: ReadonlyArray<readonly string[]> = [
  ['clone'],
  ['init'],
  ['worktree', 'add'],
  ['worktree', 'move'],
  ['bundle', 'create'],
];

/**
 * The commands of a plain command line as word lists, quotes taken off. Undefined for a line with
 * a substitution, an expansion in a command name, a subshell or a group, a redirection other than
 * a descriptor copy (`2>&1`), a here-document, an assignment before a command, or an open quote
 */
export function plainCommands(line: string): string[][] | undefined {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let firstHasDollar = false;
  const endWord = () => {
    if (!inWord) return;
    words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length === 0) return;
    commands.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '\\') {
      const next = line[i + 1];
      if (next === undefined) return undefined;
      if (next === '\n') {
        i++;
        continue;
      }
      word += next;
      inWord = true;
      i++;
      continue;
    }
    if (char === "'") {
      const close = line.indexOf("'", i + 1);
      if (close === -1) return undefined;
      word += line.slice(i + 1, close);
      inWord = true;
      i = close;
      continue;
    }
    if (char === '"') {
      let j = i + 1;
      let text = '';
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === '$' || line[j] === '`') return undefined;
        if (line[j] === '\\' && j + 1 < line.length && '"\\$`\n'.includes(line[j + 1])) {
          if (line[j + 1] !== '\n') text += line[j + 1];
          j++;
          continue;
        }
        text += line[j];
      }
      if (j >= line.length) return undefined;
      word += text;
      inWord = true;
      i = j;
      continue;
    }
    if (char === '`' || char === '(' || char === ')' || char === '{' || char === '}') {
      return undefined;
    }
    if (char === '$') {
      if (words.length === 0) firstHasDollar = true;
      if (line[i + 1] === '(' || line[i + 1] === '{' || line[i + 1] === "'") return undefined;
      word += char;
      inWord = true;
      continue;
    }
    if (char === '>' || char === '<') {
      const dup = /^>&(\d+|-)(?=$|[\s;&|])/.exec(line.slice(i));
      if (char === '>' && dup && (!inWord || /^\d+$/.test(word))) {
        word = '';
        inWord = false;
        i += dup[0].length - 1;
        continue;
      }
      return undefined;
    }
    if (char === ' ' || char === '\t') {
      endWord();
      continue;
    }
    if (char === '\n' || char === ';') {
      endCommand();
      continue;
    }
    if (char === '&' || char === '|') {
      const double = line[i + 1] === char;
      if (char === '|' && line[i + 1] === '&') return undefined;
      endCommand();
      if (double) i++;
      continue;
    }
    if (char === '#' && !inWord) {
      const newline = line.indexOf('\n', i);
      if (newline === -1) break;
      i = newline - 1;
      continue;
    }
    word += char;
    inWord = true;
  }
  endCommand();
  if (firstHasDollar) return undefined;
  for (const command of commands) {
    const program = command[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(program)) return undefined;
    if (program.includes('$') || /[*?[]/.test(program)) return undefined;
    if (KEEP_SANDBOXED.has(program)) return undefined;
    if (writesTreeOutside(command)) return undefined;
  }
  return commands.length > 0 ? commands : undefined;
}

/** A `git clone` (and kin) whose path argument is absolute, under `~`, or climbs out with `..` */
function writesTreeOutside(command: readonly string[]): boolean {
  if (command[0] !== 'git') return false;
  const args = command.slice(1).filter((word) => !word.startsWith('-'));
  const writer = GIT_TREE_WRITERS.find((sub) => sub.every((part, i) => args[i] === part));
  if (!writer) return false;
  return args
    .slice(writer.length)
    .some((word) => word.startsWith('/') || word.startsWith('~') || word.split('/').includes('..'));
}

/** Whether `text` matches `pattern`, where `*` stands for any text and the rest is literal */
export function wildcardMatch(text: string, pattern: string): boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) return text === pattern;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!text.startsWith(first)) return false;
  if (text.length - last.length < first.length || !text.endsWith(last)) return false;
  let at = first.length;
  const end = text.length - last.length;
  for (const part of parts.slice(1, -1)) {
    if (part === '') continue;
    const found = text.indexOf(part, at);
    if (found === -1 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
}

/**
 * Whether a command (its words joined by spaces) matches a pattern of `excludedCommands`, read
 * as the content of a `Bash(...)` rule: `*` is any text, a trailing ` *` (or `:*`) also matches
 * the command alone, a pattern without a wildcard matches exactly
 */
export function matchesCommandPattern(command: string, pattern: string): boolean {
  let spec = pattern.trim().replace(/["']/g, '');
  if (spec.endsWith(':*')) spec = `${spec.slice(0, -2)} *`;
  spec = spec.replace(/\s+/g, ' ');
  if (spec === '*' || spec === '') return true;
  const wildcards = spec.split('*').length - 1;
  if (wildcards === 1 && spec.endsWith(' *') && command === spec.slice(0, -2)) return true;
  return wildcardMatch(command, spec);
}

/** Whether every command of `line` matches one of `patterns`, so the line runs outside the sandbox */
export function isExcludedCommand(line: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  const commands = plainCommands(line);
  if (!commands) return false;
  return commands.every((words) =>
    patterns.some((pattern) => matchesCommandPattern(words.join(' '), pattern))
  );
}
