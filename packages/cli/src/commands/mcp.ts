import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tool } from '@cogitator-ai/core';
import { MCPServer } from '@cogitator-ai/mcp';
import type { Tool } from '@cogitator-ai/types';
import { z } from 'zod';
import {
  loadDocsIndex,
  locateDocs,
  readDoc,
  searchDocs,
  slugOf,
  type DocsIndex,
} from '../utils/docs.js';
import { runDoctor } from '../utils/doctor.js';
import { inspectRegistry } from '../utils/registry.js';
import { examplesHelp } from '../utils/cli.js';

/** The `cogitator` field create-cogitator-app writes to package.json, when the project has one. */
function scaffoldManifest(projectDir: string): unknown {
  const path = join(projectDir, 'package.json');
  if (!existsSync(path)) return undefined;
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
  return typeof manifest === 'object' && manifest !== null && 'cogitator' in manifest
    ? manifest.cogitator
    : undefined;
}

/**
 * The tools a coding agent (Claude Code, Cursor, Codex) gets for a Cogitator
 * project: the docs of the installed version, what the project registers, and
 * whether it can run. Nothing here calls a model or changes a file.
 */
export function projectTools(projectDir: string): Tool[] {
  let docs: DocsIndex | undefined;
  const loadDocs = () => (docs ??= loadDocsIndex(locateDocs(projectDir)));

  const search = tool({
    name: 'search_docs',
    description:
      'Search the Cogitator documentation of the version this project installed. Use it before writing Cogitator code: APIs change faster than training data. Returns pages with the best matching passage; read one with read_doc.',
    parameters: z.object({
      query: z
        .string()
        .min(1)
        .describe('What to look for, such as "tool approvals" or "WorkflowBuilder"'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe('How many pages to return, 8 by default'),
    }),
    sideEffects: [],
    execute: async ({ query, limit }) => {
      const index = loadDocs();
      const hits = searchDocs(index, query, limit);
      if (hits.length === 0) {
        return `No page of the Cogitator ${index.version} docs matches "${query}". Try other words, or read_doc index.md for the list of pages.`;
      }
      return hits
        .map((hit, i) => {
          const target = hit.heading ? `${hit.path}#${slugOf(hit.heading)}` : hit.path;
          return `${i + 1}. ${hit.title} (${hit.section}): read_doc "${target}"\n   ${hit.snippet}`;
        })
        .join('\n');
    },
  });

  const read = tool({
    name: 'read_doc',
    description:
      'Read a page of the Cogitator docs as Markdown. "index.md" lists every page; "core/agents.md#agentconfig" returns one section of a page.',
    parameters: z.object({
      path: z
        .string()
        .min(1)
        .describe('A page path from search_docs or index.md, optionally with #section'),
    }),
    sideEffects: [],
    execute: async ({ path }) => readDoc(loadDocs(), path),
  });

  const inspect = tool({
    name: 'inspect_project',
    description:
      'Describe this Cogitator project: the agents (model, instructions, tools with their argument schemas), workflows (nodes and edges) and swarms registered in src/cogitator.ts, and how the project was scaffolded. Loads the current code in a separate process.',
    parameters: z.object({}),
    sideEffects: [],
    execute: async () => {
      const registry = await inspectRegistry(projectDir);
      return JSON.stringify({ scaffold: scaffoldManifest(projectDir), ...registry }, null, 2);
    },
  });

  const check = tool({
    name: 'check_project',
    description:
      'Run cogitator doctor: Node version, installed packages, cogitator.yml, environment variables and keys, services and models. With online, it also connects to the services and the model provider.',
    parameters: z.object({
      online: z
        .boolean()
        .optional()
        .describe('Connect to services and the provider, false by default'),
    }),
    sideEffects: ['network'],
    execute: async ({ online }) => {
      const checks = await runDoctor({
        projectDir,
        env: process.env,
        nodeVersion: process.version,
        probe: online === true,
      });
      return JSON.stringify({ ok: checks.every((c) => c.status !== 'fail'), checks }, null, 2);
    },
  });

  return [search, read, inspect, check];
}

/**
 * The project a server started in `start` serves: the nearest directory at or
 * above it with a registry or a scaffold manifest, so a coding agent that
 * starts the server in a subdirectory still gets the project.
 */
export function findProjectRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'src', 'cogitator.ts')) || scaffoldManifest(dir) !== undefined)
      return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

export function createProjectMcpServer(projectDir: string, version: string): MCPServer {
  const server = new MCPServer({ name: 'cogitator', version, transport: 'stdio', logging: false });
  server.registerTools(projectTools(projectDir));
  return server;
}

export const mcpCommand = new Command('mcp')
  .description('Serve the Cogitator docs and this project to a coding agent over MCP (stdio)')
  .addHelpText(
    'after',
    [
      examplesHelp([
        ['cogitator mcp', 'serve the project in this directory over stdio'],
        ['cogitator mcp --project ~/code/bot', 'serve another project'],
      ]),
      '',
      'Coding agents start it themselves: projects created with --agent claude, cursor',
      'or codex have it in .mcp.json, .cursor/mcp.json or .codex/config.toml.',
      'Tools: search_docs, read_doc, inspect_project, check_project.',
    ].join('\n')
  )
  .action(async (options: { project?: string }) => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')
    ) as { version: string };
    const server = createProjectMcpServer(
      findProjectRoot(options.project ?? process.cwd()),
      manifest.version
    );
    await server.start();
    const stop = () => {
      void server.stop().finally(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.stdin.once('end', stop);
  });
