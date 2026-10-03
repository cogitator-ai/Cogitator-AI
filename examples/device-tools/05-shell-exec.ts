import { tool } from '@cogitator-ai/core';
import { z } from 'zod';
import { execFileSync } from 'node:child_process';

const ALLOWED_COMMANDS = new Set([
  'ls',
  'pwd',
  'whoami',
  'date',
  'uptime',
  'df',
  'du',
  'cat',
  'head',
  'tail',
  'wc',
  'sort',
  'uniq',
  'grep',
  'which',
  'echo',
  'uname',
  'hostname',
  'ping',
  'dig',
  'nslookup',
  'ps',
  'free',
]);

export const shellExecTool = tool({
  name: 'shell_exec',
  description:
    'Run a command on the host machine. Only a predefined set of read-only commands is allowed; arguments are passed as-is, without a shell, so pipes, redirects and variables have no effect.',
  parameters: z.object({
    command: z.string().describe('The command and its space-separated arguments'),
    timeout: z.number().default(10000).describe('Timeout in milliseconds (default: 10s)'),
  }),
  execute: async ({ command, timeout }) => {
    const parts = command.trim().split(/\s+/);
    const baseCmd = parts[0];

    if (!baseCmd || !ALLOWED_COMMANDS.has(baseCmd)) {
      return {
        error: `Command "${baseCmd}" is not in the allowlist`,
        allowed: [...ALLOWED_COMMANDS].sort(),
      };
    }

    try {
      const output = execFileSync(baseCmd, parts.slice(1), {
        encoding: 'utf-8',
        timeout,
        maxBuffer: 1024 * 1024,
      });
      return { output: output.trim(), exitCode: 0 };
    } catch (err) {
      const execErr = err as { status?: number; stdout?: string; stderr?: string };
      return {
        output: execErr.stdout?.trim() ?? '',
        error: execErr.stderr?.trim() ?? 'Command failed',
        exitCode: execErr.status ?? 1,
      };
    }
  },
});
