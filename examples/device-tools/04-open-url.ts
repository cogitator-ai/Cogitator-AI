import { tool } from '@cogitator-ai/core';
import { z } from 'zod';
import { execFileSync } from 'node:child_process';

export const openUrlTool = tool({
  name: 'open_url',
  description: 'Open a URL in the default web browser',
  parameters: z.object({
    url: z
      .string()
      .url()
      .refine((value) => /^https?:$/.test(new URL(value).protocol), 'Only http(s) URLs')
      .describe('The http(s) URL to open'),
  }),
  execute: async ({ url }) => {
    const platform = process.platform;

    if (platform === 'darwin') {
      execFileSync('open', [url]);
    } else if (platform === 'linux') {
      execFileSync('xdg-open', [url]);
    } else {
      throw new Error(`URL opening not supported on ${platform}`);
    }

    return { opened: true, url };
  },
});
