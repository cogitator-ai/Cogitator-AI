import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tool } from '@cogitator-ai/core';
import { InMemoryMCPOAuthStore, MCPClient, MCPServer } from '@cogitator-ai/mcp';
import type { Tool } from '@cogitator-ai/types';

const CLIENT_METADATA_URL = 'https://cogitator-e2e.example/oauth/client.json';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

/** A local OAuth 2.1 authorization server that takes Client ID Metadata Documents */
async function authorizationServer() {
  const codes = new Map<string, { challenge: string; clientId: string }>();
  const tokens = new Set<string>();
  const seen: { authorize: URLSearchParams[]; token: URLSearchParams[] } = {
    authorize: [],
    token: [],
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
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          client_id_metadata_document_supported: true,
          authorization_response_iss_parameter_supported: true,
        })
      );
      return;
    }
    if (url.pathname === '/authorize') {
      seen.authorize.push(url.searchParams);
      const code = randomBytes(8).toString('hex');
      codes.set(code, {
        challenge: url.searchParams.get('code_challenge') ?? '',
        clientId: url.searchParams.get('client_id') ?? '',
      });
      const back = new URL(url.searchParams.get('redirect_uri') ?? '');
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      back.searchParams.set('iss', issuer);
      res.writeHead(302, { Location: back.toString() });
      res.end();
      return;
    }
    if (url.pathname === '/token') {
      const params = new URLSearchParams(await body(req));
      seen.token.push(params);
      const grant = codes.get(params.get('code') ?? '');
      const challenge = createHash('sha256')
        .update(params.get('code_verifier') ?? '')
        .digest('base64url');
      if (grant?.challenge !== challenge || grant.clientId !== params.get('client_id')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      const token = randomBytes(16).toString('hex');
      tokens.add(token);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 3600 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      })
  );
  return { issuer, tokens, seen };
}

describe('MCP OAuth 2.1 with a Client ID Metadata Document', () => {
  it('authorizes against a local authorization server and calls the protected tools', async () => {
    const auth = await authorizationServer();
    const whoami = tool({
      name: 'whoami',
      description: 'Who calls',
      parameters: z.object({}),
      execute: async (_params, context) => `user ${context.userId}`,
    }) as Tool;
    const server = new MCPServer({
      name: 'protected',
      version: '1.0.0',
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
      protectedResource: { authorizationServers: [auth.issuer] },
      auth: (req) => {
        const token = req.headers.authorization?.replace(/^Bearer /, '');
        return token && auth.tokens.has(token) ? { userId: 'ann' } : undefined;
      },
    });
    server.registerTool(whoami);
    await server.start();
    cleanups.push(() => server.stop());
    const url = `http://127.0.0.1:${server.getPort()}/mcp`;

    const store = new InMemoryMCPOAuthStore();
    const opened: URL[] = [];
    const client = await MCPClient.connect({
      transport: 'http',
      url,
      auth: {
        redirectUrl: 'http://127.0.0.1:8976/callback',
        clientMetadataUrl: CLIENT_METADATA_URL,
        store,
        authorize: async (authorizationUrl) => {
          opened.push(authorizationUrl);
          const response = await fetch(authorizationUrl, { redirect: 'manual' });
          return new URL(response.headers.get('location') ?? '');
        },
      },
    });
    cleanups.push(() => client.close());

    expect(await client.callTool('whoami', {})).toBe('user ann');
    expect(opened).toHaveLength(1);
    expect(auth.seen.authorize[0]?.get('client_id')).toBe(CLIENT_METADATA_URL);
    expect(auth.seen.authorize[0]?.get('resource')).toBe(url);
    expect(await store.load(`mcp-oauth ${url} tokens:${auth.issuer}`)).toMatchObject({
      token_type: 'Bearer',
    });

    const again = await MCPClient.connect({
      transport: 'http',
      url,
      auth: {
        redirectUrl: 'http://127.0.0.1:8976/callback',
        clientMetadataUrl: CLIENT_METADATA_URL,
        store,
        authorize: async () => {
          throw new Error('The stored token should be enough');
        },
      },
    });
    cleanups.push(() => again.close());
    expect(await again.callTool('whoami', {})).toBe('user ann');
  });
});
