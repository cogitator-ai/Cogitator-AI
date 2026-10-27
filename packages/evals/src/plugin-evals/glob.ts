const SPECIAL = /[\\^$.*+?()[\]{}|/]/;

/**
 * A glob as a regular expression over a whole string: `*` matches within a path segment, `**`
 * across segments, `?` one character, `[...]` a class and `{a,b}` alternatives
 */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  let depth = 0;
  for (let at = 0; at < glob.length; at++) {
    const char = glob[at];
    if (char === '*') {
      if (glob[at + 1] === '*') {
        at++;
        if (glob[at + 1] === '/') {
          at++;
          source += '(?:.*/)?';
        } else source += '.*';
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else if (char === '[') {
      const end = glob.indexOf(']', at + 2);
      if (end === -1) source += '\\[';
      else {
        const body = glob.slice(at + 1, end).replace(/\\/g, '\\\\');
        source += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
        at = end;
      }
    } else if (char === '{') {
      depth++;
      source += '(?:';
    } else if (char === '}' && depth > 0) {
      depth--;
      source += ')';
    } else if (char === ',' && depth > 0) source += '|';
    else if (char === '\\' && at + 1 < glob.length) {
      at++;
      source += escapeChar(glob[at]);
    } else source += escapeChar(char);
  }
  source += ')'.repeat(depth);
  return new RegExp(`^${source}$`);
}

function escapeChar(char: string): string {
  return SPECIAL.test(char) ? `\\${char}` : char;
}

/** Whether `value` matches `glob` as a whole */
export function globMatches(glob: string, value: string): boolean {
  return globToRegExp(glob).test(value);
}
