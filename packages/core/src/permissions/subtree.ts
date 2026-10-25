/**
 * Commands that touch whole directories: recursive readers (`grep -r`, `rg`, `find`, `du`,
 * `tar -c`...) and recursive writers (`rm -r`, `chmod -R`, `cp -r`, `mv`, `rsync`, `tar -x`...),
 * with their options read exactly, so a value of an option is never taken for a directory
 */

import { posix } from 'node:path';

/** The options a command takes */
interface OptionSpec {
  /** Short flags without a value */
  flags: string;
  /** Short options that take a value, glued (`-m5`) or as the next word */
  valued?: string;
  /** Long flags */
  long?: readonly string[];
  /** Long options that take a value, as `--name=value` or the next word */
  longValued?: readonly string[];
  /** Long options whose value is optional, given only as `--name=value` */
  longOptional?: readonly string[];
  /** Short options that take every word after them (`zip -x a b c`) */
  rest?: string;
  /** Whether options may follow operands, as GNU tools read them (default true) */
  permute?: boolean;
}

/** A command's words read with its {@link OptionSpec} */
interface ReadArgs {
  operands: string[];
  /** The flags given, by name (`-r`, `--recursive`) */
  flags: Set<string>;
  /** The values of options, by option name */
  values: Map<string, string[]>;
}

/**
 * The words of `argv` (the program first) read with `spec`, or undefined when one of them is an
 * option the spec does not know
 */
function readArgs(argv: readonly string[], spec: OptionSpec): ReadArgs | undefined {
  const read: ReadArgs = { operands: [], flags: new Set(), values: new Map() };
  const give = (name: string, value: string) => {
    const list = read.values.get(name) ?? [];
    list.push(value);
    read.values.set(name, list);
  };
  const args = argv.slice(1);
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (!options || word === '-' || !word.startsWith('-')) {
      read.operands.push(word);
      if (spec.permute === false) options = false;
      continue;
    }
    if (word === '--') {
      options = false;
      continue;
    }
    if (word.startsWith('--')) {
      const equals = word.indexOf('=');
      const name = equals === -1 ? word : word.slice(0, equals);
      if (spec.longValued?.includes(name)) {
        const value = equals === -1 ? args[++i] : word.slice(equals + 1);
        if (value === undefined) return undefined;
        give(name, value);
        continue;
      }
      if (spec.longOptional?.includes(name)) {
        if (equals !== -1) give(name, word.slice(equals + 1));
        else read.flags.add(name);
        continue;
      }
      if (equals === -1 && spec.long?.includes(name)) {
        read.flags.add(name);
        continue;
      }
      return undefined;
    }
    for (let at = 1; at < word.length; at++) {
      const letter = word[at];
      const name = `-${letter}`;
      if (spec.rest?.includes(letter)) {
        const glued = word.slice(at + 1);
        for (const value of [...(glued ? [glued] : []), ...args.slice(i + 1)]) give(name, value);
        return read;
      }
      if (spec.valued?.includes(letter)) {
        const value = at + 1 < word.length ? word.slice(at + 1) : args[++i];
        if (value === undefined) return undefined;
        give(name, value);
        break;
      }
      if (!spec.flags.includes(letter)) return undefined;
      read.flags.add(name);
    }
  }
  return read;
}

/** The directories a command reads and changes with everything inside */
export interface Subtrees {
  readsInto: string[];
  writesInto: string[];
}

interface SubtreeCommand {
  options: OptionSpec;
  /** What the command touches, from its words read */
  subtrees(read: ReadArgs): Subtrees;
}

const has = (read: ReadArgs, ...names: string[]) =>
  names.some((name) => read.flags.has(name) || read.values.has(name));

const valuesOf = (read: ReadArgs, ...names: string[]) =>
  names.flatMap((name) => read.values.get(name) ?? []);

const NONE: Subtrees = { readsInto: [], writesInto: [] };

/** Operands of a search after its pattern, which an option may give instead */
function searched(read: ReadArgs, patternOptions: readonly string[]): string[] {
  const files = has(read, ...patternOptions) ? read.operands : read.operands.slice(1);
  return files.length > 0 ? files : ['.'];
}

/** Every source and the target of a copy or a move, the target named with `-t` or last */
function copyTargets(read: ReadArgs): { sources: string[]; target?: string } {
  const named = valuesOf(read, '-t', '--target-directory')[0];
  if (named !== undefined) return { sources: read.operands, target: named };
  if (read.operands.length < 2) return { sources: read.operands };
  return { sources: read.operands.slice(0, -1), target: read.operands[read.operands.length - 1] };
}

