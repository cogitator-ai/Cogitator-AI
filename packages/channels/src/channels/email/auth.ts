import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { alignedDomains, domainOf, headersOf, type EmailHeaders } from './address';

/**
 * What the receiving side found about the sender: `pass` when DKIM, SPF or DMARC passed for a
 * domain aligned with the `From` address, `fail` when results were reported and none of them
 * did, `none` when nothing was reported.
 */
export type SenderAuthentication = 'pass' | 'fail' | 'none';

/**
 * Combines the results of one source, such as the methods of one `Authentication-Results`:
 * any pass passes (mail forwarded on breaks SPF but keeps DKIM), else any fail fails.
 */
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

/** Where the sender authentication of a message's headers comes from, and whom to trust. */
export interface HeaderAuthenticationOptions {
  /**
   * `imap`: the `Authentication-Results` of `trustedAuthservIds`. `postmark`: the SpamAssassin
   * `X-Spam-Tests` Postmark adds, whose earlier copies SpamAssassin removes, and the
   * `Authentication-Results` of `trustedAuthservIds`.
   */
  source: 'imap' | 'postmark';
  /** The authserv-ids (the receiving servers) whose `Authentication-Results` count */
  trustedAuthservIds?: readonly string[];
}

/**
 * Combines the verdicts of independent sources: a fail of any of them fails, since one source
 * passing does not undo what another found, then any pass passes.
 */
export function combineSources(...verdicts: readonly SenderAuthentication[]): SenderAuthentication {
  if (verdicts.includes('fail')) return 'fail';
  if (verdicts.includes('pass')) return 'pass';
  return 'none';
}

/**
 * The verdict of Postmark's SpamAssassin tests: `DKIM_VALID_AU` is a valid signature of the
 * author's domain, an SPF fail or an invalid signature fails. More than one `X-Spam-Tests`
 * header fails, since one of them came from the sender.
 */
function spamTestsAuthentication(headers: EmailHeaders): SenderAuthentication {
  const tests = headersOf(headers, 'x-spam-tests');
  if (tests.length > 1) return 'fail';
  if (tests.length === 0) return 'none';
  if (/\bDKIM_VALID_AU\b/.test(tests[0])) return 'pass';
  if (/\b(SPF_FAIL|SPF_SOFTFAIL|DKIM_INVALID)\b/.test(tests[0])) return 'fail';
  return 'none';
}

/**
 * The sender verdict a message's headers carry, for the author domain `fromDomain`. A sender can
 * add any header, so only those the receiving side wrote count: the topmost
 * `Authentication-Results` of one of `trustedAuthservIds` (without them none is trusted), and
 * Postmark's `X-Spam-Tests`. A fail of either source fails.
 */
export function headerAuthentication(
  headers: EmailHeaders,
  fromDomain: string,
  options: HeaderAuthenticationOptions
): SenderAuthentication {
  const verdicts: SenderAuthentication[] = [];
  const trusted = options.trustedAuthservIds?.map((id) => id.toLowerCase()) ?? [];
  if (trusted.length > 0) {
    for (const value of headersOf(headers, 'authentication-results')) {
      const parsed = parseAuthenticationResults(value, fromDomain);
      if (!trusted.includes(parsed.authservId)) continue;
      verdicts.push(parsed.verdict);
      break;
    }
  }
  if (options.source === 'postmark') verdicts.push(spamTestsAuthentication(headers));
  return combineSources(...verdicts);
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
