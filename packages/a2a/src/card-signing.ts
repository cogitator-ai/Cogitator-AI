import {
  constants,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import type {
  AgentCard,
  AgentCardSigningAlgorithm,
  AgentCardSigningConfig,
  AgentCardSignature,
} from './types.js';
import type { V1AgentCard, V1SecurityScheme } from './v1/types.js';
import { readAgentCard } from './v1/schema.js';
import {
  securityRequirementsFromV1,
  securityRequirementsToV1,
  securitySchemeFromV1,
  securitySchemeToV1,
} from './v1/translate.js';
import { cardModelFromLegacy, toV1Card } from './agent-card.js';
import { normalizeProtocolVersion } from './version.js';

/** A public key as `verifyAgentCardJws` takes it: a `KeyObject`, a JWK, or PEM. */
export type AgentCardPublicKey = KeyObject | JsonWebKey | string;

/** A JSON Web Key Set (RFC 7517, section 5). */
export interface JsonWebKeySet {
  keys: JsonWebKey[];
}

/** How a client finds the key that signed an Agent Card. */
export interface AgentCardVerificationOptions {
  /** Trusted public keys by `kid`, or a JWKS whose keys carry their `kid` */
  keys?: Record<string, AgentCardPublicKey> | JsonWebKeySet;
  /** Looks a key up by the `kid` (and the `jku`) of a signature, when `keys` has none for it */
  resolveKey?: (
    kid: string,
    jku: string | undefined
  ) => AgentCardPublicKey | undefined | Promise<AgentCardPublicKey | undefined>;
  /**
   * Which `jku` URLs the client may fetch a JWKS from when neither `keys` nor `resolveKey` has
   * the key: `'same-origin'` (the default) only the origin the card came from, or a list of
   * trusted origins. A signature whose `jku` is elsewhere is not checked.
   */
  trustJku?: 'same-origin' | readonly string[];
  /** The URL the card was fetched from, the origin `'same-origin'` compares with */
  cardUrl?: string;
  /** The fetch used for a `jku` (default: the global `fetch`) */
  fetch?: typeof fetch;
}

interface AlgorithmSpec {
  /** Key types (`KeyObject.asymmetricKeyType`) the algorithm signs with */
  keyTypes: readonly string[];
  /** The named curve an EC key must be on */
  curve?: string;
  sign(input: Buffer, key: KeyObject): Buffer;
  verify(input: Buffer, key: KeyObject, signature: Buffer): boolean;
}

const ALGORITHMS: Record<AgentCardSigningAlgorithm, AlgorithmSpec> = {
  ES256: {
    keyTypes: ['ec'],
    curve: 'prime256v1',
    sign: (input, key) => sign('sha256', input, { key, dsaEncoding: 'ieee-p1363' }),
    verify: (input, key, signature) =>
      verify('sha256', input, { key, dsaEncoding: 'ieee-p1363' }, signature),
  },
  RS256: {
    keyTypes: ['rsa'],
    sign: (input, key) => sign('sha256', input, key),
    verify: (input, key, signature) => verify('sha256', input, key, signature),
  },
  PS256: {
    keyTypes: ['rsa', 'rsa-pss'],
    sign: (input, key) =>
      sign('sha256', input, {
        key,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
      }),
    verify: (input, key, signature) =>
      verify(
        'sha256',
        input,
        {
          key,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
        },
        signature
      ),
  },
  EdDSA: {
    keyTypes: ['ed25519', 'ed448'],
    sign: (input, key) => sign(null, input, key),
    verify: (input, key, signature) => verify(null, input, key, signature),
  },
};

function isAlgorithm(value: unknown): value is AgentCardSigningAlgorithm {
  return typeof value === 'string' && Object.hasOwn(ALGORITHMS, value);
}

function isKeyObject(value: unknown): value is KeyObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    'asymmetricKeyType' in value &&
    'export' in value &&
    typeof (value as { export: unknown }).export === 'function'
  );
}

function privateKeyObject(key: AgentCardSigningConfig['privateKey']): KeyObject {
  if (isKeyObject(key)) return key;
  if (typeof key === 'string') return createPrivateKey(key);
  return createPrivateKey({ key, format: 'jwk' });
}

