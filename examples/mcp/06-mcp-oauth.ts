import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { header, section } from '../_shared/setup.js';
import { tool } from '@cogitator-ai/core';
import { InMemoryMCPOAuthStore, MCPClient, MCPServer } from '@cogitator-ai/mcp';
import { z } from 'zod';

const CLIENT_METADATA_URL = 'https://my-app.example.com/oauth/client.json';

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

/**
 * A tiny authorization server for the demo. A real one fetches the Client ID Metadata Document
 * at the client_id URL and checks the redirect URI against it.
 */
async function startAuthorizationServer() {
  const codes = new Map<string, string>();
  const tokens = new Set<string>();
  let issuer = '';
  const server = createServer(async (req, res) => {
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
        })
      );
    } else if (url.pathname === '/authorize') {
      console.log(`  authorization request from client_id ${url.searchParams.get('client_id')}`);
      const code = randomBytes(8).toString('hex');
      codes.set(code, url.searchParams.get('code_challenge') ?? '');
      const back = new URL(url.searchParams.get('redirect_uri') ?? '');
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      back.searchParams.set('iss', issuer);
      res.writeHead(302, { Location: back.toString() });
      res.end();
    } else if (url.pathname === '/token') {
      const params = new URLSearchParams(await readBody(req));
      const challenge = createHash('sha256')
        .update(params.get('code_verifier') ?? '')
        .digest('base64url');
      if (codes.get(params.get('code') ?? '') !== challenge) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      const token = randomBytes(16).toString('hex');
      tokens.add(token);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 3600 }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { issuer, tokens, close: () => server.close() };
}

async function main() {
  header('06 - MCP OAuth 2.1 with a Client ID Metadata Document');

  const auth = await startAuthorizationServer();
  const mcp = new MCPServer({
    name: 'billing',
    version: '1.0.0',
    transport: 'http',
    host: '127.0.0.1',
    port: 0,
    protectedResource: { authorizationServers: [auth.issuer], resourceName: 'Billing tools' },
    auth: (req) => {
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      return token && auth.tokens.has(token) ? { userId: 'ann' } : undefined;
    },
  });
  mcp.registerTool(
    tool({
      name: 'balance',
      description: 'The balance of the signed-in user.',
      parameters: z.object({}),
      execute: async (_params, context) => ({ user: context.userId, balance: 120.5 }),
    })
  );
  await mcp.start();

  section('1. Connect: the 401 sends the client to the authorization server');
  const client = await MCPClient.connect({
    transport: 'http',
    url: `http://127.0.0.1:${mcp.getPort()}/mcp`,
    auth: {
      redirectUrl: 'http://127.0.0.1:8976/callback',
      clientMetadataUrl: CLIENT_METADATA_URL,
      store: new InMemoryMCPOAuthStore(),
      authorize: async (url) => {
        const response = await fetch(url, { redirect: 'manual' });
        return new URL(response.headers.get('location') ?? '');
      },
    },
  });

  try {
    section('2. Call a protected tool with the token');
    console.log(`  ${JSON.stringify(await client.callTool('balance', {}))}`);
  } finally {
    await client.close();
    await mcp.stop();
    auth.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
