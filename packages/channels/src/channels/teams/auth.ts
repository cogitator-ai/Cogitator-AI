import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';

/** Where Bot Framework publishes the OpenID metadata of the tokens it signs requests with. */
export const BOT_FRAMEWORK_OPENID_METADATA =
  'https://login.botframework.com/v1/.well-known/openidconfiguration';
/** The issuer of the tokens Bot Framework sends with every activity. */
export const BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com';

/** How far the clocks of Bot Framework and the bot may differ, in seconds. */
const CLOCK_SKEW = 300;
/** How long signing keys are used before they are loaded again, in ms. */
const KEYS_MAX_AGE = 24 * 60 * 60 * 1000;
/** How often a token signed with a key the bot does not know may load the keys again, in ms. */
const UNKNOWN_KEY_REFRESH = 5 * 60 * 1000;
/** How long after the keys failed to load requests are refused before they are tried again, in ms. */
const FAILED_LOAD_BACKOFF = 10 * 1000;
/** How long loading the metadata or the keys may take by default, in ms. */
const KEYS_TIMEOUT = 10_000;
/** The longest token taken, in characters: Bot Framework tokens are about 1.5 KB. */
const MAX_TOKEN_LENGTH = 16 * 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Why a request was refused: `401` for a token that does not prove Bot Framework sent it, `403` for one it may not use. */
export class TeamsAuthError extends Error {
  constructor(
    readonly status: 401 | 403 | 503,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(`[teams] ${message}`, options);
    this.name = 'TeamsAuthError';
  }
}

const HeaderSchema = z.object({
  alg: z.string(),
  kid: z.string().optional(),
  x5t: z.string().optional(),
});

const ClaimsSchema = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  nbf: z.number().optional(),
  serviceurl: z.string().optional(),
  serviceUrl: z.string().optional(),
});

const MetadataSchema = z.object({ jwks_uri: z.string() });

const JwkSchema = z.object({
  kty: z.string(),
  kid: z.string().optional(),
  n: z.string().optional(),
  e: z.string().optional(),
  endorsements: z.array(z.string()).optional(),
});

const JwksSchema = z.object({ keys: z.array(z.unknown()) });

/** A token Bot Framework signed: the service URL it was issued for and the channels its key may sign for. */
export interface VerifiedTeamsToken {
  /** The `serviceurl` claim: the only Bot Connector the activity may be answered through */
  serviceUrl?: string;
  /** The channels the signing key is endorsed for, such as `msteams` */
  endorsements: readonly string[];
}

export interface TeamsTokenVerifierOptions {
  /** The bot's Microsoft App ID, the audience every token must name */
  appId: string;
  /** The OpenID metadata URL (default {@link BOT_FRAMEWORK_OPENID_METADATA}) */
  metadataUrl?: string;
  fetch?: typeof fetch;
  /** The current time in ms, for tests */
  now?: () => number;
  /** How long loading the metadata or the keys may take, in ms (default 10 000) */
  timeout?: number;
}

interface SigningKey {
  key: KeyObject;
  endorsements: readonly string[];
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf-8'));
}

/**
 * Checks the JWT Bot Framework sends with every activity, with no dependency but `node:crypto`:
 * RS256 only, signed by a key of the published JWKS, issued by {@link BOT_FRAMEWORK_ISSUER} for
 * the bot's App ID, and valid now within five minutes of clock skew. The keys are cached and
 * loaded again once a day, and a token signed by a key not seen yet loads them again at most
 * every five minutes, so a rotated key is picked up and a flood of forged ones costs nothing.
 */
export class TeamsTokenVerifier {
  private readonly metadataUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeout: number;
  private keys = new Map<string, SigningKey>();
  private loadedAt = 0;
  private lastUnknownRefresh = Number.NEGATIVE_INFINITY;
  private lastFailure = Number.NEGATIVE_INFINITY;
  private loading?: Promise<void>;

  constructor(private readonly options: TeamsTokenVerifierOptions) {
    this.metadataUrl = options.metadataUrl ?? BOT_FRAMEWORK_OPENID_METADATA;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeout = options.timeout ?? KEYS_TIMEOUT;
  }

