import type { Agent, SwarmAgent, SwarmAgentMetadata, SwarmConfig } from '@cogitator-ai/types';

interface AgentEntry {
  agent: Agent;
  metadata: SwarmAgentMetadata;
}

function stageMetadata(stage: { name: string; gate?: boolean }): SwarmAgentMetadata {
  return { custom: { stageName: stage.name, isGate: stage.gate } };
}

/**
 * Collect every agent referenced by a swarm config together with the metadata implied by
 * the slot it was configured in. Explicit `agentMetadata` entries override slot defaults.
 */
export function collectSwarmAgentEntries(config: SwarmConfig): AgentEntry[] {
  const entries: AgentEntry[] = [];

  if (config.supervisor) {
    entries.push({ agent: config.supervisor, metadata: { role: 'supervisor', priority: 100 } });
  }

  for (const worker of config.workers ?? []) {
    entries.push({ agent: worker, metadata: { role: 'worker', priority: 50 } });
  }

  for (const agent of config.agents ?? []) {
    entries.push({ agent, metadata: {} });
  }

  if (config.moderator) {
    entries.push({ agent: config.moderator, metadata: { role: 'moderator', priority: 90 } });
  }

  if (config.router) {
    entries.push({ agent: config.router, metadata: { role: 'router', priority: 95 } });
  }

  for (const stage of config.stages ?? []) {
    entries.push({ agent: stage.agent, metadata: stageMetadata(stage) });
  }

  for (const stage of config.pipeline?.stages ?? []) {
    entries.push({ agent: stage.agent, metadata: stageMetadata(stage) });
  }

  const byName = new Map<string, AgentEntry>();
  for (const entry of entries) {
    const existing = byName.get(entry.agent.name);
    if (existing && existing.agent !== entry.agent) {
      throw new Error(
        `Duplicate agent name '${entry.agent.name}' in swarm '${config.name}': agent names must be unique`
      );
    }
    if (!existing) {
      byName.set(entry.agent.name, entry);
    }
  }

  return Array.from(byName.values()).map(({ agent, metadata }) => {
    const explicit = config.agentMetadata?.[agent.name];
    if (!explicit) return { agent, metadata };
    return {
      agent,
      metadata: {
        ...metadata,
        ...explicit,
        custom:
          metadata.custom || explicit.custom
            ? { ...metadata.custom, ...explicit.custom }
            : undefined,
      },
    };
  });
}

export function buildSwarmAgents(config: SwarmConfig): Map<string, SwarmAgent> {
  const agents = new Map<string, SwarmAgent>();
  for (const { agent, metadata } of collectSwarmAgentEntries(config)) {
    agents.set(agent.name, {
      agent,
      metadata,
      state: 'idle',
      messageCount: 0,
      tokenCount: 0,
    });
  }
  return agents;
}
