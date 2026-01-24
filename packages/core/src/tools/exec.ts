/**
 * Exec tool - execute shell commands
 */

import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { tool } from '../tool';

const execPromise = promisify(execCallback);

const execParams = z.object({
  command: z.string().describe('The shell command to execute'),
  cwd: z.string().optional().describe('Working directory for the command'),
  timeout: z
    .number()
    .int()
    .min(100)
    .max(300000)
    .optional()
    .describe('Command timeout in milliseconds (default: 30000, max: 300000 = 5 minutes)'),
  env: z.record(z.string(), z.string()).optional().describe('Additional environment variables'),
});

export const exec = tool({
  name: 'exec',
  description:
    'Execute a shell command. Returns stdout, stderr, and exit code. Use with caution - this can modify the system.',
  parameters: execParams,
  sideEffects: ['process', 'filesystem', 'network'],
  requiresApproval: true,
  sandbox: {
    type: 'docker',
    image: 'cogitator/sandbox:base',
    resources: {
      memory: '256MB',
      pidsLimit: 100,
    },
    network: {
      mode: 'none',
    },
    timeout: 30_000,
  },
  execute: async ({ command, cwd, timeout = 30000, env = {} }) => {
    try {
      const { stdout, stderr } = await execPromise(command, {
        cwd,
        timeout,
        env: { ...process.env, ...env },
        maxBuffer: 10 * 1024 * 1024,
      });

      const maxSize = 50000;
      const truncatedStdout = stdout.length > maxSize;
      const truncatedStderr = stderr.length > maxSize;

      return {
        stdout: truncatedStdout ? stdout.slice(0, maxSize) : stdout,
        stderr: truncatedStderr ? stderr.slice(0, maxSize) : stderr,
        exitCode: 0,
        truncatedStdout,
        truncatedStderr,
        command,
      };
    } catch (err) {
      const error = err as Error & {
        code?: number;
        killed?: boolean;
        stdout?: string;
        stderr?: string;
      };

      if (error.killed) {
        return {
          error: `Command timed out after ${timeout.toString()}ms`,
          command,
          timeout,
        };
      }

      if (error.stdout !== undefined || error.stderr !== undefined) {
        const maxSize = 50000;
        return {
          stdout: (error.stdout || '').slice(0, maxSize),
          stderr: (error.stderr || '').slice(0, maxSize),
          exitCode: error.code || 1,
          command,
        };
      }

      return {
        error: error.message,
        command,
      };
    }
  },
});
