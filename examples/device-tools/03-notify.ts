import { tool } from '@cogitator-ai/core';
import { z } from 'zod';
import { execFileSync } from 'node:child_process';

export const notifyTool = tool({
  name: 'notify',
  description: 'Send a system notification to the user',
  parameters: z.object({
    title: z.string().describe('Notification title'),
    message: z.string().describe('Notification body text'),
    sound: z.boolean().default(true).describe('Play notification sound'),
  }),
  execute: async ({ title, message, sound }) => {
    const platform = process.platform;

    if (platform === 'darwin') {
      const display = `display notification (item 2 of argv) with title (item 1 of argv)${sound ? ' sound name "default"' : ''}`;
      execFileSync('osascript', [
        '-e',
        'on run argv',
        '-e',
        display,
        '-e',
        'end run',
        title,
        message,
      ]);
    } else if (platform === 'linux') {
      execFileSync('notify-send', ['--', title, message]);
    } else {
      throw new Error(`Notifications not supported on ${platform}`);
    }

    return { sent: true, title, message };
  },
});
