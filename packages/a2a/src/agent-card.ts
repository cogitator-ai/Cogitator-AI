import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Agent as IAgent, Tool } from '@cogitator-ai/types';
import type {
  AgentCard,
  AgentCardSignature,
  AgentExtension,
  AgentInterface,
  AgentSkill,
  AgentProvider,
  A2ACapabilities,
  SecurityScheme,
} from './types.js';
import { A2A_PROTOCOL_VERSION } from './types.js';
import type { A2AProtocolVersion } from './version.js';
import type {
  V1AgentCard,
  V1AgentCapabilities,
  V1AgentInterface,
  V1AgentSkill,
  V1SecurityScheme,
} from './v1/types.js';
import {
  securityRequirementsFromV1,
  securityRequirementsToV1,
  securitySchemeFromV1,
  securitySchemeToV1,
} from './v1/translate.js';

export interface AgentCardOptions {
  /** Absolute URL of the agent's JSON-RPC endpoint */
  url: string;
  capabilities?: Partial<A2ACapabilities>;
  provider?: AgentProvider;
  /** The agent's version (default: '1.0.0') */
  version?: string;
  supportsAuthenticatedExtendedCard?: boolean;
}

/** One endpoint of an agent: where it is, its binding, the protocol version it speaks. */
export interface AgentCardInterface {
  url: string;
  protocolBinding: 'JSONRPC' | 'HTTP+JSON' | (string & {});
  protocolVersion: A2AProtocolVersion | (string & {});
  /** A2A 1.0: the `tenant` requests to this interface carry */
  tenant?: string;
}

/**
 * What an Agent Card says, apart from the protocol version it says it in. A Cogitator server keeps
 * one model per agent and renders it as an A2A 0.3 card (`toLegacyCard`) or an A2A 1.0 card
 * (`toV1Card`), so both versions advertise the same agent and the same signature covers both.
 */
export interface AgentCardModel {
  name: string;
  description: string;
  version: string;
  provider?: AgentProvider;
  iconUrl?: string;
  documentationUrl?: string;
  capabilities: A2ACapabilities & { extendedAgentCard?: boolean };
  securitySchemes?: Record<string, SecurityScheme>;
  security?: Record<string, string[]>[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
  /** Every interface, in the order clients should prefer them */
  interfaces: AgentCardInterface[];
}

const DEFAULT_MODES = ['text/plain', 'application/json'];

function toolToSkill(tool: Tool): AgentSkill {
  return {
    id: tool.name,
    name: tool.name,
    description: tool.description,
    tags: ['tool'],
    inputModes: [...DEFAULT_MODES],
    outputModes: [...DEFAULT_MODES],
  };
}

/**
 * The skill of an agent without tools: what it does is converse. A2A 1.0 requires a card to list
 * at least one skill.
 */
function conversationSkill(agent: IAgent): AgentSkill {
  return {
    id: 'chat',
    name: agent.name,
    description: agent.config.description ?? agent.name,
    tags: ['chat'],
    inputModes: [...DEFAULT_MODES],
    outputModes: [...DEFAULT_MODES],
  };
}

/** The skills an agent's card lists: its tools, or one conversation skill without tools. */
export function agentSkills(agent: IAgent): AgentSkill[] {
  return agent.tools.length > 0 ? agent.tools.map(toolToSkill) : [conversationSkill(agent)];
}

/**
 * The card model of an agent: its name, description (never its instructions) and its tools as
 * skills. `interfaces` are the endpoints it is served at.
 */
export function buildAgentCardModel(
  agent: IAgent,
  options: {
    interfaces: AgentCardInterface[];
    capabilities?: AgentCardModel['capabilities'];
    provider?: AgentProvider;
    version?: string;
  }
): AgentCardModel {
  return {
    name: agent.name,
    description: agent.config.description ?? agent.name,
    version: options.version ?? '1.0.0',
    ...(options.provider && { provider: options.provider }),
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
      ...options.capabilities,
    },
    defaultInputModes: [...DEFAULT_MODES],
    defaultOutputModes: [...DEFAULT_MODES],
    skills: agentSkills(agent),
    interfaces: options.interfaces,
  };
}

function isLegacyInterface(entry: AgentCardInterface): boolean {
  return entry.protocolVersion.startsWith('0.');
}

