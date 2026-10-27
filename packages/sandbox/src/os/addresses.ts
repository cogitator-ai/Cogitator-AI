import { isIP, isIPv4, isIPv6 } from 'node:net';
import { networkInterfaces } from 'node:os';

/**
 * Why an address is one an allowed host name may not resolve to: it reaches this machine or its
 * cloud platform rather than the host the name stands for
 */
export type LocalAddressClass =
  | 'loopback'
  | 'unspecified'
  | 'link-local'
  | 'multicast'
  | 'broadcast'
  | 'cloud metadata'
  | "this host's";

const METADATA_V4 = new Set(['100.100.100.200', '168.63.129.16', '192.0.0.192']);

/** An IPv6 address as its eight 16-bit groups, undefined for text that is not one */
export function ipv6Groups(text: string): number[] | undefined {
  const address = bare(text);
  if (!isIPv6(address)) return undefined;
  let body = address;
  const tail: number[] = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(body);
  if (dotted) {
    const bytes = dotted[1].split('.').map(Number);
    tail.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
    body = body.slice(0, -dotted[1].length);
    if (!body.endsWith('::')) body = body.slice(0, -1);
  }
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((g) => parseInt(g, 16)));
  const double = body.indexOf('::');
  if (double === -1) {
    const all = [...parse(body), ...tail];
    return all.length === 8 ? all : undefined;
  }
  const left = parse(body.slice(0, double));
  const right = [...parse(body.slice(double + 2)), ...tail];
  const missing = 8 - left.length - right.length;
  if (missing < 0) return undefined;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

/** `text` without IPv6 brackets and zone */
function bare(text: string): string {
  return text.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
}

/** The canonical text of an address: IPv4 as it is, IPv6 lowercase and fully compressed by Node */
export function canonicalAddress(text: string): string | undefined {
  const address = bare(text);
  if (isIPv4(address)) return address.split('.').map(Number).join('.');
  const groups = ipv6Groups(address);
  if (!groups) return undefined;
  const embedded = embeddedIPv4(groups);
  if (embedded) return embedded;
  return new URL(`http://[${groups.map((group) => group.toString(16)).join(':')}]/`).hostname
    .slice(1, -1)
    .toLowerCase();
}

/**
 * The IPv4 address an IPv6 address carries, which is judged as that IPv4 address: IPv4-mapped
 * (`::ffff:a.b.c.d`), IPv4-compatible (`::a.b.c.d`), IPv4-translated (`::ffff:0:a.b.c.d`), the
 * NAT64 well-known prefix (`64:ff9b::/96`) and 6to4 (`2002::/16`)
 */
function embeddedIPv4(groups: readonly number[]): string | undefined {
  const v4 = (high: number, low: number) =>
    [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
  const zeros = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0);
  if (zeros(0, 5) && groups[5] === 0xffff) return v4(groups[6], groups[7]);
  if (zeros(0, 4) && groups[4] === 0xffff && groups[5] === 0) return v4(groups[6], groups[7]);
  if (zeros(0, 6) && (groups[6] !== 0 || groups[7] > 1)) return v4(groups[6], groups[7]);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zeros(2, 6)) return v4(groups[6], groups[7]);
  if (groups[0] === 0x2002) return v4(groups[1], groups[2]);
  return undefined;
}

function classifyIPv4(address: string): LocalAddressClass | undefined {
  const [a, b] = address.split('.').map(Number);
  if (a === 127) return 'loopback';
  if (a === 0) return 'unspecified';
  if (a === 169 && b === 254) return 'link-local';
  if (a >= 224 && a <= 239) return 'multicast';
  if (address === '255.255.255.255') return 'broadcast';
  if (METADATA_V4.has(address)) return 'cloud metadata';
  return undefined;
}

function classifyIPv6(groups: readonly number[]): LocalAddressClass | undefined {
  if (groups.every((group) => group === 0)) return 'unspecified';
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return 'loopback';
  if ((groups[0] & 0xffc0) === 0xfe80) return 'link-local';
  if ((groups[0] & 0xff00) === 0xff00) return 'multicast';
  if (groups[0] === 0xfd00 && groups[1] === 0x0ec2) return 'cloud metadata';
  const text = groups.map((group) => group.toString(16)).join(':');
  if (
    ['fd20:ce:0:0:0:0:0:254', 'fd00:c1:0:0:0:0:a9fe:a9fe', 'fd00:42:0:0:0:0:0:42'].includes(text)
  ) {
    return 'cloud metadata';
  }
  return undefined;
}

/** The addresses of this machine's own network interfaces, canonical */
export function ownAddresses(): Set<string> {
  const own = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      const canonical = canonicalAddress(entry.address);
      if (canonical) own.add(canonical);
    }
  }
  return own;
}

/**
 * Why `address` is local (loopback, link-local, this machine's own, a cloud metadata endpoint),
 * undefined for an address elsewhere. An IPv6 address that carries an IPv4 one is judged by it
 */
export function localAddressClass(
  address: string,
  own: ReadonlySet<string> = ownAddresses()
): LocalAddressClass | undefined {
  const canonical = canonicalAddress(address);
  if (!canonical) return undefined;
  if (isIPv4(canonical)) {
    return classifyIPv4(canonical) ?? (own.has(canonical) ? "this host's" : undefined);
  }
  const groups = ipv6Groups(canonical);
  if (!groups) return undefined;
  return classifyIPv6(groups) ?? (own.has(canonical) ? "this host's" : undefined);
}

/** Whether `host` is an IP address (an IPv6 one with or without brackets) */
export function isAddress(host: string): boolean {
  return isIP(bare(host)) !== 0;
}
