interface ValidationInput {
  value: string;
  type: 'email' | 'url' | 'uuid' | 'ipv4' | 'ipv6';
}

interface ValidationOutput {
  valid: boolean;
  type: string;
  value: string;
  normalized?: string;
  error?: string;
}

const EMAIL_LOCAL_REGEX = /^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IPV4_OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])';
const IPV4_REGEX = new RegExp(`^(?:${IPV4_OCTET}\\.){3}${IPV4_OCTET}$`);

type ValidationResult = { valid: boolean; normalized?: string };

function isValidHostname(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > 253) return false;
  const labels = hostname.replace(/\.$/, '').split('.');
  return labels.every((label) => DOMAIN_LABEL_REGEX.test(label));
}

function validateEmail(value: string): ValidationResult {
  const trimmed = value.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1 || trimmed.length > 254) return { valid: false };

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (local.length > 64 || !EMAIL_LOCAL_REGEX.test(local)) return { valid: false };
  if (domain.endsWith('.') || !isValidHostname(domain)) return { valid: false };

  return { valid: true, normalized: `${local}@${domain.toLowerCase()}` };
}

function parseIpv6Groups(part: string): number[] | null {
  if (part === '') return [];
  const result: number[] = [];
  for (const group of part.split(':')) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    result.push(parseInt(group, 16));
  }
  return result;
}

function parseIpv6(value: string): number[] | null {
  let address = value;
  let ipv4Tail: number[] = [];

  const lastColon = address.lastIndexOf(':');
  if (lastColon === -1) return null;

  const last = address.slice(lastColon + 1);
  if (last.includes('.')) {
    if (!IPV4_REGEX.test(last)) return null;
    const octets = last.split('.').map((n) => parseInt(n, 10));
    ipv4Tail = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    address = address.slice(0, lastColon + 1);
    if (!address.endsWith('::')) address = address.slice(0, -1);
  }

  const pieces = address.split('::');
  if (pieces.length > 2) return null;

  const target = 8 - ipv4Tail.length;
  if (pieces.length === 2) {
    const head = parseIpv6Groups(pieces[0]);
    const rest = parseIpv6Groups(pieces[1]);
    if (!head || !rest) return null;
    const missing = target - head.length - rest.length;
    if (missing < 1) return null;
    return [...head, ...new Array<number>(missing).fill(0), ...rest, ...ipv4Tail];
  }

  const groups = parseIpv6Groups(address);
  if (groups?.length !== target) return null;
  return [...groups, ...ipv4Tail];
}

function formatIpv6(groups: number[]): string {
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `::ffff:${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  }
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < groups.length;) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < groups.length && groups[j] === 0) j++;
    if (j - i > bestLength && j - i >= 2) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }

  const hex = groups.map((g) => g.toString(16));
  if (bestStart === -1) return hex.join(':');
  const head = hex.slice(0, bestStart).join(':');
  const tail = hex.slice(bestStart + bestLength).join(':');
  return `${head}::${tail}`;
}

function validateIpv6(value: string): ValidationResult {
  const trimmed = value.trim();
  if (trimmed.includes('%')) return { valid: false };
  const groups = parseIpv6(trimmed);
  if (!groups) return { valid: false };
  return { valid: true, normalized: formatIpv6(groups) };
}

function hasWhitespaceOrControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || /\s/.test(value[i])) return true;
  }
  return false;
}

function validateUrl(value: string): ValidationResult {
  const trimmed = value.trim();
  if (hasWhitespaceOrControl(trimmed)) return { valid: false };

  const hasProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
  const urlStr = hasProtocol ? trimmed : `https://${trimmed}`;

  const parts = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^#]*)(#.*)?$/.exec(urlStr);
  if (!parts) return { valid: false };

  const [, protocol, authority, pathAndQuery, fragment = ''] = parts;
  const scheme = protocol.toLowerCase();
  if (!['http', 'https', 'ftp', 'ftps'].includes(scheme)) return { valid: false };

  const at = authority.lastIndexOf('@');
  const userInfo = at === -1 ? '' : authority.slice(0, at + 1);
  const hostPort = at === -1 ? authority : authority.slice(at + 1);

  let host: string;
  let port = '';
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    if (close === -1) return { valid: false };
    const ipv6 = parseIpv6(hostPort.slice(1, close));
    if (!ipv6) return { valid: false };
    host = `[${formatIpv6(ipv6)}]`;
    const after = hostPort.slice(close + 1);
    if (after) {
      if (!after.startsWith(':')) return { valid: false };
      port = after.slice(1);
    }
  } else {
    const colon = hostPort.lastIndexOf(':');
    host = colon === -1 ? hostPort : hostPort.slice(0, colon);
    port = colon === -1 ? '' : hostPort.slice(colon + 1);
    const lowerHost = host.toLowerCase();
    if (!IPV4_REGEX.test(lowerHost) && !isValidHostname(lowerHost)) return { valid: false };
    host = lowerHost;
  }

  if (port && (!/^\d{1,5}$/.test(port) || parseInt(port, 10) > 65535)) {
    return { valid: false };
  }

  const normalized = `${scheme}://${userInfo}${host}${port ? `:${port}` : ''}${pathAndQuery}${fragment}`;
  return { valid: true, normalized };
}

function validateUuid(value: string): ValidationResult {
  const trimmed = value.trim().toLowerCase();
  const valid = UUID_REGEX.test(trimmed);
  return { valid, normalized: valid ? trimmed : undefined };
}

function validateIpv4(value: string): ValidationResult {
  const trimmed = value.trim();
  return IPV4_REGEX.test(trimmed) ? { valid: true, normalized: trimmed } : { valid: false };
}

export function validate(): number {
  try {
    const inputStr = Host.inputString();
    const input: ValidationInput = JSON.parse(inputStr);

    if (typeof input.value !== 'string') {
      throw new Error('value must be a string');
    }
    let result: ValidationResult;

    switch (input.type) {
      case 'email':
        result = validateEmail(input.value);
        break;
      case 'url':
        result = validateUrl(input.value);
        break;
      case 'uuid':
        result = validateUuid(input.value);
        break;
      case 'ipv4':
        result = validateIpv4(input.value);
        break;
      case 'ipv6':
        result = validateIpv6(input.value);
        break;
      default:
        throw new Error(`Unknown validation type: ${input.type}`);
    }

    const output: ValidationOutput = {
      valid: result.valid,
      type: input.type,
      value: input.value,
      normalized: result.normalized,
    };

    Host.outputString(JSON.stringify(output));
    return 0;
  } catch (error) {
    const output: ValidationOutput = {
      valid: false,
      type: 'unknown',
      value: '',
      error: error instanceof Error ? error.message : String(error),
    };
    Host.outputString(JSON.stringify(output));
    return 1;
  }
}

declare const Host: {
  inputString(): string;
  outputString(s: string): void;
};