/** The target of a copy and where each source lands inside it */
function landing(sources: readonly string[], target: string | undefined): string[] {
  if (target === undefined) return [];
  return [target, ...sources.map((source) => posix.join(target, posix.basename(source)))];
}

const GREP_OPTIONS: OptionSpec = {
  flags: 'abcEFGHhiIJLlnOopPqRrSsTUuVvwxZz0123456789',
  valued: 'ABCDdefm',
  long: [
    '--recursive',
    '--dereference-recursive',
    '--ignore-case',
    '--no-ignore-case',
    '--invert-match',
    '--word-regexp',
    '--line-regexp',
    '--count',
    '--files-with-matches',
    '--files-without-match',
    '--only-matching',
    '--quiet',
    '--silent',
    '--no-messages',
    '--byte-offset',
    '--with-filename',
    '--no-filename',
    '--line-number',
    '--line-buffered',
    '--initial-tab',
    '--null',
    '--null-data',
    '--text',
    '--binary',
    '--extended-regexp',
    '--fixed-strings',
    '--basic-regexp',
    '--perl-regexp',
    '--version',
    '--help',
  ],
  longValued: [
    '--regexp',
    '--file',
    '--max-count',
    '--after-context',
    '--before-context',
    '--label',
    '--include',
    '--exclude',
    '--exclude-dir',
    '--exclude-from',
    '--directories',
    '--devices',
    '--binary-files',
  ],
  longOptional: ['--context', '--color', '--colour'],
};

const grep: SubtreeCommand = {
  options: GREP_OPTIONS,
  subtrees: (read) => {
    const recursive =
      has(read, '-r', '-R', '--recursive', '--dereference-recursive') ||
      valuesOf(read, '-d', '--directories').includes('recurse');
    if (!recursive) return NONE;
    return { readsInto: searched(read, ['-e', '-f', '--regexp', '--file']), writesInto: [] };
  },
};

const rg: SubtreeCommand = {
  options: {
    flags: 'acFHhiIlLnNopPqsSuUvVwxz0',
    valued: 'ABCdeEfgjmMrtT',
    long: [
      '--files',
      '--type-list',
      '--hidden',
      '--no-ignore',
      '--no-ignore-vcs',
      '--no-ignore-parent',
      '--no-ignore-dot',
      '--no-ignore-global',
      '--follow',
      '--ignore-case',
      '--smart-case',
      '--case-sensitive',
      '--fixed-strings',
      '--word-regexp',
      '--line-regexp',
      '--count',
      '--count-matches',
      '--files-with-matches',
      '--files-without-match',
      '--invert-match',
      '--line-number',
      '--no-line-number',
      '--heading',
      '--no-heading',
      '--with-filename',
      '--no-filename',
      '--only-matching',
      '--quiet',
      '--json',
      '--vimgrep',
      '--multiline',
      '--multiline-dotall',
      '--pcre2',
      '--text',
      '--null',
      '--no-messages',
      '--column',
      '--no-column',
      '--trim',
      '--stats',
      '--unrestricted',
      '--search-zip',
      '--no-config',
      '--pretty',
      '--byte-offset',
      '--crlf',
      '--one-file-system',
      '--passthru',
      '--version',
      '--help',
    ],
    longValued: [
      '--regexp',
      '--file',
      '--glob',
      '--iglob',
      '--type',
      '--type-not',
      '--type-add',
      '--type-clear',
      '--max-count',
      '--max-depth',
      '--max-filesize',
      '--max-columns',
      '--context',
      '--after-context',
      '--before-context',
      '--replace',
      '--threads',
      '--encoding',
      '--color',
      '--colors',
      '--sort',
      '--sortr',
      '--path-separator',
      '--context-separator',
      '--field-match-separator',
      '--field-context-separator',
      '--engine',
    ],
  },
  subtrees: (read) => ({
    readsInto: searched(read, ['-e', '-f', '--regexp', '--file', '--files', '--type-list']),
    writesInto: [],
  }),
};