function publicKeyObject(key: AgentCardPublicKey): KeyObject {
  if (isKeyObject(key)) return key.type === 'private' ? createPublicKey(key) : key;
  if (typeof key === 'string') return createPublicKey(key);
  return createPublicKey({ key, format: 'jwk' });
}

function assertKeyFits(alg: AgentCardSigningAlgorithm, key: KeyObject): void {
  const spec = ALGORITHMS[alg];
  const type = key.asymmetricKeyType ?? 'unknown';
  if (!spec.keyTypes.includes(type)) {
    throw new Error(
      `Agent Card signing: ${alg} needs a ${spec.keyTypes.join(' or ')} key, got ${type}`
    );
  }
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (spec.curve && curve !== spec.curve) {
    throw new Error(
      `Agent Card signing: ${alg} needs a P-256 key, got curve ${curve ?? 'unknown'}`
    );
  }
}

/**
 * Drops what ProtoJSON leaves out: empty strings, `null`, empty arrays and empty objects, at any
 * depth. `false` and `0` stay.
 */
function dropEmpty(value: unknown): unknown {
  if (value === '' || value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const items = value.map(dropEmpty).filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]): [string, unknown] => [key, dropEmpty(item)])
      .filter(([, item]) => item !== undefined);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
  return value;
}

