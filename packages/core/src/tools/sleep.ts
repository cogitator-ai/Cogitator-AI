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
  execute: async ({ ms }, context) => {
    const start = Date.now();
    const completed = await new Promise<boolean>((resolve) => {
      if (context.signal.aborted) {
        resolve(false);
        return;
      }

      const onAbort = () => {
        clearTimeout(timeout);
        resolve(false);
      };
      const timeout = setTimeout(() => {
        context.signal.removeEventListener('abort', onAbort);
        resolve(true);
      }, ms);

      context.signal.addEventListener('abort', onAbort, { once: true });
    });
    const actual = Date.now() - start;
    if (!completed) {
      return { error: 'Sleep aborted', slept: actual, requested: ms };
    }
    return { slept: actual, requested: ms };
  },
});
