/**
 * cogitator app-server - the JSON-RPC app-server on stdio, and the client and schema it speaks
 */

import { Command } from 'commander';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Cogitator } from '@cogitator-ai/core';
import {
  JSON_SCHEMA_FILE_NAME,
  SessionHost,
  TYPESCRIPT_CLIENT_FILE_NAME,
  createAppServer,
  generateJsonSchema,
  generateTypeScriptClient,
  serveStdio,
} from '@cogitator-ai/app-server';
import { examplesHelp } from '../utils/cli.js';
import { claimStdout, withSessionStore } from '../utils/headless.js';
import { HEADLESS_AGENT } from './headless.js';
import { cliVersion, createCliAgent, resolveRunRuntime, withPluginServers } from './run.js';

interface AppServerFlags {
  config?: string;
  model?: string;
  sessionPersistence: boolean;
}

/** Writes `content` to `fileName` in `outDir`, made when missing, and returns the path */
export function writeGenerated(outDir: string, fileName: string, content: string): string {
  const path = join(resolve(outDir), fileName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

const generateTsCommand = new Command('generate-ts')
  .description('Write the typed TypeScript client of the app-server protocol')
  .requiredOption('--out <dir>', 'Directory to write cogitator-app-server.ts to')
  .action((options: { out: string }) => {
    const path = writeGenerated(
      options.out,
      TYPESCRIPT_CLIENT_FILE_NAME,
      generateTypeScriptClient()
    );
    console.log(path);
  });

const generateJsonSchemaCommand = new Command('generate-json-schema')
  .description('Write the JSON Schema of the app-server protocol')
  .requiredOption('--out <dir>', 'Directory to write cogitator-app-server.schema.json to')
  .action((options: { out: string }) => {
    const path = writeGenerated(
      options.out,
      JSON_SCHEMA_FILE_NAME,
      `${JSON.stringify(generateJsonSchema(), null, 2)}\n`
    );
    console.log(path);
  });

export const appServerCommand = new Command('app-server')
  .description('Serve the JSON-RPC app-server on stdio (NDJSON): threads, turns, reviews')
  .option('-c, --config <path>', 'Config file path (default: ./cogitator.yml)')
  .option('-m, --model <model>', 'Model of the agent (e.g. ollama/qwen3:8b)')
  .option('--no-session-persistence', 'Keep threads in this process only')
  .addCommand(generateTsCommand)
  .addCommand(generateJsonSchemaCommand)
  .addHelpText(
    'after',
    examplesHelp([
      ['cogitator app-server -m ollama/qwen3:8b', 'serve a client on stdin and stdout'],
      ['cogitator app-server generate-ts --out src/gen', 'write the typed client'],
      ['cogitator app-server generate-json-schema --out schema', 'write the JSON Schema'],
    ])
  )
  .action(async (options: AppServerFlags) => {
    const stdout = claimStdout();
    try {
      const { config, model } = await resolveRunRuntime(options);
      const stored = withSessionStore(config, options.sessionPersistence);
      if (
        stored.memory?.adapter === 'sqlite' &&
        stored.memory.sqlite?.path &&
        !config.memory?.adapter
      ) {
        mkdirSync(dirname(stored.memory.sqlite.path), { recursive: true });
      }
      const cogitator = new Cogitator(withPluginServers(stored));
      const host = new SessionHost({
        cogitator,
        agents: { [HEADLESS_AGENT]: createCliAgent(model) },
        exposeErrors: true,
        serverInfo: { name: 'cogitator', version: cliVersion() },
      });
      try {
        await serveStdio(createAppServer(host), {
          input: process.stdin,
          output: process.stdout,
          onError: (error) => process.stderr.write(`app-server: ${error.message}\n`),
        });
      } finally {
        await host.close();
        await cogitator.close().catch(() => {});
      }
    } finally {
      stdout.restore();
    }
  });