/** The interfaces of a model in their A2A 1.0 form. */
export function v1Interfaces(model: Pick<AgentCardModel, 'interfaces'>): V1AgentInterface[] {
  return model.interfaces.map((entry) => ({
    url: entry.url,
    protocolBinding: entry.protocolBinding,
    ...(entry.tenant && { tenant: entry.tenant }),
    protocolVersion: entry.protocolVersion,
  }));
}

/**
 * The A2A 0.3 card of a model: `url` and `preferredTransport` name its first 0.3 interface,
 * `additionalInterfaces` all of them. With `embedInterfaces` every interface of every version is
 * listed in `supportedInterfaces` as well, which makes the hybrid card a Cogitator server serves
 * when the client names no version: an A2A 0.3 client reads the 0.3 fields, an A2A 1.0 client
 * finds its interfaces.
 */
export function toLegacyCard(
  model: AgentCardModel,
  options?: { embedInterfaces?: boolean }
): AgentCard {
  const legacy = model.interfaces.filter(isLegacyInterface);
  const primary = legacy[0] ?? model.interfaces[0];
  const additional: AgentInterface[] = legacy.map((entry) => ({
    transport: entry.protocolBinding,
    url: entry.url,
  }));
  const { extendedAgentCard, extensions, ...capabilities } = model.capabilities;
  const card: AgentCard = {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: model.name,
    description: model.description,
    url: primary?.url ?? '',
    preferredTransport: primary?.protocolBinding ?? 'JSONRPC',
    additionalInterfaces: additional,
    version: model.version,
    capabilities: { ...capabilities, ...(extensions?.length && { extensions }) },
    defaultInputModes: [...model.defaultInputModes],
    defaultOutputModes: [...model.defaultOutputModes],
    skills: model.skills.map((skill) => ({ ...skill })),
  };
  if (model.provider) card.provider = model.provider;
  if (model.iconUrl) card.iconUrl = model.iconUrl;
  if (model.documentationUrl) card.documentationUrl = model.documentationUrl;
  if (model.securitySchemes) card.securitySchemes = model.securitySchemes;
  if (model.security) card.security = model.security;
  if (extendedAgentCard) card.supportsAuthenticatedExtendedCard = true;
  if (options?.embedInterfaces) card.supportedInterfaces = v1Interfaces(model);
  return card;
}

function skillToV1(skill: AgentSkill): V1AgentSkill {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: [...skill.tags],
    ...(skill.examples?.length && { examples: [...skill.examples] }),
    ...(skill.inputModes?.length && { inputModes: [...skill.inputModes] }),
    ...(skill.outputModes?.length && { outputModes: [...skill.outputModes] }),
    ...(skill.security?.length && {
      securityRequirements: securityRequirementsToV1(skill.security),
    }),
  };
}

function skillFromV1(skill: V1AgentSkill): AgentSkill {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: [...skill.tags],
    ...(skill.examples?.length && { examples: [...skill.examples] }),
    ...(skill.inputModes?.length && { inputModes: [...skill.inputModes] }),
    ...(skill.outputModes?.length && { outputModes: [...skill.outputModes] }),
    ...(skill.securityRequirements?.length && {
      security: securityRequirementsFromV1(skill.securityRequirements),
    }),
  };
}

function capabilitiesToV1(capabilities: AgentCardModel['capabilities']): V1AgentCapabilities {
  return {
    ...(capabilities.streaming !== undefined && { streaming: capabilities.streaming }),
    ...(capabilities.pushNotifications !== undefined && {
      pushNotifications: capabilities.pushNotifications,
    }),
    ...(capabilities.extensions?.length && {
      extensions: capabilities.extensions.map((extension) => ({
        uri: extension.uri,
        ...(extension.description && { description: extension.description }),
        ...(extension.required && { required: true }),
        ...(extension.params && { params: extension.params }),
      })),
    }),
    ...(capabilities.extendedAgentCard && { extendedAgentCard: true }),
  };
}

function securitySchemesToV1(
  schemes: Record<string, SecurityScheme>
): Record<string, V1SecurityScheme> {
  return Object.fromEntries(
    Object.entries(schemes).flatMap(([name, scheme]) => {
      const v1 = securitySchemeToV1(scheme);
      return v1 ? [[name, v1]] : [];
    })
  );
}

