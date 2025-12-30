/**
 * UUID tool - generates UUID v4
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tool } from '../tool.js';

const uuidParams = z.object({
  count: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Number of UUIDs to generate (default: 1, max: 100)'),
});

export const uuid = tool({
  name: 'uuid',
  description: 'Generate one or more UUID v4 identifiers.',
  parameters: uuidParams,
  execute: async ({ count = 1 }) => {
    const uuids = Array.from({ length: count }, () => randomUUID());
    return count === 1 ? { uuid: uuids[0] } : { uuids, count };
  },
});
