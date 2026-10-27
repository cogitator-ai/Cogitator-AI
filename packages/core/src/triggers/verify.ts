/**
 * How the senders of events are checked: API tokens kept as their hash, HMAC signatures over the
 * raw body (generic webhooks, GitHub, Slack, Mailgun) and shared secrets compared in constant time.
 * The GitHub and email channels check their webhooks with the same functions
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { TriggerSecret } from '@cogitator-ai/types';

/**
 * Compares two secrets in constant time for their contents: unequal lengths still run one full
 * comparison (of the expected secret with itself), so only the length of the secret can show
 */
export function secretsEqual(given: string, expected: string): boolean {
  const givenBytes = Buffer.from(given);
  const expectedBytes = Buffer.from(expected);
  const sameLength = givenBytes.length === expectedBytes.length;
  return timingSafeEqual(sameLength ? givenBytes : expectedBytes, expectedBytes) && sameLength;
}

function hexEqual(given: string, expected: string): boolean {
  const a = Buffer.from(given.toLowerCase());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Whether `signature` (`sha256=<hex>`) is the HMAC SHA-256 of `body` with `secret`, as GitHub signs */
export function verifyGitHubSignature(
  body: string | Uint8Array,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  return hexEqual(signature.slice('sha256='.length), expected);
}

/**
 * Whether `signature` is the hex HMAC SHA-256 of `timestamp` and `token` with Mailgun's webhook
 * signing key, as Mailgun signs the requests of its routes (in JSON mode `token` is the body)
 */
export function verifyMailgunSignature(
  timestamp: string,
  token: string | Uint8Array,
  signature: string | undefined,
  signingKey: string
): boolean {
  if (!signature || !/^[0-9a-f]+$/i.test(signature)) return false;
  const expected = createHmac('sha256', signingKey).update(timestamp).update(token).digest('hex');
  return hexEqual(signature, expected);
}

/**
 * Whether `signature` is the hex HMAC of `body` with `secret`, with or without a `sha256=` or
 * `sha512=` before it, as generic webhooks sign
 */
export function verifyHmacSignature(
  body: string | Uint8Array,
  signature: string | undefined,
  secret: string,
  algorithm: 'sha256' | 'sha512' = 'sha256'
): boolean {
  if (!signature) return false;
  const given = signature.trim().replace(/^sha(256|512)=/i, '');
  if (!/^[0-9a-f]+$/i.test(given)) return false;
  const expected = createHmac(algorithm, secret).update(body).digest('hex');
  return hexEqual(given, expected);
}

/** The result of {@link verifySlackSignature} */
export type SlackSignatureCheck =
  { ok: true } | { ok: false; reason: 'missing' | 'stale' | 'mismatch' };

/**
 * Checks a request of Slack's Events API: `X-Slack-Signature` must be `v0=` and the hex HMAC
 * SHA-256 of `v0:<X-Slack-Request-Timestamp>:<raw body>` with the app's signing secret, and the
 * timestamp at most `maxAgeSeconds` (default 300) away from now, against replays
 */
export function verifySlackSignature(
  body: string | Uint8Array,
  timestamp: string | undefined,
  signature: string | undefined,
  signingSecret: string,
  options: { now?: number; maxAgeSeconds?: number } = {}
): SlackSignatureCheck {
  if (!timestamp || !signature?.startsWith('v0=')) return { ok: false, reason: 'missing' };
  const sent = Number(timestamp);
  const now = (options.now ?? Date.now()) / 1000;
  if (!Number.isFinite(sent) || Math.abs(now - sent) > (options.maxAgeSeconds ?? 300)) {
    return { ok: false, reason: 'stale' };
  }
  const expected = createHmac('sha256', signingSecret)
    .update(`v0:${timestamp}:`)
    .update(body)
    .digest('hex');
  return hexEqual(signature.slice(3), expected) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/** The SHA-256 of an API token, hex: what a store keeps instead of the token */
export function hashTriggerToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Whether `token` is the token whose hash is `hash` */
export function triggerTokenMatches(token: string, hash: string): boolean {
  return secretsEqual(hashTriggerToken(token), hash);
}

/** A new API token of a trigger: `cgt_` and 32 random bytes, base64url */
export function generateTriggerToken(): string {
  return `cgt_${randomBytes(32).toString('base64url')}`;
}

/** The value of a secret given in code or by its environment variable, undefined when unset */
export function resolveTriggerSecret(secret: TriggerSecret | undefined): string | undefined {
  if (secret === undefined) return undefined;
  if (typeof secret === 'string') return secret;
  const value = process.env[secret.env];
  return value === undefined || value === '' ? undefined : value;
}