/** The A2A 1.0 card of a model, without signatures. */
export function toV1Card(model: AgentCardModel): V1AgentCard {
  return {
    name: model.name,
    description: model.description,
    supportedInterfaces: v1Interfaces(model),
    ...(model.provider && { provider: { ...model.provider } }),
    version: model.version,
    ...(model.documentationUrl && { documentationUrl: model.documentationUrl }),
    capabilities: capabilitiesToV1(model.capabilities),
    ...(model.securitySchemes && { securitySchemes: securitySchemesToV1(model.securitySchemes) }),
    ...(model.security?.length && {
      securityRequirements: securityRequirementsToV1(model.security),
    }),
    defaultInputModes: [...model.defaultInputModes],
    defaultOutputModes: [...model.defaultOutputModes],
    skills: model.skills.map(skillToV1),
    ...(model.iconUrl && { iconUrl: model.iconUrl }),
  };
}

/**
 * The model of an A2A 0.3 card. Its interfaces come from `supportedInterfaces` when it lists
 * them (a hybrid card), else from `url`, `preferredTransport` and `additionalInterfaces`.
 */
export function cardModelFromLegacy(card: AgentCard): AgentCardModel {
  const declared = card.supportedInterfaces?.length
    ? card.supportedInterfaces.map((entry): AgentCardInterface => ({
        url: entry.url,
        protocolBinding: entry.protocolBinding,
        protocolVersion: entry.protocolVersion,
        ...(entry.tenant && { tenant: entry.tenant }),
      }))
    : legacyInterfaces(card);
  const { extensions, ...capabilities } = card.capabilities ?? {};
  return {
    name: card.name,
    description: card.description,
    version: card.version,
    ...(card.provider && { provider: card.provider }),
    ...(card.iconUrl && { iconUrl: card.iconUrl }),
    ...(card.documentationUrl && { documentationUrl: card.documentationUrl }),
    capabilities: {
      ...capabilities,
      ...(extensions?.length && { extensions: extensions.map((entry) => ({ ...entry })) }),
      ...(card.supportsAuthenticatedExtendedCard && { extendedAgentCard: true }),
    },
    ...(card.securitySchemes && { securitySchemes: card.securitySchemes }),
    ...(card.security && { security: card.security }),
    defaultInputModes: [...(card.defaultInputModes ?? [])],
    defaultOutputModes: [...(card.defaultOutputModes ?? [])],
    skills: (card.skills ?? []).map((skill) => ({ ...skill })),
    interfaces: declared,
  };
}

function legacyInterfaces(card: AgentCard): AgentCardInterface[] {
  const version = card.protocolVersion?.split('.').slice(0, 2).join('.') || '0.3';
  const primary: AgentCardInterface = {
    url: card.url,
    protocolBinding: card.preferredTransport ?? 'JSONRPC',
    protocolVersion: version,
  };
  const others = (card.additionalInterfaces ?? [])
    .filter((entry) => entry.url !== primary.url || entry.transport !== primary.protocolBinding)
    .map((entry): AgentCardInterface => ({
      url: entry.url,
      protocolBinding: entry.transport,
      protocolVersion: version,
    }));
  return [primary, ...others];
}

/** The model of an A2A 1.0 card. */
export function cardModelFromV1(card: V1AgentCard): AgentCardModel {
  const { extensions, extendedAgentCard, ...capabilities } = card.capabilities ?? {};
  return {
    name: card.name,
    description: card.description,
    version: card.version,
    ...(card.provider && { provider: { ...card.provider } }),
    ...(card.iconUrl && { iconUrl: card.iconUrl }),
    ...(card.documentationUrl && { documentationUrl: card.documentationUrl }),
    capabilities: {
      ...capabilities,
      ...(extensions?.length && {
        extensions: extensions.map((extension): AgentExtension => ({
          uri: extension.uri,
          ...(extension.description && { description: extension.description }),
          ...(extension.required !== undefined && { required: extension.required }),
          ...(extension.params && { params: extension.params }),
        })),
      }),
      ...(extendedAgentCard && { extendedAgentCard: true }),
    },
    ...(card.securitySchemes &&
      Object.keys(card.securitySchemes).length > 0 && {
        securitySchemes: Object.fromEntries(
          Object.entries(card.securitySchemes).map(([name, scheme]) => [
            name,
            securitySchemeFromV1(scheme),
          ])
        ),
      }),
    ...(card.securityRequirements?.length && {
      security: securityRequirementsFromV1(card.securityRequirements),
    }),
    defaultInputModes: [...card.defaultInputModes],
    defaultOutputModes: [...card.defaultOutputModes],
    skills: card.skills.map(skillFromV1),
    interfaces: card.supportedInterfaces.map((entry) => ({
      url: entry.url,
      protocolBinding: entry.protocolBinding,
      protocolVersion: entry.protocolVersion,
      ...(entry.tenant && { tenant: entry.tenant }),
    })),
  };
}

