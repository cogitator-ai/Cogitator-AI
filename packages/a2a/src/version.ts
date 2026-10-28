import { A2AError, versionNotSupported } from './errors.js';

/** An A2A protocol version a Cogitator server speaks, as `Major.Minor`. */
export type A2AProtocolVersion = '1.0' | '0.3';

/** The protocol versions this package speaks, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly A2AProtocolVersion[] = ['1.0', '0.3'];

/** The header (and query parameter) a client names its protocol version in (A2A 1.0, section 3.6). */
export const A2A_VERSION_HEADER = 'A2A-Version';

/** The media type of the A2A 1.0 HTTP+JSON binding. */
export const A2A_CONTENT_TYPE = 'application/a2a+json';

const VERSION_PATTERN = /^(\d{1,4})\.(\d{1,4})(?:\.\d{1,6})?$/;

/**
 * A requested version as `Major.Minor` (a patch number is ignored, as the specification requires),
 * `''` for none, or the value as it came when it is no version at all.
 */
export function normalizeProtocolVersion(raw: string | null | undefined): string {
  const value = raw?.trim() ?? '';
  const match = VERSION_PATTERN.exec(value);
  return match ? `${Number(match[1])}.${Number(match[2])}` : value;
}

/**
 * The version a request speaks: its `A2A-Version` header, else the `A2A-Version` query parameter,
 * with an empty value standing for 0.3. Throws `VersionNotSupportedError` (-32009) naming the
 * supported versions when the server does not speak it.
 */
export function resolveProtocolVersion(
  raw: string | null | undefined,
  enabled: readonly A2AProtocolVersion[]
): A2AProtocolVersion {
  const normalized = normalizeProtocolVersion(raw) || '0.3';
  const version = enabled.find((candidate) => candidate === normalized);
  if (!version) throw new A2AError(versionNotSupported(normalized, enabled));
  return version;
}

/** The version a request names in its header or query, before negotiation. */
export function requestedProtocolVersion(
  header: (name: string) => string | null | undefined,
  query?: URLSearchParams
): string | undefined {
  const fromHeader = header(A2A_VERSION_HEADER)?.trim();
  if (fromHeader) return fromHeader;
  return query?.get(A2A_VERSION_HEADER)?.trim() || undefined;
}
