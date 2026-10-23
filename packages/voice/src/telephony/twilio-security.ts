import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/** Name of the `<Parameter>` that carries the session token from the TwiML to the stream */
export const TWILIO_SESSION_TOKEN_PARAMETER = 'cogitatorSessionToken';

const DEFAULT_TOKEN_TTL_MS = 60_000;
const DEFAULT_MAX_PENDING_TOKENS = 10_000;

/** Parameters of a Twilio request: one value, or several for a repeated key */
export type TwilioParams = Readonly<Record<string, string | readonly string[]>>;

function equalStrings(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The `X-Twilio-Signature` of a request: base64 HMAC-SHA1, keyed with the account's Auth Token,
 * of the full URL followed by each POST parameter's name and value, sorted by name (the distinct
 * values of a repeated name sorted too, as the Twilio libraries do).
 */
export function twilioSignature(authToken: string, url: string, params: TwilioParams = {}): string {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    const value = params[key]!;
    const values = typeof value === 'string' ? [value] : [...new Set(value)].sort();
    for (const item of values) data += key + item;
  }
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

/** The URL with and without its scheme's default port, the two forms Twilio may sign */
function portVariants(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [url];
  }
  const defaultPort =
    parsed.protocol === 'https:' || parsed.protocol === 'wss:'
      ? '443'
      : parsed.protocol === 'http:' || parsed.protocol === 'ws:'
        ? '80'
        : undefined;
  if (!defaultPort) return [url];
  const host = parsed.hostname.includes(':') ? `[${parsed.hostname}]` : parsed.hostname;
  const rest = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  const auth = parsed.username
    ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@`
    : '';
  const port = parsed.port || defaultPort;
  const withoutPort = `${parsed.protocol}//${auth}${host}${parsed.port && parsed.port !== defaultPort ? `:${parsed.port}` : ''}${rest}`;
  const withPort = `${parsed.protocol}//${auth}${host}:${port}${rest}`;
  return [...new Set([url, withoutPort, withPort])];
}

export interface ValidateTwilioSignatureOptions {
  authToken: string;
  /** The `X-Twilio-Signature` header */
  signature: string | undefined;
  /** The full URL Twilio requested, as configured in Twilio (scheme, host, path and query) */
  url: string;
  /** The POST parameters (form fields) of the request */
  params?: TwilioParams;
}

/**
 * Checks a request's `X-Twilio-Signature`, for the URL with and without its default port. The
 * comparison takes the same time whatever the signature.
 */
export function validateTwilioSignature(options: ValidateTwilioSignatureOptions): boolean {
  const { authToken, signature, url, params } = options;
  if (!authToken || !signature) return false;
  let valid = false;
  for (const variant of portVariants(url)) {
    if (equalStrings(twilioSignature(authToken, variant, params), signature)) valid = true;
  }
  return valid;
}

export interface ValidateTwilioWebhookOptions {
  authToken: string;
  /** The `X-Twilio-Signature` header */
  signature: string | undefined;
  /** The full URL Twilio requested, with its query string */
  url: string;
  /**
   * The raw request body: form-encoded parameters, or a JSON body when the URL carries a
   * `bodySHA256` query parameter
   */
  body: string | Buffer;
}

/**
 * Checks a Twilio webhook, such as the voice webhook that answers with the TwiML of a call: the
 * signature over the URL and the sorted form parameters, or, for a JSON body (the URL has a
 * `bodySHA256` query parameter), the signature over the URL alone and the body's SHA-256.
 */
export function validateTwilioWebhook(options: ValidateTwilioWebhookOptions): boolean {
  const { authToken, signature, url, body } = options;
  let bodyHash: string | null;
  try {
    bodyHash = new URL(url).searchParams.get('bodySHA256');
  } catch {
    return false;
  }
  if (bodyHash !== null) {
    if (!validateTwilioSignature({ authToken, signature, url })) return false;
    const actual = createHash('sha256').update(body).digest('hex');
    return equalStrings(actual, bodyHash.toLowerCase());
  }
  const params: Record<string, string[]> = {};
  for (const [key, value] of new URLSearchParams(body.toString())) {
    (params[key] ??= []).push(value);
  }
  return validateTwilioSignature({ authToken, signature, url, params });
}

export interface VerifyTwilioUpgradeOptions {
  authToken: string;
  /** The `url` of the TwiML `<Stream>`, such as `wss://example.com/twilio`: what Twilio signs */
  streamUrl: string;
}

