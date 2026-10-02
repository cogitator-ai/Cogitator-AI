interface RegexInput {
  text: string;
  pattern: string;
  flags?: string;
  operation: 'match' | 'matchAll' | 'test' | 'replace' | 'split';
  replacement?: string;
  limit?: number;
}

interface MatchResult {
  match: string;
  index: number;
  groups?: Record<string, string>;
}

interface RegexOutput {
  result: boolean | string | string[] | MatchResult | MatchResult[] | null;
  matchCount?: number;
  error?: string;
}

type RegexResult = boolean | string | string[] | MatchResult | MatchResult[] | null;

const MAX_ITERATIONS = 100000;
const MAX_PATTERN_LENGTH = 1000;
const MAX_FINITE_REPEAT = 100;

interface GroupFrame {
  hasQuantifier: boolean;
}

function readQuantifier(
  pattern: string,
  index: number
): { length: number; unbounded: boolean } | null {
  const char = pattern[index];
  if (char === '*' || char === '+') return { length: 1, unbounded: true };
  if (char === '?') return { length: 1, unbounded: false };
  if (char === '{') {
    const match = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(index));
    if (!match) return null;
    const max =
      match[2] === undefined ? Number(match[1]) : match[3] === '' ? Infinity : Number(match[3]);
    return { length: match[0].length, unbounded: max > MAX_FINITE_REPEAT };
  }
  return null;
}

function isDangerousPattern(pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) return true;

  const stack: GroupFrame[] = [{ hasQuantifier: false }];
  let inClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];

    if (char === '\\') {
      i++;
      const quantifier = readQuantifier(pattern, i + 1);
      if (quantifier) {
        if (quantifier.unbounded) stack[stack.length - 1].hasQuantifier = true;
        i += quantifier.length;
      }
      continue;
    }

    if (inClass) {
      if (char === ']') {
        inClass = false;
        const quantifier = readQuantifier(pattern, i + 1);
        if (quantifier) {
          if (quantifier.unbounded) stack[stack.length - 1].hasQuantifier = true;
          i += quantifier.length;
        }
      }
      continue;
    }

    if (char === '[') {
      inClass = true;
      if (pattern[i + 1] === '^') i++;
      if (pattern[i + 1] === ']') i++;
      continue;
    }

    if (char === '(') {
      stack.push({ hasQuantifier: false });
      continue;
    }

    if (char === ')') {
      if (stack.length === 1) continue;
      const group = stack.pop()!;
      const parent = stack[stack.length - 1];
      const quantifier = readQuantifier(pattern, i + 1);
      if (quantifier) {
        if (quantifier.unbounded && group.hasQuantifier) {
          return true;
        }
        i += quantifier.length;
        if (quantifier.unbounded) parent.hasQuantifier = true;
      }
      if (group.hasQuantifier) parent.hasQuantifier = true;
      continue;
    }

    const quantifier = readQuantifier(pattern, i + 1);
    if (quantifier) {
      if (quantifier.unbounded) stack[stack.length - 1].hasQuantifier = true;
      i += quantifier.length;
    }
  }

  return false;
}

function safeMatch(text: string, regex: RegExp): MatchResult | null {
  const match = regex.exec(text);
  if (!match) return null;

  return {
    match: match[0],
    index: match.index,
    groups: match.groups as Record<string, string> | undefined,
  };
}

function safeMatchAll(text: string, regex: RegExp, limit: number): MatchResult[] {
  const results: MatchResult[] = [];
  let iterations = 0;
  if (limit <= 0) return results;

  const globalRegex = new RegExp(
    regex.source,
    regex.flags.includes('g') ? regex.flags : regex.flags + 'g'
  );

  let match: RegExpExecArray | null;
  while ((match = globalRegex.exec(text)) !== null) {
    results.push({
      match: match[0],
      index: match.index,
      groups: match.groups,
    });

    iterations++;
    if (iterations >= limit || iterations >= MAX_ITERATIONS) break;

    if (match[0].length === 0) {
      globalRegex.lastIndex++;
    }
  }

  return results;
}

function safeReplace(text: string, regex: RegExp, replacement: string): string {
  return text.replace(regex, replacement);
}

function safeSplit(text: string, regex: RegExp, limit?: number): string[] {
  return text.split(regex, limit);
}

function safeTest(text: string, regex: RegExp): boolean {
  return regex.test(text);
}

export function regex(): number {
  try {
    const inputStr = Host.inputString();
    const input: RegexInput = JSON.parse(inputStr);

    if (isDangerousPattern(input.pattern)) {
      throw new Error(
        'Pattern may cause catastrophic backtracking (ReDoS): nested unbounded quantifiers detected'
      );
    }

    const flags = input.flags ?? '';
    const regex = new RegExp(input.pattern, flags);
    const limit = input.limit ?? 1000;

    let result: RegexResult;
    let matchCount: number | undefined;

    switch (input.operation) {
      case 'test':
        result = safeTest(input.text, regex);
        break;

      case 'match':
        result = safeMatch(input.text, regex);
        matchCount = result ? 1 : 0;
        break;

      case 'matchAll': {
        const matches = safeMatchAll(input.text, regex, limit);
        result = matches;
        matchCount = matches.length;
        break;
      }

      case 'replace':
        if (input.replacement === undefined) {
          throw new Error('replacement is required for replace operation');
        }
        result = safeReplace(input.text, regex, input.replacement);
        break;

      case 'split':
        result = safeSplit(input.text, regex, input.limit);
        break;

      default:
        throw new Error(`Unknown operation: ${input.operation}`);
    }

    const output: RegexOutput = {
      result,
      matchCount,
    };

    Host.outputString(JSON.stringify(output));
    return 0;
  } catch (error) {
    const output: RegexOutput = {
      result: null,
      error: error instanceof Error ? error.message : String(error),
    };
    Host.outputString(JSON.stringify(output));
    return 1;
  }
}

declare const Host: {
  inputString(): string;
  outputString(s: string): void;
};
