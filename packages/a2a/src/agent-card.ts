import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Agent as IAgent, Tool } from '@cogitator-ai/types';
import type {
  AgentCard,
  AgentCardSignature,
  AgentSkill,
  AgentProvider,
  A2ACapabilities,
} from './types.js';
import { A2A_PROTOCOL_VERSION } from './types.js';

export interface AgentCardOptions {
  /** Absolute URL of the agent's JSON-RPC endpoint */
  url: string;
  capabilities?: Partial<A2ACapabilities>;
  provider?: AgentProvider;
  /** The agent's version (default: '1.0.0') */
  version?: string;
  supportsAuthenticatedExtendedCard?: boolean;
}

function toolToSkill(tool: Tool): AgentSkill {
  return {
    id: tool.name,
    name: tool.name,
    description: tool.description,
    tags: ['tool'],
    inputModes: ['text/plain', 'application/json'],
    outputModes: ['text/plain', 'application/json'],
  };
}

/**
 * The A2A v0.3 Agent Card of an agent. It names the agent, its description (never its
 * instructions) and its tools as skills, and declares JSON-RPC at `url` as its transport.
 */
export function generateAgentCard(agent: IAgent, options: AgentCardOptions): AgentCard {
  const capabilities: A2ACapabilities = {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: false,
    ...options.capabilities,
  };

  const card: AgentCard = {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: agent.name,
    description: agent.config.description ?? agent.name,
    url: options.url,
    preferredTransport: 'JSONRPC',
    additionalInterfaces: [{ transport: 'JSONRPC', url: options.url }],
    version: options.version ?? '1.0.0',
    capabilities,
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: agent.tools.map(toolToSkill),
  };

  if (options.provider) {
    card.provider = options.provider;
  }
  if (options.supportsAuthenticatedExtendedCard) {
    card.supportsAuthenticatedExtendedCard = true;
  }

  return card;
}

export interface AgentCardSigningOptions {
  /** HMAC SHA-256; `hmac-sha256` is the name earlier versions used */
  algorithm?: 'HS256' | 'hmac-sha256';
  secret: string;
}

/**
 * JSON canonicalization (RFC 8785): object keys sorted by UTF-16 code units, no whitespace,
 * values serialized as JSON. Undefined members are left out as JSON.stringify does.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${members.join(',')}}`;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

const PROTECTED_HEADER = base64url(JSON.stringify({ alg: 'HS256', typ: 'JOSE' }));

function unsignedCard(card: AgentCard): AgentCard {
  const { signatures: _signatures, ...rest } = card;
  return rest;
}

function hs256(protectedHeader: string, card: AgentCard, secret: string): Buffer {
  const signingInput = `${protectedHeader}.${base64url(canonicalJson(unsignedCard(card)))}`;
  return createHmac('sha256', secret).update(signingInput).digest();
}

/**
 * The card with a JWS signature (RFC 7515, HS256, detached payload) over its canonical JSON
 * (RFC 8785, without `signatures`) in `signatures`, as A2A v0.3 specifies.
 */
export function signAgentCard(card: AgentCard, options: AgentCardSigningOptions): AgentCard {
  const signature: AgentCardSignature = {
    protected: PROTECTED_HEADER,
    signature: base64url(hs256(PROTECTED_HEADER, card, options.secret)),
  };
  return { ...unsignedCard(card), signatures: [signature] };
}

function parseProtectedHeader(encoded: string): { alg?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as { alg?: unknown }) : null;
  } catch {
    return null;
  }
}

/** Whether one of the card's HS256 signatures was made with `secret` over this exact card. */
export function verifyAgentCardSignature(card: AgentCard, secret: string): boolean {
  for (const signature of card.signatures ?? []) {
    if (parseProtectedHeader(signature.protected)?.alg !== 'HS256') continue;
    const expected = hs256(signature.protected, card, secret);
    const actual = Buffer.from(signature.signature, 'base64url');
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) return true;
  }
  return false;
}
