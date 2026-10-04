/**
 * Shared setup of the fixture servers that run outside Node (Bun, Deno): a Cogitator on the
 * OpenRouter backend with the same agents the in-process servers expose.
 */
import { Cogitator, OpenAIBackend, type Agent } from '@cogitator-ai/core';
import { createServerAgents } from '../../src/stages/servers/agent.ts';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface FixtureRuntime {
  cogitator: Cogitator;
  agents: Record<string, Agent>;
}

/** Reads the key and the model the gauntlet passes in and builds the runtime. */
export function createFixtureRuntime(env: {
  apiKey: string | undefined;
  model: string | undefined;
}): FixtureRuntime {
  if (!env.apiKey) throw new Error('OPENROUTER_API_KEY is not set');
  if (!env.model) throw new Error('GAUNTLET_SERVER_MODEL is not set');
  const cogitator = new Cogitator({
    llm: {
      defaultModel: env.model,
      backends: {
        openrouter: new OpenAIBackend({
          apiKey: env.apiKey,
          baseUrl: OPENROUTER_BASE_URL,
          provider: 'openrouter',
        }),
      },
    },
  });
  return { cogitator, agents: createServerAgents(env.model) };
}

/** The line the gauntlet waits for before it sends requests. */
export function announce(port: number, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ready: true, port, ...extra }));
}
