/**
 * Sleep tool - pause execution for a specified duration
 */

import { z } from 'zod';
import { tool } from '../tool';

const sleepParams = z.object({
  ms: z
    .number()
    .int()
    .min(0)
    .max(60000)
    .describe('Duration to sleep in milliseconds (max: 60000 = 1 minute)'),
});

export const sleep = tool({
  name: 'sleep',
  description:
    'Pause execution for a specified number of milliseconds. Useful for rate limiting or waiting between operations. Maximum: 60 seconds.',
  parameters: sleepParams,
  execute: async ({ ms }) => {
    const start = Date.now();
    await new Promise((resolve) => setTimeout(resolve, ms));
    const actual = Date.now() - start;
    return { slept: actual, requested: ms };
  },
});
