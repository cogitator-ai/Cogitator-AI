/**
 * Base64 tools - encode and decode base64 strings
 */

import { z } from 'zod';
import { tool } from '../tool.js';

const base64EncodeParams = z.object({
  data: z.string().describe('The string to encode'),
  urlSafe: z
    .boolean()
    .optional()
    .describe('Use URL-safe base64 encoding (default: false)'),
});

export const base64Encode = tool({
  name: 'base64_encode',
  description: 'Encode a string to base64. Optionally use URL-safe encoding.',
  parameters: base64EncodeParams,
  execute: async ({ data, urlSafe = false }) => {
    let result = Buffer.from(data).toString('base64');
    if (urlSafe) {
      result = result.replace(/\+/g, '-').replace(/\//g, '_');
    }
    return { result, urlSafe };
  },
});

const base64DecodeParams = z.object({
  data: z.string().describe('The base64 string to decode'),
  urlSafe: z
    .boolean()
    .optional()
    .describe('Input uses URL-safe base64 encoding (default: false)'),
});

export const base64Decode = tool({
  name: 'base64_decode',
  description: 'Decode a base64 string back to plain text.',
  parameters: base64DecodeParams,
  execute: async ({ data, urlSafe = false }) => {
    try {
      let input = data;
      if (urlSafe) {
        input = input.replace(/-/g, '+').replace(/_/g, '/');
        while (input.length % 4 !== 0) {
          input += '=';
        }
      }
      const result = Buffer.from(input, 'base64').toString('utf-8');
      return { result, urlSafe };
    } catch (err) {
      return { error: (err as Error).message };
    }
  },
});
