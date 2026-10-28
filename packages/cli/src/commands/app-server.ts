/**
 * cogitator app-server - the JSON-RPC app-server on stdio, and the client and schema it speaks
 */

import { Command } from 'commander';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { ACP_AGENT_PRESETS, AcpAgentProvider, resolveAcpAgent } from '@cogitator-ai/acp';
import { Cogitator, LocalWorkspace } from '@cogitator-ai/core';
import {
  JSON_SCHEMA_FILE_NAME,
  SessionHost,
  TYPESCRIPT_CLIENT_FILE_NAME,
  type SessionProvider,
  createAppServer,
  generateJsonSchema,
  generateTypeScriptClient,
  serveStdio,
} from '@cogitator-ai/app-server';
import { CommandError, examplesHelp } from '../utils/cli.js';
import { claimStdout, withSessionStore } from '../utils/headless.js';
import { HEADLESS_AGENT } from './headless.js';
import { cliVersion, createCliAgent, resolveRunRuntime, withPluginServers } from './run.js';

interface AppServerFlags {
  config?: string;
  model?: string;
  acpAgent?: string[];
  sessionPersistence: boolean;
}

/**
 * The external ACP agents `--acp-agent` names, each `name=spec` or a spec whose name is its own:
 * a preset (`claude`, `codex`, `gemini`), `registry:<id>` or a command line. They work in the
 * working directory, their permission requests decided by the rules of its settings files
 */
export async function acpProviders(
  specs: readonly string[],
  workspace: LocalWorkspace
): Promise<{ providers: Record<string, AcpAgentProvider>; close(): Promise<void> }> {
  const providers: Record<string, AcpAgentProvider> = {};
  for (const entry of specs) {
    const split = /^([A-Za-z][\w-]*)=(.+)$/.exec(entry);
    const spec = split ? split[2]! : entry;
    let launch;
    try {
      launch = await resolveAcpAgent(spec, { signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw new CommandError(
        `Could not resolve the ACP agent ${spec}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const name = split
      ? split[1]!
      : ACP_AGENT_PRESETS[spec]
        ? spec
        : spec.startsWith('registry:')
          ? spec.slice('registry:'.length)
          : basename(launch.command);
    if (providers[name])
      throw new CommandError(`Two ACP agents are named ${name}: name them with name=spec`);
    providers[name] = new AcpAgentProvider({
      agent: { command: launch.command, args: launch.args, ...(launch.env && { env: launch.env }) },
      workspace,
      name,
      description: `${launch.name}, an external ACP agent`,
      clientInfo: { name: 'cogitator', version: cliVersion() },
      permissions: { settings: { root: workspace.root, trusted: false } },
      onStderr: (chunk) => process.stderr.write(`[${name}] ${chunk}`),
      onError: (error) => process.stderr.write(`[${name}] ${error.message}\n`),
    });
  }
  return {
    providers,
    close: async () => {
      await Promise.allSettled(Object.values(providers).map((provider) => provider.close()));
    },
  };
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
  .option(
    '--acp-agent <spec...>',
    'External ACP agents to serve next to the agent: claude, codex, gemini, registry:<id> or a command, as name=spec to name one'
  )
  .option('--no-session-persistence', 'Keep threads in this process only')
  .addCommand(generateTsCommand)
  .addCommand(generateJsonSchemaCommand)
  .addHelpText(
    'after',
    examplesHelp([
      ['cogitator app-server -m ollama/qwen3:8b', 'serve a client on stdin and stdout'],
      ['cogitator app-server -m ollama/qwen3:8b --acp-agent claude', 'Claude Code next to it'],
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
      const workspace = new LocalWorkspace({ root: process.cwd() });
      const external = await acpProviders(options.acpAgent ?? [], workspace);
      const providers: Record<string, SessionProvider> = external.providers;
      const cogitator = new Cogitator(withPluginServers(stored));
      const host = new SessionHost({
        cogitator,
        agents: { [HEADLESS_AGENT]: createCliAgent(model) },
        providers,
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
        await external.close();
        await workspace.dispose();
        await cogitator.close().catch(() => {});
      }
    } finally {
      stdout.restore();
    }
  });
