import {
  secretsEqual as coreSecretsEqual,
  verifyMailgunSignature as coreVerifyMailgunSignature,
} from '@cogitator-ai/core';
import { alignedDomains, headersOf, type EmailHeaders } from './address';

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

/**
 * The text of a header without its comments, in one pass that knows quoted strings and `\`
 * escapes: a `(` inside quotes is text, and an escaped quote does not end them.
 */
function withoutComments(text: string): string {
  let out = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\' && i + 1 < text.length) {
      if (depth === 0) out += char + text[i + 1];
      i++;
      continue;
    }
    if (depth === 0 && char === '"') quoted = !quoted;
    if (!quoted && char === '(') depth++;
    else if (!quoted && char === ')' && depth > 0) depth--;
    else if (depth === 0) out += char;
  }
  return out;
}

/** `text` split at `separator` and at whitespace too when `alsoSpace`, never inside quotes. */
function splitOutsideQuotes(text: string, separator: string, alsoSpace = false): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\' && i + 1 < text.length) {
      current += char + text[++i];
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (!quoted && (char === separator || (alsoSpace && /\s/.test(char)))) {
      if (current) parts.push(current);
      current = '';
    } else current += char;
  }
  if (current) parts.push(current);
  return parts;
}

/** One result of an `Authentication-Results` header: `dkim=pass header.d=example.com`. */
interface AuthResult {
  method: string;
  result: string;
  properties: Map<string, string>;
}

/** The results of a header, its `;`-separated parts read outside quoted strings. */
function authResultsOf(value: string): { authservId: string; results: AuthResult[] } {
  const [id = '', ...segments] = splitOutsideQuotes(withoutComments(value), ';');
  const results: AuthResult[] = [];
  for (const segment of segments) {
    const [first = '', ...rest] = splitOutsideQuotes(segment.trim(), ' ', true);
    const method = /^(dkim|spf|dmarc)=([a-z]+)$/i.exec(first);
    if (!method) continue;
    const properties = new Map<string, string>();
    for (const token of rest) {
      const equals = token.indexOf('=');
      if (equals <= 0) continue;
      const name = token.slice(0, equals).toLowerCase();
      if (!properties.has(name)) properties.set(name, token.slice(equals + 1));
    }
    results.push({ method: method[1].toLowerCase(), result: method[2].toLowerCase(), properties });
  }
  return { authservId: id.trim().split(/\s+/)[0]?.toLowerCase() ?? '', results };
}

/** The domain a property names: of an address (after its last `@`) or the value itself. */
function propertyDomain(result: AuthResult, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = result.properties.get(name);
    if (!value) continue;
    const bare = value.replace(/^"|"$/g, '');
    const at = bare.lastIndexOf('@');
    const domain = (at === -1 ? bare : bare.slice(at + 1)).replace(/^"|"$/g, '').toLowerCase();
    if (domain && !/[\s";]/.test(domain)) return domain;
  }
  return undefined;
}

/**
 * The verdict of one `Authentication-Results` header (RFC 8601) for the author domain
 * `fromDomain`, and its authserv-id. A DMARC result for the `From` domain decides when there is
 * one: DMARC already weighs DKIM and SPF alignment. Otherwise a DKIM or SPF pass for an aligned
 * domain passes, and any definite result (a fail, or a pass for another domain, as a spoofer
 * signing with a domain of its own gets) fails, while `none` or `neutral` say nothing. Parts
 * are split outside quoted strings, so an address like `"a;dkim=pass"@evil.example` stays one
 * value.
 */
export function parseAuthenticationResults(
  value: string,
  fromDomain: string
): { authservId: string; verdict: SenderAuthentication } {
  const { authservId, results } = authResultsOf(value);
  const dmarc = results.find((result) => {
    if (result.method !== 'dmarc') return false;
    const from = propertyDomain(result, 'header.from');
    return !from || alignedDomains(from, fromDomain);
  });
  if (dmarc?.result === 'pass') return { authservId, verdict: 'pass' };
  if (dmarc && DEFINITE.has(dmarc.result)) return { authservId, verdict: 'fail' };
  let reported = false;
  for (const result of results) {
    if (result.method === 'dmarc') continue;
    if (DEFINITE.has(result.result)) reported = true;
    if (result.result !== 'pass') continue;
    const domain =
      result.method === 'dkim'
        ? propertyDomain(result, 'header.d', 'header.i')
        : propertyDomain(result, 'smtp.mailfrom', 'smtp.helo');
    if (domain && alignedDomains(domain, fromDomain)) return { authservId, verdict: 'pass' };
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

/**
 * Compares two secrets in constant time for their contents: unequal lengths still run one full
 * comparison (of the expected secret with itself), so only the length of the secret can show.
 */
export function secretsEqual(given: string, expected: string): boolean {
  return coreSecretsEqual(given, expected);
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
  return coreVerifyMailgunSignature(timestamp, token, signature, signingKey);
}
