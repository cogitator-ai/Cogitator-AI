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

function encodeBase64(input: string, urlSafe: boolean): string {
  const chars = urlSafe ? URL_SAFE_CHARS : STANDARD_CHARS;
  let result = '';
  let i = 0;

  while (i < input.length) {
    const a = input.charCodeAt(i++);
    const b = i < input.length ? input.charCodeAt(i++) : 0;
    const c = i < input.length ? input.charCodeAt(i++) : 0;

    const bitmap = (a << 16) | (b << 8) | c;

    result +=
      chars.charAt((bitmap >> 18) & 63) +
      chars.charAt((bitmap >> 12) & 63) +
      chars.charAt((bitmap >> 6) & 63) +
      chars.charAt(bitmap & 63);
  }

  const padding = input.length % 3;
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

  if (!urlSafe && input.includes('-')) {
    chars = URL_SAFE_CHARS;
    normalized = input;
  }

  normalized = normalized.replace(/[=]/g, '');

  const lookup: Record<string, number> = {};
  for (let i = 0; i < chars.length; i++) {
    lookup[chars[i]] = i;
  }

  let result = '';
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
      result += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }

  return result;
}

export function base64(): number {
  try {
    const inputStr = Host.inputString();
    const input: Base64Input = JSON.parse(inputStr);
    const urlSafe = input.urlSafe ?? false;

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
