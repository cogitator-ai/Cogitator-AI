import { defineSkill } from '@cogitator-ai/core';
import { screenshotTool } from './01-screenshot.js';
import { readClipboardTool, writeClipboardTool } from './02-clipboard.js';
import { notifyTool } from './03-notify.js';
import { openUrlTool } from './04-open-url.js';
import { shellExecTool } from './05-shell-exec.js';

export default defineSkill({
  name: 'device-tools',
  version: '1.0.0',
  description:
    'Control the host machine: screenshots, clipboard, notifications, URLs, shell commands',
  tools: [
    screenshotTool,
    readClipboardTool,
    writeClipboardTool,
    notifyTool,
    openUrlTool,
    shellExecTool,
  ],
  instructions: `You have access to the user's device. You can:
- Take screenshots (full screen, window, or selection)
- Read from and write to the clipboard
- Send system notifications
- Open URLs in the default browser
- Run safe, read-only shell commands

Always confirm before taking screenshots or executing shell commands.
When using shell_exec, only read-only commands are allowed for safety.`,
});