const ag: SubtreeCommand = {
  options: {
    flags: 'aDfhiLlnQRrSsuUvVwz0',
    valued: 'ABCGgmp',
    long: [
      '--hidden',
      '--ignore-case',
      '--case-sensitive',
      '--smart-case',
      '--literal',
      '--word-regexp',
      '--files-with-matches',
      '--files-without-matches',
      '--count',
      '--color',
      '--nocolor',
      '--group',
      '--nogroup',
      '--heading',
      '--noheading',
      '--follow',
      '--unrestricted',
      '--search-binary',
      '--all-types',
      '--all-text',
      '--vimgrep',
      '--column',
      '--numbers',
      '--nonumbers',
      '--silent',
      '--stats',
      '--one-device',
      '--skip-vcs-ignores',
      '--null',
      '--print0',
      '--only-matching',
      '--filename',
      '--nofilename',
      '--version',
      '--help',
    ],
    longValued: [
      '--ignore',
      '--ignore-dir',
      '--depth',
      '--max-count',
      '--after',
      '--before',
      '--context',
      '--file-search-regex',
      '--path-to-ignore',
      '--workers',
    ],
  },
  subtrees: (read) => ({ readsInto: searched(read, ['-g']), writesInto: [] }),
};

const ack: SubtreeCommand = {
  options: {
    flags: 'cfhHiIklLnoQsvwx',
    valued: 'ABCgm',
    long: [
      '--ignore-case',
      '--smart-case',
      '--invert-match',
      '--word-regexp',
      '--line',
      '--literal',
      '--count',
      '--files-with-matches',
      '--files-without-matches',
      '--with-filename',
      '--no-filename',
      '--nocolor',
      '--color',
      '--column',
      '--follow',
      '--nofollow',
      '--known-types',
      '--version',
      '--help',
    ],
    longValued: ['--match', '--type', '--ignore-dir', '--ignore-file', '--max-count', '--context'],
  },
  subtrees: (read) => ({ readsInto: searched(read, ['--match', '-f', '-g']), writesInto: [] }),
};

const du: SubtreeCommand = {
  options: {
    flags: 'aAbcghHklLmnPsx0',
    valued: 'BdItX',
    long: [
      '--all',
      '--apparent-size',
      '--bytes',
      '--total',
      '--dereference',
      '--dereference-args',
      '--no-dereference',
      '--human-readable',
      '--si',
      '--summarize',
      '--separate-dirs',
      '--one-file-system',
      '--null',
      '--count-links',
      '--inodes',
      '--version',
      '--help',
    ],
    longValued: ['--max-depth', '--block-size', '--threshold', '--exclude', '--exclude-from'],
    longOptional: ['--time'],
  },
  subtrees: (read) => ({
    readsInto: read.operands.length > 0 ? read.operands : ['.'],
    writesInto: [],
  }),
};

const ls: SubtreeCommand = {
  options: {
    flags: 'aAbBcCdeFfgGhHiklLmnNoOpqQrRsStTuUvwWxXZ1@%,',
    valued: 'DI',
    long: [
      '--all',
      '--almost-all',
      '--author',
      '--escape',
      '--directory',
      '--dired',
      '--classify',
      '--file-type',
      '--full-time',
      '--group-directories-first',
      '--no-group',
      '--human-readable',
      '--si',
      '--inode',
      '--dereference',
      '--dereference-command-line',
      '--dereference-command-line-symlink-to-dir',
      '--numeric-uid-gid',
      '--literal',
      '--hide-control-chars',
      '--show-control-chars',
      '--quote-name',
      '--reverse',
      '--recursive',
      '--size',
      '--context',
      '--zero',
      '--help',
      '--version',
    ],
    longValued: [
      '--block-size',
      '--format',
      '--hide',
      '--ignore',
      '--indicator-style',
      '--quoting-style',
      '--sort',
      '--time',
      '--time-style',
      '--tabsize',
      '--width',
    ],
    longOptional: ['--color', '--colour', '--hyperlink'],
  },
  subtrees: (read) =>
    has(read, '-R', '--recursive')
      ? { readsInto: read.operands.length > 0 ? read.operands : ['.'], writesInto: [] }
      : NONE,
};

