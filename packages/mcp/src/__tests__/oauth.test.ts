import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { IssuerMismatchError } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { tool } from '@cogitator-ai/core';
import type { Tool } from '@cogitator-ai/types';
import { MCPClient } from '../client/mcp-client';
import { createMCPOAuthProvider, InMemoryMCPOAuthStore } from '../client/oauth';
import { MCPServer } from '../server/mcp-server';

const CLIENT_METADATA_URL = 'https://app.example.com/oauth/client.json';
const SERVER = 'https://mcp-a.example.com/mcp';

interface AuthServerOptions {
  cimd: boolean;
  dcr: boolean;
  iss?: (issuer: string) => string;
}

interface FakeAuthServer {
  issuer: string;
  registrations: Record<string, unknown>[];
  tokenRequests: URLSearchParams[];
  authorizeRequests: URLSearchParams[];
  tokens: Set<string>;
  close: () => Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

/** An OAuth 2.1 authorization server of its own, the parts an MCP client uses */
async function fakeAuthServer(options: AuthServerOptions): Promise<FakeAuthServer> {
  const codes = new Map<string, { challenge: string; clientId: string; resource: string }>();
  const state: Omit<FakeAuthServer, 'issuer' | 'close'> = {
    registrations: [],
    tokenRequests: [],
    authorizeRequests: [],
    tokens: new Set(),
  };
  let issuer = '';
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          authorization_response_iss_parameter_supported: true,
          ...(options.cimd && { client_id_metadata_document_supported: true }),
          ...(options.dcr && { registration_endpoint: `${issuer}/register` }),
        })
      );
      return;
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      const metadata = JSON.parse(await readBody(req)) as Record<string, unknown>;
      state.registrations.push(metadata);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...metadata, client_id: 'registered-client' }));
      return;
    }
    if (url.pathname === '/authorize') {
      state.authorizeRequests.push(url.searchParams);
      const code = randomBytes(8).toString('hex');
      codes.set(code, {
        challenge: url.searchParams.get('code_challenge') ?? '',
        clientId: url.searchParams.get('client_id') ?? '',
        resource: url.searchParams.get('resource') ?? '',
      });
      const back = new URL(url.searchParams.get('redirect_uri') ?? '');
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      back.searchParams.set('iss', options.iss ? options.iss(issuer) : issuer);
      res.writeHead(302, { Location: back.toString() });
      res.end();
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const params = new URLSearchParams(await readBody(req));
      state.tokenRequests.push(params);
      const grant = codes.get(params.get('code') ?? '');
      const verifier = params.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (grant?.challenge !== challenge || grant.clientId !== params.get('client_id')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      const token = randomBytes(16).toString('hex');
      state.tokens.add(token);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 3600 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer,
    ...state,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

const whoami: Tool = tool({
  name: 'whoami',
  description: 'Who calls',
  parameters: z.object({}),
  execute: async (_params, context) => `user ${context.userId ?? 'nobody'}`,
}) as Tool;

async function protectedServer(auth: FakeAuthServer): Promise<{ server: MCPServer; url: string }> {
  const server = new MCPServer({
    name: 'protected',
    version: '1.0.0',
    transport: 'http',
    host: '127.0.0.1',
    port: 0,
    protectedResource: { authorizationServers: [auth.issuer], resourceName: 'Protected tools' },
    auth: (req) => {
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      return token && auth.tokens.has(token) ? { userId: 'u-oauth' } : undefined;
    },
  });
  server.registerTool(whoami);
  await server.start();
  return { server, url: `http://127.0.0.1:${server.getPort()}/mcp` };
}

/** Follows the authorization URL the way a browser would and returns where it lands */
async function browse(url: URL): Promise<URL> {
  const response = await fetch(url, { redirect: 'manual' });
  return new URL(response.headers.get('location') ?? '');
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('createMCPOAuthProvider', () => {
  it('takes only an https client metadata URL with a path', () => {
    const base = { redirectUrl: 'http://127.0.0.1:9/cb', authorize: browse };
    expect(() =>
      createMCPOAuthProvider(
        { ...base, clientMetadataUrl: 'http://app.example.com/c.json' },
        { resource: SERVER }
      )
    ).toThrow(/https URL with a path/);
    expect(() =>
      createMCPOAuthProvider(
        { ...base, clientMetadataUrl: 'https://app.example.com/' },
        { resource: SERVER }
      )
    ).toThrow(/https URL with a path/);
    expect(
      createMCPOAuthProvider(
        { ...base, clientMetadataUrl: CLIENT_METADATA_URL },
        { resource: SERVER }
      ).clientMetadataUrl
    ).toBe(CLIENT_METADATA_URL);
  });

  it('keeps tokens and registrations per authorization server', async () => {
    const store = new InMemoryMCPOAuthStore();
    const provider = createMCPOAuthProvider(
      { redirectUrl: 'http://127.0.0.1:9/cb', store, authorize: browse },
      { resource: SERVER }
    );
    await provider.saveTokens(
      { access_token: 'a', token_type: 'Bearer' },
      { issuer: 'https://as1' }
    );
    await provider.saveClientInformation?.({ client_id: 'c1' }, { issuer: 'https://as1' });

    expect(await provider.tokens({ issuer: 'https://as1' })).toMatchObject({ access_token: 'a' });
    expect(await provider.tokens({ issuer: 'https://as2' })).toBeUndefined();
    expect(await provider.tokens()).toMatchObject({ access_token: 'a' });
    expect(await provider.clientInformation({ issuer: 'https://as2' })).toBeUndefined();
    expect(await provider.clientInformation({ issuer: 'https://as1' })).toMatchObject({
      client_id: 'c1',
    });
  });

  it('forgets the credentials of every authorization server when the SDK invalidates them', async () => {
    const store = new InMemoryMCPOAuthStore();
    const provider = createMCPOAuthProvider(
      { redirectUrl: 'http://127.0.0.1:9/cb', store, authorize: browse },
      { resource: SERVER }
    );
    for (const issuer of ['https://as1', 'https://as2']) {
      await provider.saveTokens({ access_token: issuer, token_type: 'Bearer' }, { issuer });
      await provider.saveClientInformation?.({ client_id: issuer }, { issuer });
    }

    await provider.invalidateCredentials?.('tokens');
    expect(await provider.tokens({ issuer: 'https://as1' })).toBeUndefined();
    expect(await provider.tokens({ issuer: 'https://as2' })).toBeUndefined();
    expect(await provider.tokens()).toBeUndefined();
    expect(await provider.clientInformation({ issuer: 'https://as2' })).toBeDefined();

    await provider.invalidateCredentials?.('client');
    expect(await provider.clientInformation({ issuer: 'https://as1' })).toBeUndefined();
    expect(await provider.clientInformation({ issuer: 'https://as2' })).toBeUndefined();
  });

  it('keeps what it stores under the server, so one store serves several servers', async () => {
    const store = new InMemoryMCPOAuthStore();
    const config = { redirectUrl: 'http://127.0.0.1:9/cb', store, authorize: browse };
    const forA = createMCPOAuthProvider(config, { resource: SERVER });
    const forB = createMCPOAuthProvider(config, { resource: 'https://mcp-b.example.com/mcp' });

    await forB.saveTokens({ access_token: 'b', token_type: 'Bearer' }, { issuer: 'https://as' });
    await forB.saveCodeVerifier('verifier-b');
    await forA.saveCodeVerifier('verifier-a');

    expect(await forA.tokens({ issuer: 'https://as' })).toBeUndefined();
    expect(await forA.tokens()).toBeUndefined();
    expect(await forB.tokens()).toMatchObject({ access_token: 'b' });
    expect(await forA.codeVerifier()).toBe('verifier-a');
    expect(await forB.codeVerifier()).toBe('verifier-b');
  });

  it('uses a pre-registered client id for every authorization server', async () => {
    const provider = createMCPOAuthProvider(
      { redirectUrl: 'http://127.0.0.1:9/cb', clientId: 'pre', authorize: browse },
      { resource: SERVER }
    );
    expect(await provider.clientInformation({ issuer: 'https://any' })).toEqual({
      client_id: 'pre',
    });
  });

  it('refuses a callback whose state is not the one it sent', async () => {
    const provider = createMCPOAuthProvider(
      {
        redirectUrl: 'http://127.0.0.1:9/cb',
        authorize: async () => new URL('http://127.0.0.1:9/cb?code=x&state=other'),
      },
      { resource: SERVER }
    );
    await provider.redirectToAuthorization(new URL('https://as/authorize?state=mine'));
    await expect(provider.completeAuthorization()).rejects.toThrow(/another state/);
  });
});

describe('MCPClient with OAuth', () => {
  it('registers by its Client ID Metadata Document when the authorization server supports it', async () => {
    const auth = await fakeAuthServer({ cimd: true, dcr: true });
    cleanups.push(auth.close);
    const { server, url } = await protectedServer(auth);
    cleanups.push(() => server.stop());

    const client = await MCPClient.connect({
      transport: 'http',
      url,
      auth: {
        redirectUrl: 'http://127.0.0.1:9/callback',
        clientMetadataUrl: CLIENT_METADATA_URL,
        authorize: browse,
      },
    });
    cleanups.push(() => client.close());

    expect(await client.callTool('whoami', {})).toBe('user u-oauth');
    expect(auth.registrations).toHaveLength(0);
    const authorize = auth.authorizeRequests[0]!;
    expect(authorize.get('client_id')).toBe(CLIENT_METADATA_URL);
    expect(authorize.get('code_challenge_method')).toBe('S256');
    expect(authorize.get('resource')).toBe(url);
    expect(auth.tokenRequests[0]?.get('client_id')).toBe(CLIENT_METADATA_URL);
    expect(auth.tokenRequests[0]?.get('resource')).toBe(url);
  });

  it('falls back to Dynamic Client Registration as a native app for a loopback redirect', async () => {
    const auth = await fakeAuthServer({ cimd: false, dcr: true });
    cleanups.push(auth.close);
    const { server, url } = await protectedServer(auth);
    cleanups.push(() => server.stop());

    const client = await MCPClient.connect({
      transport: 'http',
      url,
      auth: {
        redirectUrl: 'http://127.0.0.1:9/callback',
        clientMetadataUrl: CLIENT_METADATA_URL,
        authorize: browse,
      },
    });
    cleanups.push(() => client.close());

    expect(await client.callTool('whoami', {})).toBe('user u-oauth');
    expect(auth.registrations[0]).toMatchObject({
      application_type: 'native',
      redirect_uris: ['http://127.0.0.1:9/callback'],
    });
    expect(auth.authorizeRequests[0]?.get('client_id')).toBe('registered-client');
  });

  it('refuses a code from an authorization response of another issuer', async () => {
    const auth = await fakeAuthServer({
      cimd: true,
      dcr: false,
      iss: () => 'https://evil.example',
    });
    cleanups.push(auth.close);
    const { server, url } = await protectedServer(auth);
    cleanups.push(() => server.stop());

    await expect(
      MCPClient.connect({
        transport: 'http',
        url,
        auth: {
          redirectUrl: 'http://127.0.0.1:9/callback',
          clientMetadataUrl: CLIENT_METADATA_URL,
          authorize: browse,
        },
      })
    ).rejects.toBeInstanceOf(IssuerMismatchError);
    expect(auth.tokenRequests).toHaveLength(0);
  });

  it('serves the protected resource metadata and names it in the 401', async () => {
    const auth = await fakeAuthServer({ cimd: true, dcr: false });
    cleanups.push(auth.close);
    const { server, url } = await protectedServer(auth);
    cleanups.push(() => server.stop());

    const denied = await fetch(url, { method: 'POST', body: '{}' });
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toContain('resource_metadata="http://127.0.0.1');
    const metadata = (await (
      await fetch(new URL('/.well-known/oauth-protected-resource/mcp', url))
    ).json()) as Record<string, unknown>;
    expect(metadata).toEqual({
      resource: url,
      authorization_servers: [auth.issuer],
      bearer_methods_supported: ['header'],
      resource_name: 'Protected tools',
    });
  });
});
