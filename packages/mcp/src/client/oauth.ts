/**
 * OAuth 2.1 for remote MCP servers (protocol 2026-07-28): an `OAuthClientProvider` for the MCP
 * SDK built from a config. It registers with a pre-registered client id, else with the client's
 * Client ID Metadata Document, else dynamically, and keeps registrations and tokens per
 * authorization server (`issuer`)
 */

import { randomBytes } from 'node:crypto';
import type {
  OAuthClientInformationContext,
  OAuthDiscoveryState,
  OAuthClientMetadata,
  OAuthClientProvider,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { z } from 'zod';
import type { MCPOAuthConfig, MCPOAuthStore } from '../types';

const TokensSchema = z.looseObject({
  access_token: z.string(),
  token_type: z.string(),
});

const ClientInformationSchema = z.looseObject({
  client_id: z.string(),
});

const DiscoveryStateSchema = z.looseObject({
  authorizationServerUrl: z.string(),
});

/** OAuth state kept in the client's memory, the default {@link MCPOAuthStore} */
export class InMemoryMCPOAuthStore implements MCPOAuthStore {
  private readonly values = new Map<string, unknown>();

  load(key: string): Promise<unknown> {
    return Promise.resolve(this.values.get(key));
  }

  save(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
}

/** An OAuth provider that also knows the authorization the person still has to finish */
export interface MCPOAuthProvider extends OAuthClientProvider {
  /**
   * Sends the person to the authorization URL the last attempt stopped at and returns the query
   * of the URL they came back to, its `state` checked. `undefined` when no attempt waits
   */
  completeAuthorization(): Promise<URLSearchParams | undefined>;
}

/** Which server a provider authorizes for, and the name it registers under */
export interface MCPOAuthProviderOptions {
  /**
   * The MCP server's URL. Everything the provider keeps in its store is kept under it, so one
   * store serves several servers without one's tokens reaching another
   */
  resource: string;
  /** Name shown on consent pages when `config.clientName` is not set. Default: `cogitator` */
  clientName?: string;
}

/**
 * An MCP SDK `OAuthClientProvider` from `config` for the server at `options.resource`. With
 * `clientMetadataUrl` the client id is that URL, which authorization servers that support Client
 * ID Metadata Documents fetch, others fall back to Dynamic Client Registration
 * (`application_type` follows the redirect host). Registrations and tokens are kept per
 * authorization server (`issuer`), everything under the server's URL
 */
export function createMCPOAuthProvider(
  config: MCPOAuthConfig,
  options: MCPOAuthProviderOptions
): MCPOAuthProvider {
  const clientName = options.clientName ?? 'cogitator';
  if (config.clientMetadataUrl !== undefined) {
    const url = new URL(config.clientMetadataUrl);
    if (url.protocol !== 'https:' || url.pathname === '/' || url.pathname === '') {
      throw new TypeError(
        `clientMetadataUrl must be an https URL with a path, such as https://example.com/client.json: ${config.clientMetadataUrl}`
      );
    }
  }
  const store = config.store ?? new InMemoryMCPOAuthStore();
  let pending: URL | undefined;

  const metadata: OAuthClientMetadata = {
    client_name: config.clientName ?? clientName,
    redirect_uris: [config.redirectUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: config.clientSecret ? 'client_secret_post' : 'none',
    ...(config.scope && { scope: config.scope }),
  };

  const resource = new URL(options.resource);
  resource.hash = '';
  const prefix = `mcp-oauth ${resource.href} `;
  const keyOf = (kind: string, ctx?: OAuthClientInformationContext): string =>
    `${prefix}${ctx ? `${kind}:${ctx.issuer}` : `${kind}:latest`}`;
  const plain = (kind: string): string => `${prefix}${kind}`;

  const issuers = async (): Promise<string[]> => {
    const stored = z.array(z.string()).safeParse(await store.load(plain('issuers')));
    return stored.success ? stored.data : [];
  };
  const remember = async (ctx: OAuthClientInformationContext | undefined): Promise<void> => {
    if (!ctx) return;
    const known = await issuers();
    if (!known.includes(ctx.issuer)) await store.save(plain('issuers'), [...known, ctx.issuer]);
  };
  const forget = async (kind: 'tokens' | 'client'): Promise<void> => {
    for (const issuer of await issuers()) await store.delete(keyOf(kind, { issuer }));
    await store.delete(keyOf(kind));
  };

  return {
    get redirectUrl() {
      return config.redirectUrl;
    },
    ...(config.clientMetadataUrl !== undefined && { clientMetadataUrl: config.clientMetadataUrl }),
    get clientMetadata() {
      return metadata;
    },

    async state() {
      const state = randomBytes(16).toString('base64url');
      await store.save(plain('state'), state);
      return state;
    },

    async clientInformation(ctx) {
      if (config.clientId !== undefined) {
        return {
          client_id: config.clientId,
          ...(config.clientSecret !== undefined && { client_secret: config.clientSecret }),
        };
      }
      const stored = ClientInformationSchema.safeParse(await store.load(keyOf('client', ctx)));
      return stored.success ? (stored.data as StoredOAuthClientInformation) : undefined;
    },

    async saveClientInformation(information, ctx) {
      await remember(ctx);
      await store.save(keyOf('client', ctx), information);
    },

    async tokens(ctx) {
      const stored = TokensSchema.safeParse(await store.load(keyOf('tokens', ctx)));
      return stored.success ? (stored.data as StoredOAuthTokens) : undefined;
    },

    async saveTokens(tokens, ctx) {
      await remember(ctx);
      await store.save(keyOf('tokens', ctx), tokens);
      await store.save(keyOf('tokens'), tokens);
    },

    redirectToAuthorization(authorizationUrl) {
      pending = authorizationUrl;
    },

    async saveDiscoveryState(state) {
      await store.save(plain('discovery'), state);
    },

    async discoveryState() {
      const stored = DiscoveryStateSchema.safeParse(await store.load(plain('discovery')));
      return stored.success ? (stored.data as OAuthDiscoveryState) : undefined;
    },

    async saveCodeVerifier(codeVerifier) {
      await store.save(plain('verifier'), codeVerifier);
    },

    async codeVerifier() {
      const verifier = await store.load(plain('verifier'));
      if (typeof verifier !== 'string') {
        throw new Error('No PKCE code verifier saved for the authorization in progress');
      }
      return verifier;
    },

    async invalidateCredentials(scope) {
      if (scope === 'all' || scope === 'tokens') await forget('tokens');
      if (scope === 'all' || scope === 'client') await forget('client');
      if (scope === 'all' || scope === 'verifier') await store.delete(plain('verifier'));
      if (scope === 'all' || scope === 'discovery') await store.delete(plain('discovery'));
      if (scope === 'all') {
        await store.delete(plain('state'));
        await store.delete(plain('issuers'));
      }
    },

    async completeAuthorization() {
      const url = pending;
      if (!url) return undefined;
      pending = undefined;
      const callback = await config.authorize(url);
      const params =
        callback instanceof URLSearchParams
          ? callback
          : callback instanceof URL
            ? callback.searchParams
            : callback.includes('?') || callback.includes('://')
              ? new URL(callback, 'http://localhost').searchParams
              : new URLSearchParams(callback);
      const expected = url.searchParams.get('state');
      if (expected !== null && params.get('state') !== expected) {
        throw new Error(
          'The authorization callback carries another state than the request: refused'
        );
      }
      return params;
    },
  };
}
