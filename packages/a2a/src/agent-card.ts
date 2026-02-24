import { createHmac, timingSafeEqual } from 'node:crypto';
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

export interface AgentCardSigningOptions {
  algorithm?: 'hmac-sha256';
  secret: string;
}

export function signAgentCard(
  card: AgentCard,
  options: AgentCardSigningOptions
): AgentCard & { signature: string } {
  const algorithm = options.algorithm ?? 'hmac-sha256';
  const payload = JSON.stringify(card, Object.keys(card).sort());
  const signature = createHmac('sha256', options.secret).update(payload).digest('hex');
  return { ...card, signature: `${algorithm}:${signature}` };
}

export function verifyAgentCardSignature(
  card: AgentCard & { signature?: string },
  secret: string
): boolean {
  if (!card.signature) return false;
  const colonIdx = card.signature.indexOf(':');
  if (colonIdx === -1) return false;
  const algorithm = card.signature.slice(0, colonIdx);
  const sig = card.signature.slice(colonIdx + 1);
  if (algorithm !== 'hmac-sha256' || !sig) return false;
  const { signature: _, ...cardWithoutSig } = card;
  const payload = JSON.stringify(cardWithoutSig, Object.keys(cardWithoutSig).sort());
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  const sigBuf = Buffer.from(sig, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(sigBuf, expectedBuf);
}
