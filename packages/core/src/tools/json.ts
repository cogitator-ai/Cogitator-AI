/**
 * JSON tools - parse and stringify JSON
 */

import { z } from 'zod';
import { tool } from '../tool';

const jsonParseParams = z.object({
  json: z.string().describe('The JSON string to parse'),
});

export const jsonParse = tool({
  name: 'json_parse',
  description: 'Parse a JSON string into an object. Returns an error if the JSON is invalid.',
  parameters: jsonParseParams,
  execute: async ({ json }) => {
    try {
      const result: unknown = JSON.parse(json);
      return { result, valid: true };
    } catch (err) {
      return { error: (err as Error).message, valid: false };
    }
  },
});

const jsonStringifyParams = z.object({
  data: z.unknown().describe('The data to convert to JSON'),
  pretty: z.boolean().optional().describe('Format with indentation (default: false)'),
  indent: z.number().int().min(0).max(8).optional().describe('Indentation spaces (default: 2)'),
});

export const jsonStringify = tool({
  name: 'json_stringify',
  description: 'Convert a value to a JSON string. Optionally format with indentation.',
  parameters: jsonStringifyParams,
  execute: async ({ data, pretty = false, indent = 2 }) => {
    try {
      const result = pretty ? JSON.stringify(data, null, indent) : JSON.stringify(data);
      return { result, pretty };
    } catch (err) {
      return { error: (err as Error).message };
    }
  },
});
