/**
 * Hash tool - compute cryptographic hashes
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { tool } from '../tool.js';

const hashParams = z.object({
  data: z.string().describe('The string to hash'),
  algorithm: z
    .enum(['md5', 'sha1', 'sha256', 'sha512'])
    .optional()
    .describe('Hash algorithm (default: sha256)'),
  encoding: z
    .enum(['hex', 'base64'])
    .optional()
    .describe('Output encoding (default: hex)'),
});

export const hash = tool({
  name: 'hash',
  description:
    'Compute a cryptographic hash of a string. Supports md5, sha1, sha256, sha512 algorithms.',
  parameters: hashParams,
  // eslint-disable-next-line @typescript-eslint/require-await
  execute: async ({ data, algorithm = 'sha256', encoding = 'hex' }) => {
    try {
      const result = createHash(algorithm).update(data).digest(encoding);
      return { hash: result, algorithm, encoding };
    } catch (err) {
      return { error: (err as Error).message, algorithm };
    }
  },
});
