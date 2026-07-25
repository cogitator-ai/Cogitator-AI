/**
 * Base64 WASM Plugin
 *
 * This file is compiled to WASM using the Extism JS PDK.
 * It provides base64 encoding and decoding functions.
 *
 * Build command:
 *   esbuild src/plugins/base64.ts -o dist/temp/base64.js --bundle --format=cjs --target=es2020
 *   extism-js dist/temp/base64.js -o dist/wasm/base64.wasm
 */

interface Base64Input {
  text: string;
  operation: 'encode' | 'decode';
  urlSafe?: boolean;
}

interface Base64Output {
  result: string;
  operation: string;
  error?: string;
}

const STANDARD_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const URL_SAFE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function stringToUtf8Bytes(str: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
      const c2 = str.charCodeAt(++i);
      c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      bytes.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f)
      );
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return bytes;
}

function utf8BytesToString(bytes: number[]): string {
  let result = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    if (b < 0x80) {
      result += String.fromCharCode(b);
    } else if (b < 0xe0) {
      result += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    } else if (b < 0xf0) {
      result += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)
      );
    } else {
      const cp =
        ((b & 0x07) << 18) |
        ((bytes[i++] & 0x3f) << 12) |
        ((bytes[i++] & 0x3f) << 6) |
        (bytes[i++] & 0x3f);
      result += String.fromCodePoint(cp);
    }
  }
  return result;
}

function encodeBase64(input: string, urlSafe: boolean): string {
  const chars = urlSafe ? URL_SAFE_CHARS : STANDARD_CHARS;
  const inputBytes = stringToUtf8Bytes(input);
  let result = '';
  let i = 0;

  while (i < inputBytes.length) {
    const a = inputBytes[i++];
    const b = i < inputBytes.length ? inputBytes[i++] : 0;
    const c = i < inputBytes.length ? inputBytes[i++] : 0;

    const bitmap = (a << 16) | (b << 8) | c;

    result +=
      chars.charAt((bitmap >> 18) & 63) +
      chars.charAt((bitmap >> 12) & 63) +
      chars.charAt((bitmap >> 6) & 63) +
      chars.charAt(bitmap & 63);
  }

  const padding = inputBytes.length % 3;
  if (padding === 1) {
    result = result.slice(0, -2) + (urlSafe ? '' : '==');
  } else if (padding === 2) {
    result = result.slice(0, -1) + (urlSafe ? '' : '=');
  }

  return result;
}

function decodeBase64(input: string, urlSafe: boolean): string {
  let chars = urlSafe ? URL_SAFE_CHARS : STANDARD_CHARS;
  let normalized = input;

  if (!urlSafe && (input.includes('-') || input.includes('_'))) {
    chars = URL_SAFE_CHARS;
    normalized = input;
  }

  normalized = normalized.replace(/[=]/g, '');

  const lookup: Record<string, number> = {};
  for (let i = 0; i < chars.length; i++) {
    lookup[chars[i]] = i;
  }

  const decodedBytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const char of normalized) {
    const value = lookup[char];
    if (value === undefined) {
      continue;
    }

    buffer = (buffer << 6) | value;
    bits += 6;

    if (bits >= 8) {
      bits -= 8;
      decodedBytes.push((buffer >> bits) & 0xff);
    }
  }

  return utf8BytesToString(decodedBytes);
}

export function base64(): number {
  try {
    const inputStr = Host.inputString();
    const input: Base64Input = JSON.parse(inputStr);
    const urlSafe = input.urlSafe ?? false;

    if (input.operation !== 'encode' && input.operation !== 'decode') {
      throw new Error(`Unknown operation: ${input.operation}`);
    }

    let result: string;
    if (input.operation === 'encode') {
      result = encodeBase64(input.text, urlSafe);
    } else {
      result = decodeBase64(input.text, urlSafe);
    }

    const output: Base64Output = {
      result,
      operation: input.operation,
    };

    Host.outputString(JSON.stringify(output));
    return 0;
  } catch (error) {
    const output: Base64Output = {
      result: '',
      operation: 'unknown',
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
