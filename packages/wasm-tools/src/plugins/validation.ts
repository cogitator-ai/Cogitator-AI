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

const EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const IPV4_REGEX =
  /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;

const IPV6_REGEX =
  /^(?:(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}|:(?::[0-9a-fA-F]{1,4}){1,7}|::(?:[fF]{4}:)?(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)|(?:[0-9a-fA-F]{1,4}:){1,4}:(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?))$/;

function validateEmail(value: string): { valid: boolean; normalized?: string } {
  const trimmed = value.trim().toLowerCase();
  const valid = EMAIL_REGEX.test(trimmed) && trimmed.length <= 254;
  return { valid, normalized: valid ? trimmed : undefined };
}

function validateUrl(value: string): { valid: boolean; normalized?: string } {
  try {
    const trimmed = value.trim();

    const hasProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
    const urlStr = hasProtocol ? trimmed : `https://${trimmed}`;

    const parts = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]+)(.*)$/.exec(urlStr);
    if (!parts) return { valid: false };

    const [, protocol, host] = parts;

    if (!['http', 'https', 'ftp', 'ftps'].includes(protocol.toLowerCase())) {
      return { valid: false };
    }

    const hostParts = host.split(':');
    const hostname = hostParts[0];
    const port = hostParts[1];

    if (port && (!/^\d+$/.test(port) || parseInt(port) > 65535)) {
      return { valid: false };
    }

    if (
      !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(
        hostname
      )
    ) {
      if (!IPV4_REGEX.test(hostname) && !hostname.startsWith('[')) {
        return { valid: false };
      }
    }

    return { valid: true, normalized: urlStr };
  } catch {
    return { valid: false };
  }
}

function validateUuid(value: string): { valid: boolean; normalized?: string } {
  const trimmed = value.trim().toLowerCase();
  const valid = UUID_REGEX.test(trimmed);
  return { valid, normalized: valid ? trimmed : undefined };
}

function validateIpv4(value: string): { valid: boolean; normalized?: string } {
  const trimmed = value.trim();
  const valid = IPV4_REGEX.test(trimmed);

  if (valid) {
    const normalized = trimmed
      .split('.')
      .map((n) => parseInt(n, 10).toString())
      .join('.');
    return { valid: true, normalized };
  }

  return { valid: false };
}

function validateIpv6(value: string): { valid: boolean; normalized?: string } {
  const trimmed = value.trim().toLowerCase();
  const valid = IPV6_REGEX.test(trimmed);
  return { valid, normalized: valid ? trimmed : undefined };
}

export function validate(): number {
  try {
    const inputStr = Host.inputString();
    const input: ValidationInput = JSON.parse(inputStr);

    let result: { valid: boolean; normalized?: string };

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
