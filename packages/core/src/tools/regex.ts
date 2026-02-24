/**
 * Regex tools - pattern matching and replacement
 */

import { z } from 'zod';
import { tool } from '../tool';

const MAX_TEXT_LENGTH = 1_000_000;
const REGEX_TIMEOUT_MS = 5_000;

function execRegexWithTimeout(
  regex: RegExp,
  text: string,
  timeoutMs: number
): { match: string; index: number; groups?: Record<string, string> }[] {
  const matches: { match: string; index: number; groups?: Record<string, string> }[] = [];
  const start = Date.now();
  const isGlobal = regex.global;

  if (isGlobal) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      matches.push({ match: match[0], index: match.index, groups: match.groups });
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Regex execution timed out after ${timeoutMs}ms`);
      }
    }
  } else {
    const match = regex.exec(text);
    if (match) {
      matches.push({ match: match[0], index: match.index, groups: match.groups });
    }
  }

  return matches;
}

const regexMatchParams = z.object({
  text: z.string().describe('The text to search in'),
  pattern: z.string().describe('Regular expression pattern'),
  flags: z
    .string()
    .optional()
    .describe('Regex flags (default: "g"). Common: g=global, i=case-insensitive, m=multiline'),
});

export const regexMatch = tool({
  name: 'regex_match',
  description:
    'Find all matches of a regular expression in text. Returns an array of matches with their positions.',
  parameters: regexMatchParams,
  execute: async ({ text, pattern, flags = 'g' }) => {
    if (text.length > MAX_TEXT_LENGTH) {
      return { error: `Text too large (${text.length} chars). Maximum: ${MAX_TEXT_LENGTH}` };
    }

    try {
      const regex = new RegExp(pattern, flags);
      const matches = execRegexWithTimeout(regex, text, REGEX_TIMEOUT_MS);
      return { matches, count: matches.length, pattern, flags };
    } catch (err) {
      return { error: (err as Error).message, pattern };
    }
  },
});

const regexReplaceParams = z.object({
  text: z.string().describe('The text to perform replacement on'),
  pattern: z.string().describe('Regular expression pattern to match'),
  replacement: z.string().describe('Replacement string. Use $1, $2, etc. for capture groups'),
  flags: z.string().optional().describe('Regex flags (default: "g")'),
});

export const regexReplace = tool({
  name: 'regex_replace',
  description:
    'Replace matches of a regular expression in text. Use $1, $2, etc. to reference capture groups in the replacement.',
  parameters: regexReplaceParams,
  execute: async ({ text, pattern, replacement, flags = 'g' }) => {
    if (text.length > MAX_TEXT_LENGTH) {
      return { error: `Text too large (${text.length} chars). Maximum: ${MAX_TEXT_LENGTH}` };
    }

    try {
      const regex = new RegExp(pattern, flags);
      const countMatches = execRegexWithTimeout(regex, text, REGEX_TIMEOUT_MS);
      regex.lastIndex = 0;
      const result = text.replace(regex, replacement);
      return { result, replacements: countMatches.length, pattern, flags };
    } catch (err) {
      return { error: (err as Error).message, pattern };
    }
  },
});
