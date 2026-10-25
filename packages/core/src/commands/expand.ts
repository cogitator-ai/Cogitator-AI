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
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(input.trimEnd());
  if (!match) return undefined;
  const name = match[1];
  if (name === undefined) return undefined;
  return { name, arguments: (match[2] ?? '').trim() };
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

const PLACEHOLDER = /(\\*)\$(?:ARGUMENTS\[(\d+)\]|(ARGUMENTS)|(\d+)|([A-Za-z_][A-Za-z0-9_]*))/g;

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
  const expanded = withVariables.replace(
    PLACEHOLDER,
    (
      all: string,
      slashes: string,
      indexed?: string,
      whole?: string,
      short?: string,
      named?: string
    ) => {
      const token = all.slice(slashes.length);
      const index = indexed ?? short;
      const known =
        whole !== undefined ||
        index !== undefined ||
        (named !== undefined && names.includes(named));
      if (!known) return all;
      if (slashes.length === 1) return token;
      let value: string | undefined;
      if (whole !== undefined) {
        value = args;
      } else if (index !== undefined) {
        value = positional[Number(index)];
      } else if (named !== undefined) {
        value = positional[names.indexOf(named)] ?? '';
        received = true;
      }
      if (value === undefined) return all;
      if (args !== '') received = true;
      return `${slashes}${value}`;
    }
  );
  if (args !== '' && !received) return `${expanded}\n\nARGUMENTS: ${args}`;
  return expanded;
}
