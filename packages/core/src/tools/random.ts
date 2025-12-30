/**
 * Random tools - generate random numbers and strings
 */

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { tool } from '../tool.js';

const randomNumberParams = z.object({
  min: z.number().optional().describe('Minimum value (default: 0)'),
  max: z.number().optional().describe('Maximum value (default: 1)'),
  integer: z.boolean().optional().describe('Return integer only (default: false)'),
});

export const randomNumber = tool({
  name: 'random_number',
  description: 'Generate a random number within a range.',
  parameters: randomNumberParams,
  execute: async ({ min = 0, max = 1, integer = false }) => {
    if (min >= max) {
      return { error: 'min must be less than max', min, max };
    }
    const value = Math.random() * (max - min) + min;
    const result = integer ? Math.floor(value) : value;
    return { result, min, max, integer };
  },
});

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const NUMERIC = '0123456789';
const HEX = '0123456789abcdef';

const randomStringParams = z.object({
  length: z.number().int().min(1).max(1000).describe('Length of the string to generate'),
  charset: z
    .enum(['alphanumeric', 'alpha', 'numeric', 'hex'])
    .optional()
    .describe('Character set to use (default: alphanumeric)'),
});

export const randomString = tool({
  name: 'random_string',
  description:
    'Generate a cryptographically secure random string. Available charsets: alphanumeric, alpha, numeric, hex.',
  parameters: randomStringParams,
  execute: async ({ length, charset = 'alphanumeric' }) => {
    const chars =
      charset === 'alpha'
        ? ALPHA
        : charset === 'numeric'
          ? NUMERIC
          : charset === 'hex'
            ? HEX
            : ALPHANUMERIC;

    const bytes = randomBytes(length);
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars[bytes[i] % chars.length];
    }
    return { result, length, charset };
  },
});