/**
 * Checks the `X-Twilio-Signature` of a media stream's WebSocket upgrade: Twilio signs the stream
 * URL with no parameters. The URL with and without a trailing slash are both accepted. The
 * signature covers only the URL, so it is the same for every call and can be replayed: it keeps
 * out strangers, and the one-time session token checked on `start` is what ties a stream to a
 * call.
 */
export function verifyTwilioUpgrade(
  req: IncomingMessage,
  options: VerifyTwilioUpgradeOptions
): boolean {
  const header = req.headers['x-twilio-signature'];
  const signature = Array.isArray(header) ? header[0] : header;
  if (!signature) return false;
  const url = options.streamUrl;
  const toggled = url.endsWith('/') ? url.slice(0, -1) : `${url}/`;
  let valid = false;
  for (const variant of [url, toggled]) {
    if (validateTwilioSignature({ authToken: options.authToken, signature, url: variant })) {
      valid = true;
    }
  }
  return valid;
}

/** What `TwilioSessionTokens.consume` returns for a valid token */
export interface TwilioSessionGrant {
  /** What `issue` was given, such as the caller's number from the webhook */
  metadata: Readonly<Record<string, string>>;
  /** The call the token was issued for, when `issue` was given its `CallSid` */
  callSid?: string;
  /** When the token was issued, in ms since the epoch */
  issuedAt: number;
}

export interface TwilioSessionTokensOptions {
  /** How long a token is valid after it is issued, in ms (default 60 000) */
  ttl?: number;
  /** Most tokens waiting to be used at once (default 10 000): `issue` throws beyond it */
  maxPending?: number;
}

export interface TwilioTokenIssueOptions {
  /**
   * The `CallSid` of the webhook request: the token then works only for a stream of that call
   */
  callSid?: string;
  /** Returned with the grant, such as the caller's number */
  metadata?: Record<string, string>;
}

interface PendingToken {
  grant: TwilioSessionGrant;
  expiresAt: number;
}

/**
 * One-time tokens that tie a media stream to the webhook that started it. The voice webhook
 * issues one and passes it to the stream as a `<Parameter>` (`twilioStreamTwiml({ token })`),
 * and the stream is refused unless its `start` event brings a token that was issued, has not
 * expired and was not used before. Tokens live in this process's memory: a deployment that
 * answers the webhook and the stream on different instances checks them in a shared store with
 * `authorize` instead.
 */
export class TwilioSessionTokens {
  private readonly ttl: number;
  private readonly maxPending: number;
  private readonly pending = new Map<string, PendingToken>();

  constructor(options: TwilioSessionTokensOptions = {}) {
    this.ttl = options.ttl ?? DEFAULT_TOKEN_TTL_MS;
    if (!(this.ttl > 0)) throw new RangeError(`ttl must be positive, got ${String(options.ttl)}`);
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING_TOKENS;
    if (!(this.maxPending >= 1)) {
      throw new RangeError(`maxPending must be 1 or more, got ${String(options.maxPending)}`);
    }
  }

  /** Tokens issued and neither used nor expired */
  get size(): number {
    this.sweep(Date.now());
    return this.pending.size;
  }

  /** Issues a token valid for one stream within `ttl`, of the call `callSid` when given */
  issue(options: TwilioTokenIssueOptions = {}): string {
    const now = Date.now();
    this.sweep(now);
    if (this.pending.size >= this.maxPending) {
      throw new Error(`Too many Twilio session tokens waiting to be used (${this.maxPending})`);
    }
    const token = randomBytes(24).toString('base64url');
    this.pending.set(token, {
      grant: {
        metadata: { ...options.metadata },
        issuedAt: now,
        ...(options.callSid !== undefined && { callSid: options.callSid }),
      },
      expiresAt: now + this.ttl,
    });
    return token;
  }

  /**
   * Uses a token: its grant when it is valid, else `undefined`. A token works once, also when it
   * is refused because it was issued for another call than `callSid`
   */
  consume(token: string | undefined, callSid?: string): TwilioSessionGrant | undefined {
    if (!token) return undefined;
    const entry = this.pending.get(token);
    if (!entry) return undefined;
    this.pending.delete(token);
    if (Date.now() >= entry.expiresAt) return undefined;
    if (entry.grant.callSid !== undefined && entry.grant.callSid !== callSid) return undefined;
    return entry.grant;
  }

  private sweep(now: number): void {
    for (const [token, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(token);
    }
  }
}
