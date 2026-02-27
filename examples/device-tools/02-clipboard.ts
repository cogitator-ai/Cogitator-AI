import { tool } from '@cogitator-ai/core';
import { z } from 'zod';
import { execSync } from 'node:child_process';

export const readClipboardTool = tool({
  name: 'read_clipboard',
  description: 'Read the current text content from the system clipboard',
  parameters: z.object({}),
  execute: async () => {
    const platform = process.platform;

    let text: string;
    if (platform === 'darwin') {
      text = execSync('pbpaste', { encoding: 'utf-8' });
    } else if (platform === 'linux') {
      text = execSync('xclip -selection clipboard -o', { encoding: 'utf-8' });
    } else {
      throw new Error(`Clipboard read not supported on ${platform}`);
    }

    return { text, length: text.length };
  },
});

export const writeClipboardTool = tool({
  name: 'write_clipboard',
  description: 'Write text to the system clipboard',
  parameters: z.object({
    text: z.string().describe('The text to copy to clipboard'),
  }),
  execute: async ({ text }) => {
    const platform = process.platform;

    if (platform === 'darwin') {
      execSync('pbcopy', { input: text });
    } else if (platform === 'linux') {
      execSync('xclip -selection clipboard', { input: text });
    } else {
      throw new Error(`Clipboard write not supported on ${platform}`);
    }

    return { copied: true, length: text.length };
  },
});