const diff: SubtreeCommand = {
  options: {
    flags: 'abBcdeEfhHilnNpPqrsStTuvwyZ',
    valued: 'CDFILSUWxX',
    long: [
      '--recursive',
      '--brief',
      '--ignore-case',
      '--ignore-all-space',
      '--ignore-space-change',
      '--ignore-blank-lines',
      '--ignore-tab-expansion',
      '--ignore-trailing-space',
      '--text',
      '--new-file',
      '--unidirectional-new-file',
      '--side-by-side',
      '--left-column',
      '--report-identical-files',
      '--strip-trailing-cr',
      '--expand-tabs',
      '--initial-tab',
      '--minimal',
      '--normal',
      '--suppress-common-lines',
      '--show-c-function',
      '--speed-large-files',
      '--help',
      '--version',
    ],
    longValued: [
      '--exclude',
      '--exclude-from',
      '--label',
      '--starting-file',
      '--width',
      '--ignore-matching-lines',
      '--show-function-line',
      '--to-file',
      '--from-file',
      '--tabsize',
    ],
    longOptional: ['--unified', '--context', '--color'],
  },
  subtrees: (read) =>
    has(read, '-r', '--recursive') ? { readsInto: read.operands, writesInto: [] } : NONE,
};

const rm: SubtreeCommand = {
  options: {
    flags: 'dfiIPrRvWx',
    long: [
      '--force',
      '--one-file-system',
      '--no-preserve-root',
      '--recursive',
      '--dir',
      '--verbose',
      '--help',
      '--version',
    ],
    longOptional: ['--interactive', '--preserve-root'],
  },
  subtrees: (read) =>
    has(read, '-r', '-R', '--recursive') ? { readsInto: [], writesInto: read.operands } : NONE,
};

const rmdir: SubtreeCommand = {
  options: {
    flags: 'pv',
    long: ['--ignore-fail-on-non-empty', '--parents', '--verbose', '--help', '--version'],
  },
  subtrees: (read) => ({ readsInto: [], writesInto: read.operands }),
};

/** `chmod`, `chown` and `chgrp`: the first operand is the mode or the owner without `--reference` */
function ownership(flags: string): SubtreeCommand {
  return {
    options: {
      flags,
      long: [
        '--changes',
        '--silent',
        '--quiet',
        '--verbose',
        '--dereference',
        '--no-dereference',
        '--no-preserve-root',
        '--preserve-root',
        '--recursive',
        '--help',
        '--version',
      ],
      longValued: ['--reference', '--from'],
    },
    subtrees: (read) => {
      if (!has(read, '-R', '--recursive')) return NONE;
      const files = has(read, '--reference') ? read.operands : read.operands.slice(1);
      return { readsInto: [], writesInto: files };
    },
  };
}

const cp: SubtreeCommand = {
  options: {
    flags: 'abdfHilLnNPpRrsTuvxXZ',
    valued: 'St',
    long: [
      '--archive',
      '--attributes-only',
      '--copy-contents',
      '--dereference',
      '--force',
      '--interactive',
      '--link',
      '--no-clobber',
      '--no-dereference',
      '--no-target-directory',
      '--one-file-system',
      '--parents',
      '--recursive',
      '--remove-destination',
      '--strip-trailing-slashes',
      '--symbolic-link',
      '--verbose',
      '--debug',
      '--help',
      '--version',
    ],
    longValued: ['--target-directory', '--suffix', '--no-preserve', '--sparse'],
    longOptional: ['--backup', '--update', '--preserve', '--reflink'],
  },
  subtrees: (read) => {
    if (!has(read, '-r', '-R', '-a', '--recursive', '--archive')) return NONE;
    const { sources, target } = copyTargets(read);
    return { readsInto: sources, writesInto: landing(sources, target) };
  },
};

const mv: SubtreeCommand = {
  options: {
    flags: 'bfhinTuvZ',
    valued: 'St',
    long: [
      '--force',
      '--interactive',
      '--no-clobber',
      '--no-target-directory',
      '--strip-trailing-slashes',
      '--verbose',
      '--exchange',
      '--no-copy',
      '--help',
      '--version',
    ],
    longValued: ['--target-directory', '--suffix'],
    longOptional: ['--backup', '--update'],
  },
  subtrees: (read) => {
    const { sources, target } = copyTargets(read);
    return { readsInto: sources, writesInto: [...sources, ...landing(sources, target)] };
  },
};

