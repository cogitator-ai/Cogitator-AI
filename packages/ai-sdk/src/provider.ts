import type { Cogitator, Agent } from '@cogitator-ai/core';
import { defaultSpecificationVersion } from './ai-version.js';
import { AgentLanguageModelV1 } from './language-model-v1.js';
import {
  AgentLanguageModelV2,
  AgentLanguageModelV3,
  AgentLanguageModelV4,
} from './language-model.js';
import type {
  CogitatorLanguageModel,
  CogitatorModelOptions,
  CogitatorProvider,
  CogitatorProviderConfig,
  CogitatorProviderOptions,
  CogitatorSpecificationVersion,
  DefaultSpecificationVersion,
} from './types.js';

function createLanguageModel<V extends CogitatorSpecificationVersion>(
  version: V,
  cogitator: Cogitator,
  agent: Agent,
  agentName: string,
  options: CogitatorProviderOptions
): CogitatorLanguageModel<V>;
function createLanguageModel(
  version: CogitatorSpecificationVersion,
  cogitator: Cogitator,
  agent: Agent,
  agentName: string,
  options: CogitatorProviderOptions
): CogitatorLanguageModel<CogitatorSpecificationVersion> {
  switch (version) {
    case 'v1':
      return new AgentLanguageModelV1(cogitator, agent, agentName, options);
    case 'v2':
      return new AgentLanguageModelV2(cogitator, agent, agentName, options);
    case 'v3':
      return new AgentLanguageModelV3(cogitator, agent, agentName, options);
    case 'v4':
      return new AgentLanguageModelV4(cogitator, agent, agentName, options);
    default:
      throw new Error(`Unsupported AI SDK specification version: ${String(version)}`);
  }
}

function buildAgentMap(
  agents: Agent[] | Map<string, Agent> | Record<string, Agent>
): Map<string, Agent> {
  if (agents instanceof Map) return agents;
  if (Array.isArray(agents)) {
    const map = new Map<string, Agent>();
    for (const agent of agents) {
      map.set(agent.name, agent);
    }
    return map;
  }
  return new Map(Object.entries(agents));
}

/**
 * Create an AI SDK provider that resolves Cogitator agents by name.
 *
 * Models implement the specification of the installed `ai` package (ai@4 → v1, ai@5 → v2,
 * ai@6 → v3, ai@7 → v4) unless `specificationVersion` selects one explicitly.
 */
export function createCogitatorProvider<
  V extends CogitatorSpecificationVersion = DefaultSpecificationVersion,
>(cogitator: Cogitator, config: CogitatorProviderConfig<V>): CogitatorProvider<V> {
  const agentMap = buildAgentMap(config.agents);
  const version = config.specificationVersion ?? defaultSpecificationVersion();

  const languageModel = (
    agentName: string,
    options: CogitatorProviderOptions = {}
  ): CogitatorLanguageModel<V> => {
    const agent = agentMap.get(agentName);
    if (!agent) {
      throw new Error(
        `Agent "${agentName}" not found. Available agents: ${[...agentMap.keys()].join(', ')}`
      );
    }
    return createLanguageModel(version as V, cogitator, agent, agentName, options);
  };

  return Object.assign(languageModel, { languageModel });
}

/**
 * Expose a Cogitator agent as an AI SDK language model.
 *
 * The model implements the specification of the installed `ai` package (ai@4 → v1, ai@5 → v2,
 * ai@6 → v3, ai@7 → v4, `'v2'` when `ai` cannot be resolved); `specificationVersion` overrides it.
 */
export function cogitatorModel<
  V extends CogitatorSpecificationVersion = DefaultSpecificationVersion,
>(
  cogitator: Cogitator,
  agent: Agent,
  options: CogitatorModelOptions<V> = {}
): CogitatorLanguageModel<V> {
  const { specificationVersion, ...settings } = options;
  return createLanguageModel(
    (specificationVersion ?? defaultSpecificationVersion()) as V,
    cogitator,
    agent,
    agent.name,
    settings
  );
}
