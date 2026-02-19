import type { Agent as IAgent, Tool } from '@cogitator-ai/types';
import type { AgentCard, AgentSkill, AgentProvider, A2ACapabilities } from './types.js';

export interface AgentCardOptions {
  url: string;
  capabilities?: Partial<A2ACapabilities>;
  provider?: AgentProvider;
}

function toolToSkill(tool: Tool): AgentSkill {
  return {
    id: tool.name,
    name: tool.name,
    description: tool.description,
    inputModes: ['text/plain', 'application/json'],
    outputModes: ['text/plain', 'application/json'],
  };
}

export function generateAgentCard(agent: IAgent, options: AgentCardOptions): AgentCard {
  const capabilities: A2ACapabilities = {
    streaming: true,
    pushNotifications: false,
    ...options.capabilities,
  };

  const card: AgentCard = {
    name: agent.name,
    description: agent.config.description,
    url: options.url,
    version: '0.3',
    capabilities,
    skills: agent.tools.map(toolToSkill),
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain', 'application/json'],
  };

  if (options.provider) {
    card.provider = options.provider;
  }

  return card;
}
