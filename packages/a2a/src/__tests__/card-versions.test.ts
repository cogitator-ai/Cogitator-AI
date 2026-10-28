import { describe, it, expect, afterEach } from 'vitest';
import { A2AServer } from '../server';
import { a2aHono } from '../adapters/hono';
import { COGITATOR_AGENT_EXTENSIONS, TOOL_APPROVALS_EXTENSION } from '../extensions';
import type { AgentCard } from '../types';
import type { V1AgentCard } from '../v1/types';
import { echoCogitator, mockAgent, serveExpress, type Served } from './v1-helpers';

function newServer(config: Partial<ConstructorParameters<typeof A2AServer>[0]> = {}) {
  return new A2AServer({
    agents: { helper: mockAgent('helper'), writer: mockAgent('writer') },
    cogitator: echoCogitator(),
    ...config,
  });
}

describe('Agent Card versions', () => {
  let served: Served | undefined;

  afterEach(async () => {
    await served?.close();
    served = undefined;
  });

  it('serves the hybrid card without a version: 0.3 fields plus every interface', async () => {
    served = await serveExpress({
      agents: { helper: mockAgent('helper'), writer: mockAgent('writer') },
      cogitator: echoCogitator(),
    });
    const response = await fetch(`${served.url}/a2a/writer/.well-known/agent-card.json`);
    const card = (await response.json()) as AgentCard;
    expect(card).toMatchObject({
      protocolVersion: '0.3.0',
      url: `${served.url}/a2a/writer`,
      preferredTransport: 'JSONRPC',
      additionalInterfaces: [{ transport: 'JSONRPC', url: `${served.url}/a2a/writer` }],
    });
    expect(card.supportedInterfaces).toEqual([
      {
        url: `${served.url}/a2a/writer`,
        protocolBinding: 'JSONRPC',
        tenant: 'writer',
        protocolVersion: '1.0',
      },
      {
        url: `${served.url}/a2a/rest`,
        protocolBinding: 'HTTP+JSON',
        tenant: 'writer',
        protocolVersion: '1.0',
      },
      { url: `${served.url}/a2a/writer`, protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
    ]);
    expect(response.headers.get('vary')).toBe('A2A-Version');
  });

  it('serves the pure 1.0 card for A2A-Version 1.0, by header or query', async () => {
    served = await serveExpress({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
    });
    for (const fetched of [
      fetch(`${served.url}/.well-known/agent-card.json`, { headers: { 'A2A-Version': '1.0' } }),
      fetch(`${served.url}/.well-known/agent-card.json?A2A-Version=1.0`),
    ]) {
      const card = (await (await fetched).json()) as V1AgentCard & Record<string, unknown>;
      expect(card).not.toHaveProperty('url');
      expect(card).not.toHaveProperty('protocolVersion');
      expect(card).not.toHaveProperty('preferredTransport');
      expect(card.supportedInterfaces[0]).toEqual({
        url: `${served.url}/a2a`,
        protocolBinding: 'JSONRPC',
        tenant: 'helper',
        protocolVersion: '1.0',
      });
      expect(card.capabilities).toEqual({
        streaming: true,
        pushNotifications: true,
        extensions: COGITATOR_AGENT_EXTENSIONS.map(({ uri, description, params }) => ({
          uri,
          description,
          params,
        })),
      });
    }
  });

  it('answers with ETag and Cache-Control, and 304 for a matching If-None-Match', async () => {
    served = await serveExpress({
      agents: { helper: mockAgent('helper') },
      cogitator: echoCogitator(),
    });
    const url = `${served.url}/.well-known/agent-card.json`;
    const first = await fetch(url);
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(first.headers.get('cache-control')).toBe('public, max-age=300');

    const again = await fetch(url, { headers: { 'If-None-Match': etag! } });
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(etag);

    const weak = await fetch(url, { headers: { 'If-None-Match': `W/${etag}, "other"` } });
    expect(weak.status).toBe(304);

    const v1 = await fetch(url, { headers: { 'A2A-Version': '1.0', 'If-None-Match': etag! } });
    expect(v1.status).toBe(200);
    expect(v1.headers.get('etag')).not.toBe(etag);
  });

  it('keeps the old card when the server speaks only 0.3, and the 1.0 card when only 1.0', () => {
    const legacy = newServer({ protocolVersions: ['0.3'] });
    expect(legacy.restPath).toBeNull();
    expect(legacy.getAgentCard()).not.toHaveProperty('supportedInterfaces');

    const modern = newServer({ protocolVersions: ['1.0'] });
    expect(
      modern.getV1AgentCard().supportedInterfaces.map((entry) => entry.protocolVersion)
    ).toEqual(['1.0', '1.0']);
  });

  it('serves the 1.0 card to a request without a version when 0.3 is off', async () => {
    const app = a2aHono(newServer({ protocolVersions: ['1.0'] }));
    const card = (await (await app.request('/.well-known/agent-card.json')).json()) as Record<
      string,
      unknown
    >;
    expect(card).toHaveProperty('supportedInterfaces');
    expect(card).not.toHaveProperty('url');
  });

  it('refuses unknown protocol versions in the config', () => {
    expect(() => newServer({ protocolVersions: [] })).toThrow(/protocolVersions/);
  });

  it('gives an agent without tools one skill, so skills is never empty', () => {
    const card = newServer().getV1AgentCard();
    expect(card.skills).toEqual([
      {
        id: 'chat',
        name: 'helper',
        description: 'helper agent',
        tags: ['chat'],
        inputModes: ['text/plain', 'application/json'],
        outputModes: ['text/plain', 'application/json'],
      },
    ]);
  });

  it('announces the extended card in capabilities.extendedAgentCard', () => {
    const server = newServer({ extendedCardGenerator: () => newServer().getAgentCard() });
    expect(server.getV1AgentCard().capabilities.extendedAgentCard).toBe(true);
    expect(server.getAgentCard().supportsAuthenticatedExtendedCard).toBe(true);
    expect(newServer().getV1AgentCard().capabilities).not.toHaveProperty('extendedAgentCard');
  });

  it('maps auth to 1.0 security schemes and requirements', () => {
    const card = newServer({
      auth: { type: 'apiKey', headerName: 'x-key', validate: async () => true },
    }).getV1AgentCard();
    expect(card.securitySchemes).toEqual({
      apiKey: { apiKeySecurityScheme: { location: 'header', name: 'x-key' } },
    });
    expect(card.securityRequirements).toEqual([{ schemes: { apiKey: {} } }]);
  });

  it('places the REST interface next to cardUrl', () => {
    const card = newServer({ cardUrl: 'https://agents.example.com/api/a2a' }).getV1AgentCard(
      'writer'
    );
    expect(card.supportedInterfaces.map((entry) => entry.url)).toEqual([
      'https://agents.example.com/api/a2a/writer',
      'https://agents.example.com/api/a2a/rest',
      'https://agents.example.com/api/a2a/writer',
    ]);
  });

  it('lists configured extensions after the built-in ones', () => {
    const card = newServer({
      extensions: [{ uri: 'https://example.com/ext/geo/v1', required: true }],
    }).getV1AgentCard();
    expect(card.capabilities.extensions?.map((extension) => extension.uri)).toEqual([
      ...COGITATOR_AGENT_EXTENSIONS.map((extension) => extension.uri),
      'https://example.com/ext/geo/v1',
    ]);
    expect(card.capabilities.extensions?.at(-1)).toEqual({
      uri: 'https://example.com/ext/geo/v1',
      required: true,
    });
    expect(card.capabilities.extensions?.[0].uri).toBe(TOOL_APPROVALS_EXTENSION);
  });
});