/**
 * An A2A 1.0 card in the A2A 0.3 form the client API speaks: `url`, `preferredTransport` and
 * `protocolVersion` name its first 0.3 interface as on a hybrid card, or its first interface when
 * it has none, and `supportedInterfaces` keeps all of them.
 */
export function legacyCardFromV1(card: V1AgentCard): AgentCard {
  const model = cardModelFromV1(card);
  const legacy = toLegacyCard(model, { embedInterfaces: true });
  const signatures = card.signatures?.length
    ? { signatures: card.signatures.map((entry) => ({ ...entry })) }
    : {};
  if (model.interfaces.some(isLegacyInterface)) return { ...legacy, ...signatures };
  const primary = card.supportedInterfaces[0];
  return {
    ...legacy,
    protocolVersion: primary?.protocolVersion ?? legacy.protocolVersion,
    additionalInterfaces: card.supportedInterfaces.map((entry) => ({
      transport: entry.protocolBinding,
      url: entry.url,
    })),
    ...signatures,
  };
}

/**
 * The A2A 0.3 Agent Card of an agent. It names the agent, its description (never its
 * instructions) and its tools as skills (one conversation skill for an agent without tools), and
 * declares JSON-RPC at `url` as its transport.
 */
export function generateAgentCard(agent: IAgent, options: AgentCardOptions): AgentCard {
  const model = buildAgentCardModel(agent, {
    interfaces: [{ url: options.url, protocolBinding: 'JSONRPC', protocolVersion: '0.3' }],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
      ...options.capabilities,
      ...(options.supportsAuthenticatedExtendedCard && { extendedAgentCard: true }),
    },
    provider: options.provider,
    version: options.version,
  });
  return toLegacyCard(model);
}

/** @deprecated Signing with a shared HMAC secret. Use `cardSigning` with a private key. */
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

function unsignedCard<T extends { signatures?: unknown }>(card: T): Omit<T, 'signatures'> {
  const { signatures: _signatures, ...rest } = card;
  return rest;
}

function hs256(protectedHeader: string, card: object, secret: string): Buffer {
  const signingInput = `${protectedHeader}.${base64url(canonicalJson(unsignedCard(card)))}`;
  return createHmac('sha256', secret).update(signingInput).digest();
}

/**
 * @deprecated A JWS signature with a shared HMAC secret: anyone who can verify it can forge it.
 * Sign with a private key (`cardSigning: { alg, privateKey, kid }`) instead.
 *
 * The card with a JWS signature (RFC 7515, HS256, detached payload) over its canonical JSON
 * (RFC 8785, without `signatures`) in `signatures`.
 */
export function signAgentCard<T extends AgentCard | V1AgentCard>(
  card: T,
  options: AgentCardSigningOptions
): T {
  const signature: AgentCardSignature = {
    protected: PROTECTED_HEADER,
    signature: base64url(hs256(PROTECTED_HEADER, card, options.secret)),
  };
  return { ...unsignedCard(card), signatures: [signature] } as T;
}

function parseProtectedHeader(encoded: string): { alg?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as { alg?: unknown }) : null;
  } catch {
    return null;
  }
}

/**
 * @deprecated Checks an HMAC signature. Verify cards signed with a private key with
 * `verifyAgentCardJws` or `A2AClient.verifyAgentCard({ keys })`.
 *
 * Whether one of the card's HS256 signatures was made with `secret` over this exact card.
 */
export function verifyAgentCardSignature(card: AgentCard | V1AgentCard, secret: string): boolean {
  for (const signature of card.signatures ?? []) {
    if (parseProtectedHeader(signature.protected)?.alg !== 'HS256') continue;
    const expected = hs256(signature.protected, card, secret);
    const actual = Buffer.from(signature.signature, 'base64url');
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) return true;
  }
  return false;
}
