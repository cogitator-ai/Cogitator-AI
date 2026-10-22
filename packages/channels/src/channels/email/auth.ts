import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { alignedDomains, domainOf, headersOf, type EmailHeaders } from './address';

/**
 * What the receiving side found about the sender: `pass` when DKIM, SPF or DMARC passed for a
 * domain aligned with the `From` address, `fail` when results were reported and none of them
 * did, `none` when nothing was reported.
 */
export type SenderAuthentication = 'pass' | 'fail' | 'none';

/** Combines the verdicts of several sources: any pass passes, else any fail fails. */
export function combineAuthentication(
  ...verdicts: readonly SenderAuthentication[]
): SenderAuthentication {
  if (verdicts.includes('pass')) return 'pass';
  if (verdicts.includes('fail')) return 'fail';
  return 'none';
}

/** Results that say something about the sender, unlike `none`, `neutral` or `temperror`. */
const DEFINITE = new Set(['pass', 'fail', 'softfail', 'permerror', 'hardfail']);

function withoutComments(text: string): string {
  let out = '';
  let depth = 0;
  let quoted = false;
  for (const char of text) {
    if (char === '"' && depth === 0) quoted = !quoted;
    if (!quoted && char === '(') depth++;
    else if (!quoted && char === ')' && depth > 0) depth--;
    else if (depth === 0) out += char;
  }
  return out;
}

function propertyDomain(segment: string, ...names: string[]): string | undefined {
  for (const name of names) {
    const match = new RegExp(`(?:^|\\s)${name.replace('.', '\\.')}=("?)([^\\s";]+)\\1`, 'i').exec(
      segment
    );
    if (match) return domainOf(match[2].includes('@') ? match[2] : `x@${match[2]}`);
  }
  return undefined;
}

/**
 * The verdict of one `Authentication-Results` header (RFC 8601) for the author domain
 * `fromDomain`, and its authserv-id. A DKIM, SPF or DMARC pass for an aligned domain passes.
 * Otherwise any definite result (a fail, or a pass for another domain, as a spoofer signing
 * with a domain of its own gets) fails, and results of `none` or `neutral` only say nothing.
 */
export function parseAuthenticationResults(
  value: string,
  fromDomain: string
): { authservId: string; verdict: SenderAuthentication } {
  const [id = '', ...segments] = withoutComments(value).split(';');
  const authservId = id.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  let reported = false;
  for (const raw of segments) {
    const segment = raw.trim();
    const method = /^(dkim|spf|dmarc)\s*=\s*([a-z]+)/i.exec(segment);
    if (!method) continue;
    const result = method[2].toLowerCase();
    if (DEFINITE.has(result)) reported = true;
    if (result !== 'pass') continue;
    const kind = method[1].toLowerCase();
    if (kind === 'dmarc') {
      const from = propertyDomain(segment, 'header.from');
      if (!from || alignedDomains(from, fromDomain)) return { authservId, verdict: 'pass' };
    } else if (kind === 'dkim') {
      const signer = propertyDomain(segment, 'header.d', 'header.i');
      if (signer && alignedDomains(signer, fromDomain)) return { authservId, verdict: 'pass' };
    } else {
      const sender = propertyDomain(segment, 'smtp.mailfrom', 'smtp.helo');
      if (sender && alignedDomains(sender, fromDomain)) return { authservId, verdict: 'pass' };
    }
  }
  return { authservId, verdict: reported ? 'fail' : 'none' };
}

/**
 * The sender verdict a message's own headers carry, for the author domain `fromDomain`: the
 * topmost `Authentication-Results` (or the topmost from one of `trustedAuthservIds`, when set),
 * the topmost `Received-SPF` and the SpamAssassin `X-Spam-Tests` Postmark adds. Only the topmost
 * header of each kind counts, since the receiving server adds its own on top and anything below
 * may come from the sender.
 */
export function headerAuthentication(
  headers: EmailHeaders,
  fromDomain: string,
  trustedAuthservIds?: readonly string[]
): SenderAuthentication {
  const verdicts: SenderAuthentication[] = [];
  const trusted = trustedAuthservIds?.map((id) => id.toLowerCase());
  for (const value of headersOf(headers, 'authentication-results')) {
    const parsed = parseAuthenticationResults(value, fromDomain);
    if (trusted && trusted.length > 0 && !trusted.includes(parsed.authservId)) continue;
    verdicts.push(parsed.verdict);
    break;
  }
  if (!trusted?.length) {
    const spf = headersOf(headers, 'received-spf')[0];
    if (spf) {
      const result = /^\s*([a-z]+)/i.exec(spf)?.[1]?.toLowerCase();
      const sender = propertyDomain(withoutComments(spf), 'envelope-from', 'smtp.mailfrom');
      if (result === 'pass' && sender && alignedDomains(sender, fromDomain)) verdicts.push('pass');
      else if (result && DEFINITE.has(result)) verdicts.push('fail');
    }
    const tests = headersOf(headers, 'x-spam-tests')[0];
    if (tests && /\bDKIM_VALID_AU\b/.test(tests)) verdicts.push('pass');
  }
  return combineAuthentication(...verdicts);
}

/** Compares two secrets in constant time, whatever their lengths. */
export function secretsEqual(given: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * Whether `signature` is the hex HMAC SHA-256 of `timestamp` and `token` with Mailgun's webhook
 * signing key, as Mailgun signs the requests of its routes (in JSON mode `token` is the body).
 */
export function verifyMailgunSignature(
  timestamp: string,
  token: string | Uint8Array,
  signature: string | undefined,
  signingKey: string
): boolean {
  if (!signature || !/^[0-9a-f]+$/i.test(signature)) return false;
  const expected = Buffer.from(
    createHmac('sha256', signingKey).update(timestamp).update(token).digest('hex')
  );
  const given = Buffer.from(signature.toLowerCase());
  return given.length === expected.length && timingSafeEqual(given, expected);
}
