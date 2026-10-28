import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProtocolError } from '@modelcontextprotocol/client';
import type { InterruptRequest } from '@cogitator-ai/types';
import { MCPClient } from '../client/mcp-client';
import type { MCPClientConfig } from '../types';

/** Each test starts real server processes, twice when the client probes the protocol revision */
vi.setConfig({ testTimeout: 30_000 });

const MODERN = join(__dirname, 'fixtures', 'modern-server.mjs');
const LEGACY = join(__dirname, 'fixtures', 'ping-server.mjs');

const clients: MCPClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
});

async function connect(
  script: string,
  config: Partial<MCPClientConfig> = {},
  args: string[] = []
): Promise<MCPClient> {
  const client = await MCPClient.connect({
    transport: 'stdio',
    command: process.execPath,
    args: [script, ...args],
    timeout: 20_000,
    ...config,
  });
  clients.push(client);
  return client;
}

describe('protocol version negotiation', () => {
  it('speaks 2026-07-28 to a server that answers server/discover', async () => {
    const client = await connect(MODERN);
    expect(client.era).toBe('modern');
    expect(client.protocolVersion).toBe('2026-07-28');
    expect(client.discover()).toMatchObject({
      era: 'modern',
      protocolVersion: '2026-07-28',
      supportedVersions: expect.arrayContaining(['2026-07-28']),
      serverInfo: { name: 'modern', version: '2.0.0' },
    });
    expect(await client.callTool('echo', { text: 'hi' })).toBe('hi');
  });

  it('falls back to 2025-11-25 for a server that only knows initialize', async () => {
    const client = await connect(LEGACY);
    expect(client.era).toBe('legacy');
    expect(client.protocolVersion).toBe('2025-11-25');
    expect(client.discover().supportedVersions).toBeUndefined();
    expect(await client.callTool('ping', { word: 'x' })).toBe('pong x');
  });

  it('speaks 2025-11-25 when asked to, even to a modern server', async () => {
    const client = await connect(MODERN, { protocol: 'legacy' });
    expect(client.era).toBe('legacy');
    expect(await client.callTool('echo', { text: 'old' })).toBe('old');
  });

  it('fails a pinned revision the server does not speak', async () => {
    await expect(connect(LEGACY, { protocol: { pin: '2026-07-28' } })).rejects.toThrow();
  });

  it('cannot reach a modern-only server as a legacy client', async () => {
    await expect(connect(MODERN, { protocol: 'legacy' }, ['--modern-only'])).rejects.toThrow();
  });

  it('keeps the revision across a reconnect', async () => {
    const client = await connect(MODERN);
    await client.reconnect();
    expect(client.era).toBe('modern');
    expect(await client.callTool('echo', { text: 'again' })).toBe('again');
  });
});

describe('input requests of a modern server', () => {
  it('answers them with the elicitation handler and echoes the request state', async () => {
    const elicitation = vi.fn(async () => ({
      action: 'accept' as const,
      content: { name: 'Ann' },
    }));
    const client = await connect(MODERN, { elicitation });
    expect(await client.callTool('greet', {})).toBe('hello Ann (state opaque-state-1)');
    expect(elicitation).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'form', message: 'Your name?' }),
      { server: 'modern', tool: 'greet' }
    );
  });

  it("asks them through the call's run when it has one", async () => {
    const interrupt = vi.fn(async (_request: InterruptRequest<unknown>) => ({ name: 'Bo' }));
    const client = await connect(MODERN);
    const value = await client.callTool(
      'greet',
      {},
      {
        interrupt: interrupt as <T>(request: InterruptRequest<T>) => Promise<T>,
      }
    );
    expect(value).toBe('hello Bo (state opaque-state-1)');
    expect(interrupt).toHaveBeenCalledWith({
      reason: 'mcp_elicitation',
      message: 'Your name?',
      responseSchema: expect.objectContaining({ type: 'object' }),
      details: { server: 'modern', tool: 'greet', mode: 'form' },
    });
  });

  it('opens a URL through the run and accepts once the person is done', async () => {
    const interrupt = vi.fn(async () => ({ done: true }));
    const client = await connect(MODERN);
    const value = await client.callTool(
      'sign_in',
      {},
      {
        interrupt: interrupt as <T>(request: InterruptRequest<T>) => Promise<T>,
      }
    );
    expect(value).toBe('signed in: accept');
    expect(interrupt).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'mcp_elicitation_url',
        details: expect.objectContaining({ url: 'https://example.com/sign-in' }),
      })
    );
  });

  it('tells the server it cannot answer when nobody can, so the server refuses', async () => {
    const client = await connect(MODERN);
    const error = await client.callTool('greet', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(-32021);

    const off = await connect(MODERN, {
      elicitation: false,
    });
    await expect(
      off.callTool('greet', {}, { interrupt: async <T>() => ({}) as T })
    ).rejects.toBeInstanceOf(ProtocolError);
  });

  it('stops a server that keeps asking after maxInputRounds', async () => {
    const client = await connect(MODERN, {
      maxInputRounds: 2,
      elicitation: async () => ({ action: 'accept', content: {} }),
    });
    await expect(client.callTool('nag', {})).rejects.toThrow(/kept asking for input: 2 rounds/);
  });
});
