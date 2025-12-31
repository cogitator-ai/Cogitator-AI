/**
 * Code Assistant Example
 *
 * This example demonstrates an agent that can read, write,
 * and execute code with sandboxed execution.
 */

import { Cogitator, Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';

const WORKSPACE_DIR = '/tmp/cogitator-workspace';

const cog = new Cogitator({
  llm: {
    defaultProvider: 'anthropic',
    providers: {
      anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
    },
  },
  sandbox: {
    type: 'docker',
  },
});

const readFile = tool({
  name: 'read_file',
  description: 'Read the contents of a file',
  parameters: z.object({
    path: z.string().describe('File path relative to workspace'),
  }),
  execute: async ({ path: filePath }) => {
    const fullPath = path.join(WORKSPACE_DIR, filePath);
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      return { path: filePath, content, size: content.length };
    } catch (error: any) {
      return { error: `Failed to read file: ${error.message}` };
    }
  },
});

const writeFile = tool({
  name: 'write_file',
  description: 'Write content to a file',
  parameters: z.object({
    path: z.string().describe('File path relative to workspace'),
    content: z.string().describe('Content to write'),
  }),
  sideEffects: ['filesystem'],
  execute: async ({ path: filePath, content }) => {
    const fullPath = path.join(WORKSPACE_DIR, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
    return { path: filePath, written: content.length };
  },
});

const listFiles = tool({
  name: 'list_files',
  description: 'List files in a directory',
  parameters: z.object({
    path: z.string().default('.').describe('Directory path relative to workspace'),
    recursive: z.boolean().default(false),
  }),
  execute: async ({ path: dirPath, recursive }) => {
    const fullPath = path.join(WORKSPACE_DIR, dirPath);
    try {
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      const files = entries.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
      }));
      return { path: dirPath, files };
    } catch (error: any) {
      return { error: `Failed to list files: ${error.message}` };
    }
  },
});

const runCode = tool({
  name: 'run_code',
  description: 'Execute code in a sandboxed environment',
  parameters: z.object({
    language: z.enum(['python', 'javascript', 'typescript']),
    code: z.string().describe('Code to execute'),
  }),
  sideEffects: ['process'],
  sandbox: {
    type: 'docker',
    image: 'cogitator/sandbox:python',
    resources: {
      memory: '256MB',
      cpu: 0.5,
      timeout: '30s',
    },
    network: 'none',
  },
  execute: async ({ language, code }) => {
    console.log(`[Tool] Running ${language} code...`);

    return {
      language,
      stdout: `Execution output for ${language}`,
      stderr: '',
      exitCode: 0,
      executionTime: 123,
    };
  },
});

const runTests = tool({
  name: 'run_tests',
  description: 'Run tests for the codebase',
  parameters: z.object({
    testPath: z.string().optional().describe('Specific test file or directory'),
  }),
  sideEffects: ['process'],
  execute: async ({ testPath }) => {
    console.log(`[Tool] Running tests: ${testPath || 'all'}`);

    return {
      passed: 10,
      failed: 0,
      skipped: 2,
      duration: 1500,
      results: [
        { name: 'test_addition', status: 'passed' },
        { name: 'test_subtraction', status: 'passed' },
      ],
    };
  },
});

const codeAssistant = new Agent({
  name: 'code-assistant',
  model: 'claude-3-5-sonnet',
  instructions: `You are an expert software engineer assistant. You can:

    1. Read and analyze code files
    2. Write and modify code
    3. Execute code to test it
    4. Run tests to verify correctness

    When writing code:
    - Follow best practices and conventions
    - Include appropriate error handling
    - Write clean, readable code
    - Add comments only where necessary

    When modifying code:
    - First read the existing code
    - Make minimal, targeted changes
    - Verify changes work by running them

    Always explain what you're doing and why.`,
  tools: [readFile, writeFile, listFiles, runCode, runTests],
  temperature: 0.2,
  maxIterations: 15,
});

async function main() {
  await fs.mkdir(WORKSPACE_DIR, { recursive: true });

  console.log('Starting code assistant example...\n');
  console.log(`Workspace: ${WORKSPACE_DIR}\n`);

  const result = await cog.run(codeAssistant, {
    input: `Create a TypeScript utility module at src/utils/string-utils.ts with the following functions:
    1. capitalize(str) - Capitalize the first letter
    2. truncate(str, maxLength) - Truncate with ellipsis
    3. slugify(str) - Convert to URL-friendly slug

    After creating the file, write a simple test and run it.`,
  });

  console.log('Code Assistant Output:');
  console.log('======================\n');
  console.log(result.output);

  console.log('\nTool calls made:');
  result.toolCalls.forEach((call, i) => {
    console.log(`  ${i + 1}. ${call.name}`);
  });

  console.log(`\nTotal tokens: ${result.usage.totalTokens}`);
  console.log(`Duration: ${result.usage.duration}ms`);

  await cog.close();
}

main().catch(console.error);
