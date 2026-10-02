const STANDARD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const URL_SAFE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const REPLACEMENT_CHAR = 0xfffd;

const BASE64_LOOKUP: Record<string, number> = (() => {
  const lookup: Record<string, number> = {};
  for (let i = 0; i < 64; i++) {
    lookup[STANDARD_ALPHABET[i]] = i;
    lookup[URL_SAFE_ALPHABET[i]] = i;
  }
  return lookup;
})();

export function utf8Encode(str: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        code = REPLACEMENT_CHAR;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = REPLACEMENT_CHAR;
    }

    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return new Uint8Array(bytes);
}

export function utf8Decode(bytes: Uint8Array): string {
  let result = '';
  let i = 0;

  const isContinuation = (index: number): boolean =>
    index < bytes.length && (bytes[index] & 0xc0) === 0x80;

  while (i < bytes.length) {
    const b = bytes[i];
    let code = REPLACEMENT_CHAR;
    let size = 1;

    if (b < 0x80) {
      code = b;
    } else if (b >= 0xc2 && b <= 0xdf && isContinuation(i + 1)) {
      code = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f);
      size = 2;
    } else if (b >= 0xe0 && b <= 0xef && isContinuation(i + 1) && isContinuation(i + 2)) {
      const candidate = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
      if (candidate >= 0x800 && (candidate < 0xd800 || candidate > 0xdfff)) {
        code = candidate;
        size = 3;
      }
    } else if (
      b >= 0xf0 &&
      b <= 0xf4 &&
      isContinuation(i + 1) &&
      isContinuation(i + 2) &&
      isContinuation(i + 3)
    ) {
      const candidate =
        ((b & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      if (candidate >= 0x10000 && candidate <= 0x10ffff) {
        code = candidate;
        size = 4;
      }
    }

    result += String.fromCodePoint(code);
    i += size;
  }

  return result;
}

export function base64Encode(bytes: Uint8Array, urlSafe = false): string {
  const alphabet = urlSafe ? URL_SAFE_ALPHABET : STANDARD_ALPHABET;
  let result = '';

  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i];
    const b2 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b3 = i + 2 < bytes.length ? bytes[i + 2] : 0;

    result += alphabet[b1 >> 2];
    result += alphabet[((b1 & 3) << 4) | (b2 >> 4)];
    if (i + 1 < bytes.length) {
      result += alphabet[((b2 & 15) << 2) | (b3 >> 6)];
    } else if (!urlSafe) {
      result += '=';
    }
    if (i + 2 < bytes.length) {
      result += alphabet[b3 & 63];
    } else if (!urlSafe) {
      result += '=';
    }
  }

  return result;
}

export function base64Decode(input: string): Uint8Array {
  const compact = input.replace(/\s+/g, '');
  const unpadded = compact.replace(/={1,2}$/, '');

  if (unpadded.includes('=')) {
    throw new Error('Invalid base64: padding is only allowed at the end');
  }
  if (unpadded.length % 4 === 1) {
    throw new Error('Invalid base64: incorrect length');
  }

  const out = new Uint8Array(Math.floor((unpadded.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;

  for (let i = 0; i < unpadded.length; i++) {
    const value = BASE64_LOOKUP[unpadded[i]];
    if (value === undefined) {
      throw new Error(`Invalid base64 character "${unpadded[i]}" at position ${i}`);
    }
    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 0xff;
    }
  }

  return out;
}

export function hexEncode(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, '0');
  }
  return result;
}

export function hexDecode(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Hex string must have even length');
  }
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('Invalid hex characters');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}
