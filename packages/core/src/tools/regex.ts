/**
 * Regex tools - pattern matching and replacement
 */

import { z } from 'zod';
import { tool } from '../tool.js';

const regexMatchParams = z.object({
  text: z.string().describe('The text to search in'),
  pattern: z.string().describe('Regular expression pattern'),
  flags: z.string().optional().describe('Regex flags (default: "g"). Common: g=global, i=case-insensitive, m=multiline'),
});

export const regexMatch = tool({
  name: 'regex_match',
  description:
    'Find all matches of a regular expression in text. Returns an array of matches with their positions.',
  parameters: regexMatchParams,
  execute: async ({ text, pattern, flags = 'g' }) => {
    try {
      const regex = new RegExp(pattern, flags);
      const matches: { match: string; index: number; groups?: Record<string, string> }[] = [];

      if (flags.includes('g')) {
        let match: RegExpExecArray | null;
        while ((match = regex.exec(text)) !== null) {
          matches.push({
            match: match[0],
            index: match.index,
            groups: match.groups,
          });
        }
      } else {
        const match = regex.exec(text);
        if (match) {
          matches.push({
            match: match[0],
            index: match.index,
            groups: match.groups,
          });
        }
      }

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
    try {
      const regex = new RegExp(pattern, flags);
      const result = text.replace(regex, replacement);
      const replacements = (text.match(regex) || []).length;
      return { result, replacements, pattern, flags };
    } catch (err) {
      return { error: (err as Error).message, pattern };
    }
  },
});
