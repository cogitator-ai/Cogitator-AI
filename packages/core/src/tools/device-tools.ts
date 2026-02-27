import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir, platform, arch, hostname, uptime, totalmem, freemem } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { tool } from '../tool';
import type { Tool } from '@cogitator-ai/types';

const execPromise = promisify(execCallback);

const clipboardRead = tool({
  name: 'clipboard_read',
  description: 'Read text content from the system clipboard',
  parameters: z.object({}),
  execute: async () => {
    const cmd = platform() === 'darwin' ? 'pbpaste' : 'xclip -selection clipboard -o';
    const { stdout } = await execPromise(cmd, { timeout: 5000 });
    return { content: stdout };
  },
});

const clipboardWrite = tool({
  name: 'clipboard_write',
  description: 'Write text content to the system clipboard',
  parameters: z.object({
    text: z.string().describe('Text to write to clipboard'),
  }),
  execute: async ({ text }) => {
    const cmd = platform() === 'darwin' ? 'pbcopy' : 'xclip -selection clipboard';
    await new Promise<void>((resolve, reject) => {
      const proc = execCallback(cmd, { timeout: 5000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
      proc.stdin?.write(text);
      proc.stdin?.end();
    });
    return { success: true, length: text.length };
  },
});

const systemInfo = tool({
  name: 'system_info',
  description:
    'Get system information: OS, platform, architecture, hostname, uptime, and memory usage',
  parameters: z.object({}),
  execute: async () => {
    const total = totalmem();
    const free = freemem();
    return {
      platform: platform(),
      arch: arch(),
      hostname: hostname(),
      uptimeSeconds: uptime(),
      memory: {
        totalMB: Math.round(total / 1024 / 1024),
        freeMB: Math.round(free / 1024 / 1024),
        usedMB: Math.round((total - free) / 1024 / 1024),
        usagePercent: Math.round(((total - free) / total) * 100),
      },
    };
  },
});

const screenshot = tool({
  name: 'screenshot',
  description:
    'Take a screenshot of the screen (macOS only). Returns the path to the saved image file.',
  parameters: z.object({
    region: z
      .object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      })
      .optional()
      .describe('Capture a specific region instead of the full screen'),
  }),
  execute: async ({ region }) => {
    if (platform() !== 'darwin') {
      return { error: 'Screenshot is only supported on macOS' };
    }

    const filename = `screenshot-${Date.now()}.png`;
    const filepath = join(tmpdir(), filename);

    let cmd = `screencapture -x "${filepath}"`;
    if (region) {
      cmd = `screencapture -x -R${region.x},${region.y},${region.width},${region.height} "${filepath}"`;
    }

    await execPromise(cmd, { timeout: 10000 });
    return { path: filepath, filename };
  },
});

export function createDeviceTools(): Tool[] {
  return [clipboardRead, clipboardWrite, systemInfo, screenshot];
}