  /** Checks a token, resolving with what it proves, or throws a {@link TeamsAuthError}. */
  async verify(token: string): Promise<VerifiedTeamsToken> {
    if (token.length > MAX_TOKEN_LENGTH) throw new TeamsAuthError(401, 'The token is too long');
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every((part) => BASE64URL.test(part))) {
      throw new TeamsAuthError(401, 'The token is not a signed JWT');
    }
    const [headerPart, payloadPart, signaturePart] = parts;
    let header: z.infer<typeof HeaderSchema>;
    let claims: z.infer<typeof ClaimsSchema>;
    try {
      header = HeaderSchema.parse(decodeSegment(headerPart));
      claims = ClaimsSchema.parse(decodeSegment(payloadPart));
    } catch (error) {
      throw new TeamsAuthError(401, 'The token cannot be read', { cause: error });
    }
    if (header.alg !== 'RS256') {
      throw new TeamsAuthError(401, `The token is signed with ${header.alg}, not RS256`);
    }
    const kid = header.kid ?? header.x5t;
    if (!kid) throw new TeamsAuthError(401, 'The token names no signing key');
    const signingKey = await this.keyFor(kid);
    if (!signingKey) throw new TeamsAuthError(401, 'The token is signed by an unknown key');
    const signed = verify(
      'RSA-SHA256',
      Buffer.from(`${headerPart}.${payloadPart}`),
      signingKey.key,
      Buffer.from(signaturePart, 'base64url')
    );
    if (!signed) throw new TeamsAuthError(401, 'The token signature is invalid');
    if (claims.iss !== BOT_FRAMEWORK_ISSUER) {
      throw new TeamsAuthError(401, 'The token was not issued by Bot Framework');
    }
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(this.options.appId)) {
      throw new TeamsAuthError(401, 'The token was issued for another app');
    }
    const seconds = this.now() / 1000;
    if (seconds > claims.exp + CLOCK_SKEW) throw new TeamsAuthError(401, 'The token expired');
    if (claims.nbf !== undefined && seconds < claims.nbf - CLOCK_SKEW) {
      throw new TeamsAuthError(401, 'The token is not valid yet');
    }
    const serviceUrl = claims.serviceurl ?? claims.serviceUrl;
    return {
      ...(serviceUrl !== undefined && { serviceUrl }),
      endorsements: signingKey.endorsements,
    };
  }

  /**
   * The signing key of `kid`. Cached keys are used at once, and once they are a day old they are
   * loaded again in the background. Only a cache that is still empty waits for the keys. A key
   * the cache lacks loads them again, at most every five minutes.
   */
  private async keyFor(kid: string): Promise<SigningKey | undefined> {
    if (this.keys.size === 0) await this.refresh();
    else if (this.now() - this.loadedAt > KEYS_MAX_AGE) void this.refresh().catch(() => undefined);
    const known = this.keys.get(kid);
    if (known) return known;
    if (this.now() - this.lastUnknownRefresh < UNKNOWN_KEY_REFRESH) return undefined;
    if (!this.loading && this.now() - this.lastFailure < FAILED_LOAD_BACKOFF) return undefined;
    this.lastUnknownRefresh = this.now();
    await this.refresh().catch(() => undefined);
    return this.keys.get(kid);
  }

  /**
   * Loads the keys once for every caller waiting. After a failure no load is tried for ten
   * seconds, however many requests come, and the keys loaded before stay in use.
   */
  private refresh(): Promise<void> {
    if (this.loading) return this.loading;
    if (this.now() - this.lastFailure < FAILED_LOAD_BACKOFF) {
      return Promise.reject(
        new TeamsAuthError(503, 'The Bot Framework signing keys could not be loaded')
      );
    }
    this.loading = this.load()
      .catch((error: unknown) => {
        this.lastFailure = this.now();
        if (this.keys.size > 0) {
          console.warn('[teams] Could not reload the Bot Framework signing keys:', error);
        }
        throw new TeamsAuthError(503, 'The Bot Framework signing keys could not be loaded', {
          cause: error,
        });
      })
      .finally(() => {
        this.loading = undefined;
      });
    return this.loading;
  }

  private async load(): Promise<void> {
    const metadata = MetadataSchema.parse(await this.json(this.metadataUrl));
    const jwksUrl = new URL(metadata.jwks_uri);
    if (jwksUrl.protocol !== 'https:' && new URL(this.metadataUrl).protocol === 'https:') {
      throw new Error(`The JWKS address ${metadata.jwks_uri} is not https`);
    }
    const jwks = JwksSchema.parse(await this.json(jwksUrl.href));
    const keys = new Map<string, SigningKey>();
    for (const entry of jwks.keys) {
      const jwk = JwkSchema.safeParse(entry);
      if (!jwk.success || jwk.data.kty !== 'RSA' || !jwk.data.kid || !jwk.data.n || !jwk.data.e) {
        continue;
      }
      try {
        const key = createPublicKey({
          key: { kty: 'RSA', n: jwk.data.n, e: jwk.data.e },
          format: 'jwk',
        });
        keys.set(jwk.data.kid, { key, endorsements: jwk.data.endorsements ?? [] });
      } catch {
        continue;
      }
    }
    if (keys.size === 0) throw new Error('The JWKS holds no RSA keys');
    this.keys = keys;
    this.loadedAt = this.now();
  }

  private async json(url: string): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
    return response.json();
  }
}
