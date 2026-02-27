import { z } from 'zod';
import { tool } from '../tool';

const capabilitiesParams = z.object({
  query: z.string().describe('What capability to search for, e.g. "screenshot" or "web search"'),
});

export function createCapabilitiesTool(capabilitiesDoc: string) {
  return tool({
    name: 'lookup_capabilities',
    description:
      'Search your own capabilities document to check what tools and features you have. Use this when the user asks "can you do X?" or when you need to verify your available tools.',
    parameters: capabilitiesParams,
    execute: async ({ query }) => {
      const queryLower = query.toLowerCase();
      const lines = capabilitiesDoc.split('\n');
      const matches: string[] = [];

      for (const line of lines) {
        if (line.toLowerCase().includes(queryLower)) {
          matches.push(line.trim());
        }
      }

      if (matches.length > 0) {
        return {
          found: true,
          matches: matches.join('\n'),
          suggestion: `I found ${matches.length} matching capabilities.`,
        };
      }

      return {
        found: false,
        matches: '',
        suggestion: 'No matching capabilities found. This feature may not be available.',
      };
    },
  });
}
