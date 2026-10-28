import { isIPv4, isIPv6 } from 'node:net';
import { canonicalAddress } from './addresses';

/** One entry of a domain list, read */
export interface DomainPattern {
  /** The entry as written */
  entry: string;
  /**
   * `any` for `*`, `exact` for a host name, `suffix` for `*.name` (its subdomains, not the name
   * itself), `address` for an IP literal
   */
  kind: 'any' | 'exact' | 'suffix' | 'address';
  /** The lowercase host name, the domain after `*.`, or the canonical address */
  host: string;
  /** Only this port, every port when absent */
  port?: number;
}

/** A domain list read for allowing or denying, with the entries that could not be read */
export interface DomainList {
  patterns: DomainPattern[];
  warnings: string[];
}

const LABEL = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;

function validName(name: string): boolean {
  if (name.length === 0 || name.length > 253) return false;
  return name.split('.').every((label) => LABEL.test(label));
}

function portOf(text: string): number | undefined {
  if (!/^\d{1,5}$/.test(text)) return undefined;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : undefined;
}

/** A host part with an optional port read: undefined when it is no host */
function hostPattern(entry: string, host: string, port?: number): DomainPattern | undefined {
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  const withPort = port === undefined ? {} : { port };
  if (name === '*') return { entry, kind: 'any', host: '*', ...withPort };
  if (isIPv4(name)) return { entry, kind: 'address', host: canonicalAddress(name)!, ...withPort };
  if (name.startsWith('*.')) {
    const domain = name.slice(2);
    return validName(domain) ? { entry, kind: 'suffix', host: domain, ...withPort } : undefined;
  }
  return validName(name) ? { entry, kind: 'exact', host: name, ...withPort } : undefined;
}

/**
 * The readings of one entry: a host, `*.domain`, `*`, an IPv4 address or a bracketed IPv6 one,
 * each with an optional `:port`. An unbracketed IPv6 entry whose last group could be a port
 * (`::1:443`) is ambiguous: an allow list takes its host-and-port reading (never more than was
 * written), a deny list every reading
 */
function readingsOf(
  raw: string,
  mode: 'allow' | 'deny'
): { patterns: DomainPattern[]; warning?: string } {
  const entry = raw;
  const text = raw.trim().toLowerCase();
  if (text === '') return { patterns: [], warning: 'an empty domain entry' };
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    const address = close === -1 ? '' : text.slice(1, close);
    const rest = close === -1 ? '' : text.slice(close + 1);
    const port = rest === '' ? undefined : rest.startsWith(':') ? portOf(rest.slice(1)) : -1;
    if (!isIPv6(address) || port === -1 || (rest !== '' && port === undefined)) {
      return { patterns: [], warning: `"${raw}" is not a bracketed IPv6 address with a port` };
    }
    const canonical = canonicalAddress(address)!;
    return {
      patterns: [{ entry, kind: 'address', host: canonical, ...(port && { port }) }],
    };
  }
  const colons = text.split(':').length - 1;
  if (colons === 0) {
    const pattern = hostPattern(entry, text);
    return pattern ? { patterns: [pattern] } : { patterns: [], warning: `"${raw}" is no host` };
  }
  if (colons === 1) {
    const [host, portText] = text.split(':');
    const port = portOf(portText);
    const pattern = port === undefined ? undefined : hostPattern(entry, host, port);
    return pattern
      ? { patterns: [pattern] }
      : { patterns: [], warning: `"${raw}" is no host with a port` };
  }
  const whole = isIPv6(text) ? canonicalAddress(text) : undefined;
  const cut = text.lastIndexOf(':');
  const prefix = text.slice(0, cut);
  const port = portOf(text.slice(cut + 1));
  const split =
    port !== undefined && isIPv6(prefix) ? { address: canonicalAddress(prefix)!, port } : undefined;
  if (whole && !split) return { patterns: [{ entry, kind: 'address', host: whole }] };
  if (split && !whole) {
    return { patterns: [{ entry, kind: 'address', host: split.address, port: split.port }] };
  }
  if (whole && split) {
    const warning = `"${raw}" is ambiguous between an address and an address with a port, write it bracketed (${mode === 'allow' ? `read as [${prefix}]:${split.port}` : 'both readings denied'})`;
    const host = { entry, kind: 'address' as const, host: split.address, port: split.port };
    return mode === 'allow'
      ? { patterns: [host], warning }
      : { patterns: [host, { entry, kind: 'address', host: whole }], warning };
  }
  return { patterns: [], warning: `"${raw}" is no host` };
}

/** Reads a list of domain entries; entries that cannot be read are left out with a warning */
export function parseDomainList(entries: readonly string[], mode: 'allow' | 'deny'): DomainList {
  const patterns: DomainPattern[] = [];
  const warnings: string[] = [];
  for (const entry of entries) {
    const read = readingsOf(entry, mode);
    patterns.push(...read.patterns);
    if (read.warning)
      warnings.push(`${mode === 'allow' ? 'allowedDomains' : 'deniedDomains'}: ${read.warning}`);
  }
  return { patterns, warnings };
}

/** `host` as patterns compare it: lowercase, without a trailing dot, an address canonical */
export function normalizeHost(host: string): string {
  const lower = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  const name = lower.endsWith('.') ? lower.slice(0, -1) : lower;
  return canonicalAddress(name) ?? name;
}

/** Whether `pattern` names `host` (normalized) on `port` */
export function domainMatches(pattern: DomainPattern, host: string, port: number): boolean {
  if (pattern.port !== undefined && pattern.port !== port) return false;
  switch (pattern.kind) {
    case 'any':
      return true;
    case 'exact':
    case 'address':
      return host === pattern.host;
    case 'suffix':
      return host.endsWith(`.${pattern.host}`);
  }
}

/** The first pattern of `list` that names `host` on `port` */
export function firstMatch(
  list: readonly DomainPattern[],
  host: string,
  port: number
): DomainPattern | undefined {
  return list.find((pattern) => domainMatches(pattern, host, port));
}