/** RFC 8785: keys sorted by UTF-16 code units, no whitespace, ECMAScript number and string forms. */
function jcs(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((key) => `${JSON.stringify(key)}:${jcs(record[key])}`)
    .join(',')}}`;
}

/**
 * A card without the proto3 fields at their default that ProtoJSON leaves out: `required: false`
 * of an extension and `pkceRequired: false` of an OAuth flow.
 */
function withoutProtoDefaults(card: V1AgentCard): V1AgentCard {
  const extensions = card.capabilities.extensions?.map(({ required, ...extension }) => ({
    ...extension,
    ...(required && { required }),
  }));
  const schemes = card.securitySchemes
    ? Object.fromEntries(
        Object.entries(card.securitySchemes).map(([name, scheme]): [string, V1SecurityScheme] => {
          if (!('oauth2SecurityScheme' in scheme)) return [name, scheme];
          const { flows } = scheme.oauth2SecurityScheme;
          if (!('authorizationCode' in flows)) return [name, scheme];
          const { pkceRequired, ...flow } = flows.authorizationCode;
          return [
            name,
            {
              oauth2SecurityScheme: {
                ...scheme.oauth2SecurityScheme,
                flows: { authorizationCode: { ...flow, ...(pkceRequired && { pkceRequired }) } },
              },
            },
          ];
        })
      )
    : undefined;
  return {
    ...card,
    capabilities: { ...card.capabilities, ...(extensions && { extensions }) },
    ...(schemes && { securitySchemes: schemes }),
  };
}

function isLegacyCard(card: AgentCard | V1AgentCard): card is AgentCard {
  return 'url' in card || 'protocolVersion' in card;
}

/**
 * The A2A 1.0 form of a card of any version: an A2A 1.0 card read as ProtoJSON reads it, an
 * A2A 0.3 or hybrid card through the card model, so the signature a server copies into its 0.3
 * card checks the same way.
 */
function v1Projection(card: AgentCard | V1AgentCard): V1AgentCard {
  if (isLegacyCard(card)) return toV1Card(cardModelFromLegacy(card));
  return withoutProtoDefaults(readAgentCard(card));
}

/** Two values that are the same once what ProtoJSON leaves out is dropped. */
function sameContent(a: unknown, b: unknown): boolean {
  return jcs(dropEmpty(a) ?? null) === jcs(dropEmpty(b) ?? null);
}

/**
 * Why the A2A 0.3 fields of a card are not covered by a signature over its A2A 1.0 form, or
 * undefined when they are. The signature covers only the 1.0 form, so the 0.3 fields must follow
 * from it: `url` (with `preferredTransport` and `protocolVersion`) and every entry of
 * `additionalInterfaces` must be a 0.3 interface of `supportedInterfaces`, the security schemes and
 * requirements must come back from their 1.0 form unchanged (an OAuth scheme with several flows, or
 * none, does not), and no 0.3 claim without a 1.0 form (`stateTransitionHistory`) may be made.
 */
export function legacyCoverageProblem(card: AgentCard): string | undefined {
  const signed = toV1Card(cardModelFromLegacy(card)).supportedInterfaces.filter((entry) =>
    normalizeProtocolVersion(entry.protocolVersion).startsWith('0.')
  );
  const covered = (url: string, binding: string, version?: string) =>
    signed.some(
      (entry) =>
        entry.url === url &&
        entry.protocolBinding === binding &&
        (version === undefined || normalizeProtocolVersion(entry.protocolVersion) === version)
    );
  const binding = card.preferredTransport ?? 'JSONRPC';
  const version = normalizeProtocolVersion(card.protocolVersion) || '0.3';
  if (!covered(card.url, binding, version)) {
    return `url ${card.url} (${binding} ${version}) is not a 0.3 interface of supportedInterfaces`;
  }
  for (const entry of card.additionalInterfaces ?? []) {
    if (!covered(entry.url, entry.transport)) {
      return `additional interface ${entry.url} (${entry.transport}) is not a 0.3 interface of supportedInterfaces`;
    }
  }
  for (const [name, scheme] of Object.entries(card.securitySchemes ?? {})) {
    const v1 = securitySchemeToV1(scheme);
    if (!v1 || !sameContent(securitySchemeFromV1(v1), scheme)) {
      return `security scheme ${name} has no lossless A2A 1.0 form`;
    }
  }
  const requirements = [
    card.security ?? [],
    ...(card.skills ?? []).map((skill) => skill.security ?? []),
  ];
  for (const security of requirements) {
    if (!sameContent(securityRequirementsFromV1(securityRequirementsToV1(security)), security)) {
      return 'a security requirement has no lossless A2A 1.0 form';
    }
  }
  if (card.capabilities?.stateTransitionHistory) {
    return 'capabilities.stateTransitionHistory has no A2A 1.0 form';
  }
  return undefined;
}

/**
 * The payload an Agent Card signature covers (A2A 1.0, section 8.4.1): the card's A2A 1.0 form
 * without `signatures`, with the fields ProtoJSON leaves out dropped, in JCS (RFC 8785). The
 * same payload the official SDK signs and verifies.
 */
export function canonicalizeAgentCard(card: AgentCard | V1AgentCard): string {
  const { signatures: _signatures, ...unsigned } = v1Projection(card);
  return jcs(dropEmpty(unsigned) ?? {});
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Signs Agent Cards with a private key as A2A 1.0 specifies: a JWS (RFC 7515) with a detached
 * payload, `{ alg, typ: 'JOSE', kid, jku? }` as the protected header, over `canonicalizeAgentCard`.
 * Signatures are kept per payload, so a card that did not change keeps its signature (and its
 * ETag) even with the randomized ECDSA and RSA-PSS signatures.
 */
export class AgentCardSigner {
  private readonly key: KeyObject;
  private readonly protectedHeader: string;
  private readonly cache = new Map<string, AgentCardSignature>();
  private static readonly CACHE_SIZE = 64;

  constructor(private readonly config: AgentCardSigningConfig) {
    if (!isAlgorithm(config.alg)) {
      throw new Error(
        `Agent Card signing: unsupported alg ${String(config.alg)}, use ES256, RS256, PS256 or EdDSA`
      );
    }
    if (!config.kid) throw new Error('Agent Card signing needs a kid');
    this.key = privateKeyObject(config.privateKey);
    if (this.key.type !== 'private') {
      throw new Error('Agent Card signing needs a private key');
    }
    assertKeyFits(config.alg, this.key);
    this.protectedHeader = base64url(
      JSON.stringify({
        alg: config.alg,
        typ: 'JOSE',
        kid: config.kid,
        ...(config.jku && { jku: config.jku }),
      })
    );
  }

  /**
   * The signature of a card (of any version) over its A2A 1.0 form. An A2A 0.3 card whose 0.3
   * fields the 1.0 form does not cover (see `legacyCoverageProblem`) is refused: a signature
   * would leave them open to tampering.
   */
  signature(card: AgentCard | V1AgentCard): AgentCardSignature {
    if (isLegacyCard(card)) {
      const problem = legacyCoverageProblem(card);
      if (problem) {
        throw new Error(
          `Agent Card signing: cannot sign the card of ${card.name}: ${problem}, so a signature over its A2A 1.0 form would not cover it`
        );
      }
    }
    const payload = canonicalizeAgentCard(card);
    const cached = this.cache.get(payload);
    if (cached) return cached;
    const input = Buffer.from(`${this.protectedHeader}.${base64url(payload)}`, 'ascii');
    const signature: AgentCardSignature = {
      protected: this.protectedHeader,
      signature: base64url(ALGORITHMS[this.config.alg].sign(input, this.key)),
    };
    if (this.cache.size >= AgentCardSigner.CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(payload, signature);
    return signature;
  }

  /** The public key as a JWKS, as `/.well-known/jwks.json` serves it. */
  jwks(): JsonWebKeySet {
    const jwk = createPublicKey(this.key).export({ format: 'jwk' });
    return { keys: [{ ...jwk, kid: this.config.kid, alg: this.config.alg, use: 'sig' }] };
  }

  /** Whether the server publishes its JWKS. */
  get publishesJwks(): boolean {
    return this.config.publishJwks === true;
  }
}

interface ProtectedHeader {
  alg?: unknown;
  kid?: unknown;
  jku?: unknown;
}

function decodeHeader(encoded: string): ProtectedHeader | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as ProtectedHeader) : null;
  } catch {
    return null;
  }
}

function isJwks(value: unknown): value is JsonWebKeySet {
  return (
    typeof value === 'object' && value !== null && Array.isArray((value as { keys?: unknown }).keys)
  );
}

function keyFromSet(keys: AgentCardVerificationOptions['keys'], kid: string) {
  if (!keys) return undefined;
  if (isJwks(keys)) return keys.keys.find((entry) => entry.kid === kid);
  return Object.hasOwn(keys, kid) ? keys[kid] : undefined;
}

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function jkuTrusted(jku: string, options: AgentCardVerificationOptions): boolean {
  const origin = originOf(jku);
  if (!origin) return false;
  const trust = options.trustJku ?? 'same-origin';
  if (trust === 'same-origin') return origin === originOf(options.cardUrl);
  return trust.some((entry) => originOf(entry) === origin);
}

async function keyFromJku(
  jku: string,
  kid: string,
  options: AgentCardVerificationOptions
): Promise<AgentCardPublicKey | undefined> {
  const response = await (options.fetch ?? fetch)(jku, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return undefined;
  const body: unknown = await response.json();
  return isJwks(body) ? body.keys.find((entry) => entry.kid === kid) : undefined;
}

/**
 * Whether one of the card's JWS signatures checks out with a key the options trust (A2A 1.0,
 * section 8.4.3): the key of its `kid` from `keys`, `resolveKey`, or the JWKS at its `jku` when
 * `trustJku` allows the URL. Works on A2A 1.0, A2A 0.3 and hybrid cards: the payload is always
 * the card's A2A 1.0 form, and an A2A 0.3 card whose 0.3 fields that form does not cover (see
 * `legacyCoverageProblem`) never verifies. HMAC (`HS256`) signatures are skipped: check those
 * with `verifyAgentCardSignature`.
 */
export async function verifyAgentCardJws(
  card: AgentCard | V1AgentCard,
  options: AgentCardVerificationOptions
): Promise<boolean> {
  const signatures = card.signatures ?? [];
  if (signatures.length === 0) return false;
  if (isLegacyCard(card) && legacyCoverageProblem(card)) return false;
  let payload: string;
  try {
    payload = base64url(canonicalizeAgentCard(card));
  } catch {
    return false;
  }
  for (const entry of signatures) {
    const header = decodeHeader(entry.protected);
    if (!header || !isAlgorithm(header.alg) || typeof header.kid !== 'string') continue;
    const jku = typeof header.jku === 'string' ? header.jku : undefined;
    try {
      const candidate =
        keyFromSet(options.keys, header.kid) ??
        (await options.resolveKey?.(header.kid, jku)) ??
        (jku && jkuTrusted(jku, options) ? await keyFromJku(jku, header.kid, options) : undefined);
      if (!candidate) continue;
      const key = publicKeyObject(candidate);
      assertKeyFits(header.alg, key);
      const input = Buffer.from(`${entry.protected}.${payload}`, 'ascii');
      if (ALGORITHMS[header.alg].verify(input, key, Buffer.from(entry.signature, 'base64url'))) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}
