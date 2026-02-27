import { tool } from '@cogitator-ai/core';
import { z } from 'zod';
import { execSync } from 'node:child_process';

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
  'find',
  'which',
  'echo',
  'env',
  'uname',
  'hostname',
  'ping',
  'curl',
  'wget',
  'dig',
  'nslookup',
  'ps',
  'top',
  'htop',
  'free',
]);

export const shellExecTool = tool({
  name: 'shell_exec',
  description:
    'Execute a shell command on the host machine. Only a predefined set of safe, read-only commands are allowed.',
  parameters: z.object({
    command: z.string().describe('The shell command to execute'),
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

    if (
      command.includes('|') ||
      command.includes(';') ||
      command.includes('&&') ||
      command.includes('`') ||
      command.includes('$(')
    ) {
      return {
        error: 'Pipes and command chaining are not allowed for security reasons',
      };
    }

    try {
      const output = execSync(command, {
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
