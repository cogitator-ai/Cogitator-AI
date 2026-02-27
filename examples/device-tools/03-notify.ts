import { tool } from '@cogitator-ai/core';
import { z } from 'zod';
import { execSync } from 'node:child_process';

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
      const soundPart = sound ? 'sound name "default"' : '';
      const script = `display notification "${escape(message)}" with title "${escape(title)}" ${soundPart}`;
      execSync(`osascript -e '${script}'`);
    } else if (platform === 'linux') {
      execSync(`notify-send "${escape(title)}" "${escape(message)}"`);
    } else {
      throw new Error(`Notifications not supported on ${platform}`);
    }

    return { sent: true, title, message };
  },
});

function escape(str: string): string {
  return str.replace(/'/g, "'\\''").replace(/"/g, '\\"');
}
