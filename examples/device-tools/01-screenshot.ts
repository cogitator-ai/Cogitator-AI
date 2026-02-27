import { tool } from '@cogitator-ai/core';
import { z } from 'zod';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SCREENSHOT_DIR = resolve(process.env.HOME ?? '~', '.cogitator/screenshots');

export const screenshotTool = tool({
  name: 'screenshot',
  description: 'Capture a screenshot of the screen. Returns the file path of the saved screenshot.',
  parameters: z.object({
    region: z
      .enum(['full', 'window', 'selection'])
      .default('full')
      .describe('What to capture: full screen, active window, or interactive selection'),
    filename: z
      .string()
      .optional()
      .describe('Custom filename (without extension). Defaults to timestamp.'),
  }),
  execute: async ({ region, filename }) => {
    if (!existsSync(SCREENSHOT_DIR)) {
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }

    const name = filename ?? `screenshot-${Date.now()}`;
    const filePath = resolve(SCREENSHOT_DIR, `${name}.png`);

    const platform = process.platform;

    if (platform === 'darwin') {
      const flags = region === 'window' ? '-w' : region === 'selection' ? '-s' : '';
      execSync(`screencapture ${flags} "${filePath}"`);
    } else if (platform === 'linux') {
      if (region === 'full') {
        execSync(`import -window root "${filePath}"`);
      } else if (region === 'window') {
        execSync(`import "${filePath}"`);
      } else {
        execSync(`import "${filePath}"`);
      }
    } else {
      throw new Error(`Screenshot not supported on ${platform}`);
    }

    return { path: filePath, captured: true };
  },
});
