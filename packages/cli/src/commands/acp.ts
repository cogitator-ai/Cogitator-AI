/**
 * cogitator acp - a Cogitator coding agent for editors over the Agent Client Protocol (stdio)
 */

import { Command } from 'commander';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { RequestError } from '@agentclientprotocol/sdk';
import { createAcpAgent, serveAcpStdio } from '@cogitator-ai/acp';
import { SessionHost } from '@cogitator-ai/app-server';
import { Cogitator, createHarnessAgent } from '@cogitator-ai/core';
import { examplesHelp } from '../utils/cli.js';
import { claimStdout, withSessionStore } from '../utils/headless.js';
import { listOllamaModels, resolveOllamaUrl } from '../utils/ollama.js';
import { NO_MODEL_HINTS, cliVersion, resolveRunConfig, withPluginServers } from './run.js';

interface AcpFlags {
  config?: string;
  model?: string;
  models?: string[];
  trust?: boolean;
  sessionPersistence: boolean;
}

/** The name of the agent `cogitator acp` serves */
export const ACP_AGENT_NAME = 'coder';

/** Most models of a local Ollama an editor is offered */
const MAX_OFFERED_OLLAMA_MODELS = 20;

/** The models an editor may switch to: the ones named, the agent's, and those Ollama holds */
async function offeredModels(
  model: string | undefined,
  named: readonly string[],
  ollama: { baseUrl?: string; apiKey?: string; headers?: Record<string, string> } | undefined
): Promise<string[]> {
  const models = new Set<string>([...(model ? [model] : []), ...named]);
  if (model === undefined || model.startsWith('ollama/')) {
    const local = await listOllamaModels(resolveOllamaUrl(process.env, ollama?.baseUrl), {
      ...(ollama?.apiKey && { apiKey: ollama.apiKey }),
      ...(ollama?.headers && { headers: ollama.headers }),
      timeoutMs: 2000,
    }).catch(() => []);
    for (const entry of local.slice(0, MAX_OFFERED_OLLAMA_MODELS))
      models.add(`ollama/${entry.name}`);
  }
  return [...models];
}

export const acpCommand = new Command('acp')
  .description(
    'Serve a Cogitator coding agent to an editor over the Agent Client Protocol (stdio): Zed, JetBrains, Neovim, VS Code'
  )
  .option('-c, --config <path>', 'Config file path (default: ./cogitator.yml)')
  .option('-m, --model <model>', 'Model of the agent (e.g. ollama/qwen3:8b)')
  .option('--models <models...>', 'More models a session may switch to')
  .option(
    '--trust',
    "Trust the project: its subagents, commands, hooks and the allow rules of its settings apply, and an 'always' answer is saved to .cogitator/settings.local.json"
  )
  .option('--no-session-persistence', 'Keep sessions in this process only')
  .addHelpText(
    'after',
    examplesHelp([
      ['cogitator acp -m ollama/qwen3:8b', 'what an editor launches'],
      ['cogitator acp -m anthropic/claude-sonnet-5-5 --trust', 'a trusted project'],
    ])
  )
  .action(async (options: AcpFlags) => {
    const stdout = claimStdout();
    try {
      const { config, model } = await resolveRunConfig(options);
      const stored = withSessionStore(config, options.sessionPersistence);
      if (
        stored.memory?.adapter === 'sqlite' &&
        stored.memory.sqlite?.path &&
        !config.memory?.adapter
      ) {
        mkdirSync(dirname(stored.memory.sqlite.path), { recursive: true });
      }
      const trusted = options.trust === true;
      const harness = createHarnessAgent({
        preset: 'coding',
        name: ACP_AGENT_NAME,
        ...(model !== undefined && { model }),
        workspace: false,
        projectRoot: process.cwd(),
        trusted,
        settings: true,
        permissions: {
          rememberIn: trusted ? 'local' : 'session',
          rememberLayers: trusted ? ['session', 'local'] : ['session'],
        },
      });
      const cogitator = new Cogitator(withPluginServers(harness.mergeConfig(stored)));
      const host = new SessionHost({
        cogitator,
        agents: { [ACP_AGENT_NAME]: harness.agent },
        exposeErrors: true,
        serverInfo: { name: 'cogitator', version: cliVersion() },
        runOptions: harness.runOptions,
      });
      const acp = createAcpAgent({
        host,
        cogitator,
        agentInfo: { name: 'cogitator', title: 'Cogitator', version: cliVersion() },
        models: await offeredModels(model, options.models ?? [], config.llm?.providers?.ollama),
        roots: [process.cwd()],
        authenticate: () => {
          if (model === undefined && !config.llm?.defaultModel) {
            throw RequestError.authRequired(
              { hints: NO_MODEL_HINTS },
              'No model is configured and no Ollama models were found'
            );
          }
        },
        onError: (error) => process.stderr.write(`acp: ${error.message}\n`),
      });
      try {
        await serveAcpStdio(acp, { input: process.stdin, output: process.stdout });
      } finally {
        await host.close();
        await cogitator.close().catch(() => {});
        await harness.dispose();
      }
    } finally {
      stdout.restore();
    }
  });