const rsync: SubtreeCommand = {
  options: {
    flags: 'vqcarRbuldLkKHpEAXogDtOJSnWxCIyz0hPmFi8',
    valued: 'BfMT',
    long: [
      '--verbose',
      '--quiet',
      '--archive',
      '--recursive',
      '--relative',
      '--backup',
      '--update',
      '--links',
      '--copy-links',
      '--hard-links',
      '--perms',
      '--executability',
      '--acls',
      '--xattrs',
      '--owner',
      '--group',
      '--devices',
      '--specials',
      '--times',
      '--dry-run',
      '--whole-file',
      '--one-file-system',
      '--delete',
      '--delete-before',
      '--delete-during',
      '--delete-after',
      '--delete-excluded',
      '--checksum',
      '--compress',
      '--human-readable',
      '--progress',
      '--partial',
      '--stats',
      '--itemize-changes',
      '--ignore-existing',
      '--existing',
      '--remove-source-files',
      '--prune-empty-dirs',
      '--numeric-ids',
      '--inplace',
      '--append',
      '--sparse',
      '--mkpath',
      '--no-perms',
      '--no-owner',
      '--no-group',
      '--no-times',
      '--help',
      '--version',
    ],
    longValued: [
      '--exclude',
      '--include',
      '--exclude-from',
      '--include-from',
      '--filter',
      '--files-from',
      '--backup-dir',
      '--suffix',
      '--temp-dir',
      '--partial-dir',
      '--log-file',
      '--chmod',
      '--chown',
      '--max-size',
      '--min-size',
      '--bwlimit',
      '--timeout',
      '--compress-level',
      '--link-dest',
      '--compare-dest',
      '--copy-dest',
      '--password-file',
    ],
  },
  subtrees: (read) => {
    const { sources, target } = copyTargets(read);
    const removed = has(read, '--remove-source-files') ? sources : [];
    return { readsInto: sources, writesInto: [...removed, ...landing(sources, target)] };
  },
};

const scp: SubtreeCommand = {
  options: { flags: '346ABCpqRrTv', valued: 'ciJlPX' },
  subtrees: (read) => {
    const { sources, target } = copyTargets(read);
    return { readsInto: sources, writesInto: landing(sources, target) };
  },
};

const TAR_FLAGS = 'AcdrtuxzjJvpPkhOwmSWZaBiGlMnoRsUq';
const TAR_VALUED = 'fbCXKNVgL';

const tar: SubtreeCommand = {
  options: {
    flags: TAR_FLAGS,
    valued: TAR_VALUED,
    long: [
      '--create',
      '--extract',
      '--get',
      '--list',
      '--append',
      '--update',
      '--gzip',
      '--bzip2',
      '--xz',
      '--zstd',
      '--verbose',
      '--preserve-permissions',
      '--absolute-names',
      '--keep-old-files',
      '--dereference',
      '--to-stdout',
      '--auto-compress',
      '--numeric-owner',
      '--no-recursion',
      '--recursion',
      '--overwrite',
      '--totals',
      '--exclude-vcs',
      '--one-file-system',
      '--sparse',
      '--verify',
      '--help',
      '--version',
    ],
    longValued: [
      '--file',
      '--directory',
      '--exclude',
      '--exclude-from',
      '--blocking-factor',
      '--format',
      '--owner',
      '--group',
      '--mode',
      '--mtime',
      '--transform',
      '--strip-components',
      '--label',
      '--newer',
      '--after-date',
      '--newer-mtime',
      '--suffix',
    ],
  },
  subtrees: (read) => {
    const into = valuesOf(read, '-C', '--directory');
    const base = into[into.length - 1];
    const placed = (path: string) =>
      base === undefined || posix.isAbsolute(path) ? path : posix.join(base, path);
    const writes = has(read, '-x', '--extract', '--get');
    const reads = has(read, '-c', '-r', '-u', '--create', '--append', '--update');
    return {
      readsInto: reads ? read.operands.map(placed) : [],
      writesInto: writes ? [has(read, '-P', '--absolute-names') ? '/' : (base ?? '.')] : [],
    };
  },
};

/** `tar czf out.tgz dir`: the first word as letters without a `-`, each value taken in order */
function tarArgv(argv: readonly string[]): string[] {
  const bundle = argv[1];
  if (bundle === undefined || bundle.startsWith('-')) return [...argv];
  const words = [argv[0]];
  let next = 2;
  for (const letter of bundle) {
    words.push(`-${letter}`);
    if (TAR_VALUED.includes(letter) && argv[next] !== undefined) words.push(argv[next++]);
  }
  return [...words, ...argv.slice(next)];
}

