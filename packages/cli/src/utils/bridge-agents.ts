import {
  HarnessNameSchema,
  RECIPE_HARNESS,
  hostedAdapter,
  type BridgeAdapter,
  type HostedSession,
  type HostedSessionContext,
} from '@cogitator-ai/bridge';
import type { CogitatorConfig } from '@cogitator-ai/core';
import { UsageError } from './cli.js';

/** Names the agents `serve` hosts itself, when no flag does: `qwen=ollama/qwen3-coder,ds=deepseek/deepseek-chat`. */
export const BRIDGE_AGENTS_ENV = 'COGITATOR_BRIDGE_AGENTS';

/** The words that address the harnesses the command line reaches itself. */
const TAKEN: readonly string[] = ['claude', 'claude-code', 'codex', RECIPE_HARNESS, 'auto'];

/** An agent the dispatcher hosts itself: the word it is addressed by, and the model it runs on. */
export interface BridgeAgentSpec {
  /** The word other agents hand it jobs by, such as `qwen` */
  harness: string;
  /** The model, as the runtime names it: `ollama/qwen3-coder:30b`, `deepseek/deepseek-chat` */
  model: string;
}

/**
 * Reads `name=model`: the word an agent is addressed by and the model it runs on.
 *
 * @throws UsageError when the word is missing, is one a harness of the bridge has already, or
 * the model does not name its provider
 */
export function bridgeAgentOf(value: string): BridgeAgentSpec {
  const at = value.indexOf('=');
  const word = at === -1 ? '' : value.slice(0, at).trim();
  const model = at === -1 ? '' : value.slice(at + 1).trim();
  const named = HarnessNameSchema.safeParse(word);
  if (!named.success || !model) {
    throw new UsageError(`"${value}" is not an agent to host: write it as name=model`, [
      'Such as: --agent qwen=ollama/qwen3-coder:30b',
    ]);
  }
  if (TAKEN.includes(named.data)) {
    throw new UsageError(`An agent the bridge hosts cannot be called "${named.data}"`, [
      'That word reaches a harness of its own. Give the agent another, such as its model: qwen, deepseek, glm',
    ]);
  }
  if (!model.includes('/')) {
    throw new UsageError(`The model "${model}" names no provider`, [
      'Write it as provider/model, such as ollama/qwen3-coder:30b or deepseek/deepseek-chat',
    ]);
  }
  return { harness: named.data, model };
}

/**
 * The agents `serve` hosts itself: what the flag names, else `COGITATOR_BRIDGE_AGENTS`.
 *
 * @throws UsageError for an entry that cannot be read, and for two agents under one word
 */
export function bridgeAgentsOf(
  env: NodeJS.ProcessEnv = process.env,
  flag: readonly string[] = []
): BridgeAgentSpec[] {
  const named = flag.length > 0 ? flag : (env[BRIDGE_AGENTS_ENV] ?? '').split(',');
  const specs = named.flatMap((value) => (value.trim() ? [bridgeAgentOf(value.trim())] : []));
  const twice = specs.find(
    (spec, index) => specs.findIndex((other) => other.harness === spec.harness) !== index
  );
  if (twice) throw new UsageError(`Two agents to host are called "${twice.harness}"`);
  return specs;
}

/**
 * The configuration the hosted agents run with: the providers and their keys from the config
 * file a flag or `COGITATOR_CONFIG` names, or the one of the folder `serve` runs in, and from the
 * environment where no file names them.
 *
 * @throws UsageError when the file named cannot be found or read
 */
export async function hostedAgentsConfig(path: string | undefined): Promise<CogitatorConfig> {
  const { findConfig, loadRunConfig } = await import('../commands/run.js');
  const found = findConfig(path);
  if (path && !found) throw new UsageError(`Config file not found: ${path}`);
  try {
    return loadRunConfig(found).config;
  } catch (error) {
    throw new UsageError(
      `Failed to load config: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export interface HostedAgentsOptions {
  /** The configuration of the runtime: the providers and their keys, and what else a run reads */
  config: CogitatorConfig;
  /** Hears what an adapter could not do outside a call */
  onError?: (error: Error) => void;
}

/**
 * Adapters for agents of the Cogitator runtime the dispatcher hosts itself, one harness for each:
 * a coding agent on the model named, with a session of its own for every job. The session works
 * in the folder of its job: it reads freely and changes files there without asking, as the
 * sessions of Claude Code the bridge starts do, and every other call (a command, a file outside
 * the folder) is asked through the bridge, where the rules of whoever handed the job over, or
 * the person, decide. The project of the job is not trusted by the agent itself: its settings
 * files give the agent no leave of their own.
 *
 * A session keeps its thread, so a later letter of its job (an answer to its question, a note)
 * and a later job handed to the same session reach a model that knows what went before. The
 * history lives in the memory the configuration names, and in the process of the dispatcher
 * when it names none: the session lives there too, and both end with it.
 *
 * A turn that fails on the rate limit or the quota of the model's provider tells the bridge, which
 * hands the job to another agent.
 */
export function hostedAgents(
  specs: readonly BridgeAgentSpec[],
  options: HostedAgentsOptions
): BridgeAdapter[] {
  return specs.map((spec) =>
    hostedAdapter({
      harness: spec.harness,
      steer: true,
      open: (context) => openSession(spec, context, options.config),
      ...(options.onError && { onError: options.onError }),
    })
  );
}

async function openSession(
  spec: BridgeAgentSpec,
  context: HostedSessionContext,
  config: CogitatorConfig
): Promise<HostedSession> {
  const { Cogitator, createHarnessAgent } = await import('@cogitator-ai/core');
  const harness = createHarnessAgent({
    preset: 'coding',
    name: spec.harness,
    model: spec.model,
    workspace: context.cwd,
    projectRoot: context.project,
    trusted: false,
    settings: true,
    permissions: { mode: 'acceptEdits' },
  });
  const remembering: CogitatorConfig = config.memory?.adapter
    ? config
    : { ...config, memory: { ...config.memory, adapter: 'memory' } };
  const cogitator = new Cogitator(harness.mergeConfig(remembering));
  const threadId = `bridge-${context.sessionId}`;
  return {
    turn(text, about) {
      const approve = about?.approve;
      const run = cogitator.start(harness.agent, {
        ...harness.runOptions,
        input: text,
        threadId,
        ...(approve && { onApproval: approve }),
      });
      return {
        result: run.result.then((result) => {
          if (result.status === 'paused') {
            throw new Error(
              'the run stopped to wait for an answer nobody gives in a session the bridge hosts'
            );
          }
          return result.output;
        }),
        steer: (message) => run.steer(message),
        followUp: (message) => run.followUp(message),
        abort: (reason) => {
          run.abort(reason);
        },
      };
    },
    async close() {
      await cogitator.close().catch(() => undefined);
      await harness.dispose();
    },
  };
}
