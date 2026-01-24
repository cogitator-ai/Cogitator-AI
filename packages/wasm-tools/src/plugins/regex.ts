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
const DANGEROUS_PATTERNS = [
  /\(\?[^)]*\)\+\+/,
  /\(\.\*\)\+/,
  /\(\.\+\)\+/,
  /\([^)]+\+\)\+/,
  /\([^)]+\*\)\*/,
];

function isDangerousPattern(pattern: string): boolean {
  for (const dangerous of DANGEROUS_PATTERNS) {
    if (dangerous.test(pattern)) {
      return true;
    }
  }

  let depth = 0;
  let quantifiers = 0;
  for (const char of pattern) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if ((char === '+' || char === '*') && depth > 0) quantifiers++;
  }

  return quantifiers > 3;
}

function safeMatch(text: string, regex: RegExp): MatchResult | null {
  const match = text.match(regex);
  if (!match) return null;

  return {
    match: match[0],
    index: match.index ?? 0,
    groups: match.groups,
  };
}

function safeMatchAll(text: string, regex: RegExp, limit: number): MatchResult[] {
  const results: MatchResult[] = [];
  let iterations = 0;

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
      throw new Error('Pattern may cause ReDoS - nested quantifiers detected');
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

      case 'matchAll':
        const matches = safeMatchAll(input.text, regex, limit);
        result = matches;
        matchCount = matches.length;
        break;

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
