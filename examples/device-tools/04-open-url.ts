import { tool } from '@cogitator-ai/core';
import { z } from 'zod';
import { execSync } from 'node:child_process';

export const openUrlTool = tool({
  name: 'open_url',
  description: 'Open a URL in the default web browser',
  parameters: z.object({
    url: z.string().url().describe('The URL to open'),
  }),
  execute: async ({ url }) => {
    const platform = process.platform;

    if (platform === 'darwin') {
      execSync(`open "${url}"`);
    } else if (platform === 'linux') {
      execSync(`xdg-open "${url}"`);
    } else {
      throw new Error(`URL opening not supported on ${platform}`);
    }

    return { opened: true, url };
  },
});