const zip: SubtreeCommand = {
  options: {
    flags: 'rRqvjDJmugdylXS0123456789',
    valued: 'bntPO',
    rest: 'xi',
    long: [
      '--recurse-paths',
      '--quiet',
      '--verbose',
      '--junk-paths',
      '--move',
      '--update',
      '--freshen',
      '--symlinks',
    ],
    longValued: ['--output-file', '--password', '--temp-path', '--suffixes'],
  },
  subtrees: (read) => {
    const [archive, ...files] = read.operands;
    const written = [
      ...(archive === undefined ? [] : [archive]),
      ...valuesOf(read, '-O', '--output-file'),
    ];
    if (!has(read, '-r', '-R', '--recurse-paths')) return { readsInto: [], writesInto: written };
    return {
      readsInto: files,
      writesInto: [...written, ...(has(read, '-m', '--move') ? files : [])],
    };
  },
};

const unzip: SubtreeCommand = {
  options: { flags: 'lvtTzZoqnjCaXKVMfu', valued: 'dP', rest: 'x' },
  subtrees: (read) => ({
    readsInto: [],
    writesInto: has(read, '-l', '-t', '-v', '-Z') ? [] : [valuesOf(read, '-d').pop() ?? '.'],
  }),
};

const SUBTREE_COMMANDS: Record<string, SubtreeCommand> = {
  grep,
  egrep: grep,
  fgrep: grep,
  rg,
  ag,
  ack,
  du,
  ls,
  diff,
  rm,
  rmdir,
  chmod: ownership('RcfvHLPh'),
  chown: ownership('RcfvhHLP'),
  chgrp: ownership('RcfvhHLP'),
  cp,
  mv,
  rsync,
  scp,
  tar,
  bsdtar: tar,
  zip,
  unzip,
};

/** Where `find` starts: the words before its expression, `.` without any */
function findStarts(argv: readonly string[]): string[] {
  let i = 1;
  while (i < argv.length) {
    const word = argv[i];
    if (word === '-H' || word === '-L' || word === '-P' || /^-O\d*$/.test(word)) i++;
    else if (word === '-D') i += 2;
    else break;
  }
  const starts: string[] = [];
  for (; i < argv.length; i++) {
    const word = argv[i];
    if (word.startsWith('-') || word === '(' || word === '!' || word === ')' || word === ',') {
      break;
    }
    starts.push(word);
  }
  return starts.length > 0 ? starts : ['.'];
}

/** Whether the program of `argv` (by its base name) is one this module reads */
export function touchesSubtrees(program: string): boolean {
  return program === 'find' || Object.hasOwn(SUBTREE_COMMANDS, program);
}

/**
 * The directories `argv` (its program by base name in `program`) reads or changes with everything
 * inside, its options read exactly. `known` is false for an option the reading does not know:
 * then every word may name such a directory, so all of them count, the working directory too
 */
export function subtreesOf(
  program: string,
  argv: readonly string[]
): Subtrees & { known: boolean } {
  if (program === 'find') {
    const starts = findStarts(argv);
    return { readsInto: starts, writesInto: argv.includes('-delete') ? starts : [], known: true };
  }
  if (!Object.hasOwn(SUBTREE_COMMANDS, program)) return { ...NONE, known: true };
  const entry = SUBTREE_COMMANDS[program];
  const words = program === 'tar' || program === 'bsdtar' ? tarArgv(argv) : argv;
  const read = readArgs(words, entry.options);
  if (read) return { ...entry.subtrees(read), known: true };
  const every = ['.', ...argv.slice(1).flatMap((word) => [word, ...afterEquals(word)])];
  return { readsInto: every, writesInto: every, known: false };
}

/**
 * The operands of a copy or a move (`cp`, `mv`, `rsync`, `scp`) read with its options: the
 * sources and the target, or undefined when an option is not known
 */
export function copyOperands(
  program: string,
  argv: readonly string[]
): { sources: string[]; target?: string } | undefined {
  const entry = Object.hasOwn(SUBTREE_COMMANDS, program) ? SUBTREE_COMMANDS[program] : undefined;
  if (!entry || !['cp', 'mv', 'rsync', 'scp'].includes(program)) return undefined;
  const read = readArgs(argv, entry.options);
  return read ? copyTargets(read) : undefined;
}

function afterEquals(word: string): string[] {
  const equals = word.indexOf('=');
  return equals !== -1 && equals < word.length - 1 ? [word.slice(equals + 1)] : [];
}
