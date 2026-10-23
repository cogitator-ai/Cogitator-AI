import { z } from 'zod';
import { FeedError, feedErrorCode } from '../../feeds/errors';

/** Where Microsoft Entra ID issues tokens (default for `loginUrl`). */
export const MICROSOFT_LOGIN_URL = 'https://login.microsoftonline.com';
/** The scope of a token that calls the Bot Connector. */
export const BOT_FRAMEWORK_SCOPE = 'https://api.botframework.com/.default';
/** The tenant a legacy multi-tenant bot gets its token from. */
export const BOT_FRAMEWORK_TENANT = 'botframework.com';

/** How long before it expires a token is renewed, in ms. */
const RENEW_BEFORE = 5 * 60 * 1000;

/** An access token with the time it expires, in ms since the epoch. */
export interface TeamsAccessToken {
  token: string;
  expiresAt: number;
}

/**
 * A function that returns a Bot Connector token, such as one from a user-assigned managed
 * identity. A token with `expiresAt` is cached until shortly before then, a bare string is asked
 * for again before every request.
 */
export type TeamsTokenProvider = () => Promise<string | TeamsAccessToken>;

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.union([z.number(), z.string()]).optional(),
});

const TokenErrorSchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
});

export interface TeamsCredentialsOptions {
  appId: string;
  /** The client secret of the app registration */
  appPassword?: string;
  /** The tenant the token comes from: the bot's own for a single-tenant bot */
  tenant: string;
  provider?: TeamsTokenProvider;
  loginUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * The token the bot calls the Bot Connector with: an OAuth client credentials token of the app
 * registration, or one from a provider. It is cached until five minutes before it expires, and
 * requests that need it while it is renewed wait for the same renewal.
 */
export class TeamsCredentials {
  private cached?: TeamsAccessToken;
  private pending?: Promise<TeamsAccessToken | string>;
  private readonly now: () => number;

  constructor(private readonly options: TeamsCredentialsOptions) {
    this.now = options.now ?? Date.now;
  }

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - RENEW_BEFORE > this.now()) return this.cached.token;
    this.pending ??= this.fetchToken().finally(() => {
      this.pending = undefined;
    });
    const fresh = await this.pending;
    if (typeof fresh === 'string') return fresh;
    this.cached = fresh;
    return fresh.token;
  }

  /** Forgets the cached token, after the Bot Connector refused it. */
  invalidate(): void {
    this.cached = undefined;
  }

  private async fetchToken(): Promise<TeamsAccessToken | string> {
    if (this.options.provider) return this.options.provider();
    const { appId, appPassword, tenant } = this.options;
    if (!appPassword) {
      throw new FeedError('teams', 'auth', 'No appPassword or token provider to get a token with');
    }
    const base = this.options.loginUrl ?? MICROSOFT_LOGIN_URL;
    const url = `${base}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: appId,
          client_secret: appPassword,
          scope: BOT_FRAMEWORK_SCOPE,
        }).toString(),
      });
    } catch (error) {
      throw new FeedError('teams', 'unavailable', `The token request failed: ${String(error)}`, {
        cause: error,
      });
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const error = TokenErrorSchema.safeParse(body);
      const detail = error.success ? (error.data.error_description ?? error.data.error) : undefined;
      const code = response.status === 400 ? 'auth' : feedErrorCode(response.status);
      throw new FeedError(
        'teams',
        code,
        `The token request for tenant ${tenant} failed: ${detail ?? `HTTP ${response.status}`}`,
        { status: response.status, cause: body ?? text }
      );
    }
    const parsed = TokenResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new FeedError('teams', 'unknown', 'The token response holds no access_token', {
        cause: body,
      });
    }
    const seconds = Number(parsed.data.expires_in ?? 3600);
    return {
      token: parsed.data.access_token,
      expiresAt: this.now() + (Number.isFinite(seconds) ? seconds : 3600) * 1000,
    };
  }
}
