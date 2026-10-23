/**
 * A matcher for `glob` against paths with `/` separators: `*` and `?` stay within one path
 * segment, `**` spans any number of them, `{a,b}` is either alternative (nesting allowed) and
 * `[abc]`, `[a-z]`, `[!abc]` match one character of a class. A dot-file is matched like any
 * other name.
 */
export function globMatcher(glob: string): (path: string) => boolean {
  const pattern = new RegExp(`^${globSource(glob)}$`);
  return (path) => pattern.test(path);
}

function globSource(glob: string): string {
  let source = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        const startsSegment = i === 0 || glob[i - 1] === '/';
        const next = glob[i + 2];
        if (startsSegment && next === '/') {
          source += '(?:[^/]*(?:/[^/]*)*/)?';
          i += 2;
        } else if (startsSegment && next === undefined) {
          source += '.*';
          i += 1;
        } else {
          source += '[^/]*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end === -1) {
        source += '\\[';
        continue;
      }
      let body = glob.slice(i + 1, end);
      const negated = body.startsWith('!') || body.startsWith('^');
      if (negated) body = body.slice(1);
      source += `[${negated ? '^/' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`;
      i = end;
    } else if (char === '{') {
      braces++;
      source += '(?:';
    } else if (char === '}' && braces > 0) {
      braces--;
      source += ')';
    } else if (char === ',' && braces > 0) {
      source += '|';
    } else if (char === '\\' && i + 1 < glob.length) {
      source += escapeRegExp(glob[i + 1]);
      i++;
    } else {
      source += escapeRegExp(char);
    }
  }
  return source + ')'.repeat(braces);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
