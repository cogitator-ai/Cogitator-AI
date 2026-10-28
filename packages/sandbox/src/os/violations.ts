import type { SandboxViolation } from '@cogitator-ai/types';

const MAX_REPORTED = 20;
const MAX_LINE = 300;
const MAX_FILE_VIOLATIONS = 50;

/** Errors the operating system gives a command the sandbox refused a file access */
const DENIAL = /operation not permitted|read-only file system|permission denied/i;

/**
 * The file accesses a sandboxed command was refused, read from what it wrote to stderr: lines
 * with `Operation not permitted` (Seatbelt), `Read-only file system` or `Permission denied`
 * (bubblewrap), each with the path it names when it names one. Advisory only: the command
 * controls its stderr, so it can hide a refusal or print one that never happened
 */
export function fileViolations(stderr: string): SandboxViolation[] {
  const violations: SandboxViolation[] = [];
  const seen = new Set<string>();
  for (const line of stderr.split(/\r?\n/)) {
    if (!DENIAL.test(line)) continue;
    const target = pathIn(line) ?? '';
    const operation = /read-only file system/i.test(line) ? 'file-write' : 'file-access';
    const reason = line.trim();
    const key = `${operation}\u0000${target}\u0000${reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    violations.push({ kind: 'filesystem', operation, target, reason });
    if (violations.length >= MAX_FILE_VIOLATIONS) break;
  }
  return violations;
}

/**
 * The path a line of an error names: the part right before the error (`sh: <path>: Operation
 * not permitted`), else a quoted absolute path (`cannot create '<path>'`), else the first
 * absolute path
 */
function pathIn(line: string): string | undefined {
  const before =
    /(?:^|:\s)([^:]+?):\s*(?:operation not permitted|read-only file system|permission denied)/i.exec(
      line
    );
  const named = before?.[1]?.trim();
  if (named && !/^line \d+$/.test(named) && !/\s/.test(named)) return stripQuotes(named);
  const quoted = /['\u2018\u2019"`](\/[^'\u2018\u2019"`]*)['\u2018\u2019"`]/.exec(line);
  if (quoted) return quoted[1];
  const bare = /(?:^|[\s(])(\/[^\s:'"]+)/.exec(line);
  return bare?.[1];
}

function stripQuotes(text: string): string {
  return text.replace(/^['\u2018\u2019"`]|['\u2018\u2019"`]$/g, '');
}

/**
 * The violations `ignoreViolations` does not silence for `command`: a key is a substring of the
 * command (`*` for every command), its values substrings of a violation's target or reason
 */
export function withoutIgnored(
  violations: readonly SandboxViolation[],
  command: string,
  ignore: Readonly<Record<string, readonly string[]>> | undefined
): SandboxViolation[] {
  if (!ignore) return [...violations];
  const silenced = Object.entries(ignore)
    .filter(([key]) => key === '*' || command.includes(key))
    .flatMap(([, values]) => values);
  if (silenced.length === 0) return [...violations];
  return violations.filter(
    (violation) =>
      !silenced.some(
        (value) =>
          value !== '' && (violation.target.includes(value) || violation.reason.includes(value))
      )
  );
}

/** Text a command controls made safe to quote inside the block: no control characters, no tags */
export function sanitize(text: string): string {
  const clean = Array.from(text)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0);
    })
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return clean.length > MAX_LINE ? `${clean.slice(0, MAX_LINE)}...` : clean;
}

/**
 * The `<sandbox_violations>` block appended to a command's stderr: one line per refusal, the
 * text sanitized, at most twenty lines and a count of the rest
 */
export function violationsBlock(violations: readonly SandboxViolation[]): string | undefined {
  if (violations.length === 0) return undefined;
  const lines = violations.slice(0, MAX_REPORTED).map((violation) => {
    const target = violation.target ? ` ${sanitize(violation.target)}` : '';
    return `deny ${violation.operation}${target} (${sanitize(violation.reason)})`;
  });
  if (violations.length > MAX_REPORTED) {
    lines.push(`... and ${violations.length - MAX_REPORTED} more`);
  }
  return `<sandbox_violations>\n${lines.join('\n')}\n</sandbox_violations>`;
}

/**
 * `text` with every `<sandbox_violations>` tag the command wrote neutralized (`&lt;` instead of
 * `<`), so only the block the sandbox appends reads as one
 */
export function neutralizeViolationTags(text: string): string {
  return text.replace(/<(\/?\s*sandbox_violations)/gi, '&lt;$1');
}
